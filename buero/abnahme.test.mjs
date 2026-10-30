import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtempSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runAbnahme,kositFromReport,inspectXml} from './abnahme.mjs';
import {escrowTxs,decodeResultHash} from './escrow.mjs';
import {createBuero} from './sokosumi.mjs';
import {USDM} from '../paid-task.mjs';
import {inputHashFor,resultHash,buildResult} from '../rechnungsmeister/mip004.mjs';
import {sha256} from '../standard-hash.mjs';
import {parseFixed} from '../einvoice/parse-fixed.mjs';
import {buildXml} from '../einvoice/build.mjs';
import {XRECHNUNG_UBL_SCENARIO} from '../verifier/kosit.mjs';
import {loadProfile} from '../verifier/profile.mjs';

const fields=parseFixed(readFileSync(new URL('../fixtures/b-abschlag-13b-bau-isar.fixed.txt',import.meta.url),'utf8'));
const goodXml=await buildXml(fields);
const badXml=await buildXml({...fields,buyerVatId:null});
const {profileHash}=loadProfile('bau-isar');
const MIN=60000;
const TOKEN='ab'.repeat(32);

// A fake MPS + RechnungsMeister on one simulated chain and clock (every sleep advances it by one poll). Every getPurchase
// is one "block": queued actions land. Like rechnungsmeister/server.mjs, the seller authorizes the refund itself when it
// rejects a cure or has no cure left. Options are hooks on the world `w`, so a test can switch failures on and off.
function world({firstDefective=true,firstXml=null,firstResult=null,cure='ok',cheat=false,statusFails=()=>false,inspectFails=()=>false,mpsDownPolls=0,manualPolls=0,
 refundLands=true,authorizeLands=true,deliverAt=null,visibleAt=null,lateAt=null,rotateBeforeAccept=false,rotateAfterUnlock=false,quote={},startJob429=0,disputeMode=null,chainResultHash=null}={}){
 const calls=[],times={},tokens=[];let p=null,nonce,result,attempt=0,refund=false,refunded=false,silent=false,phase='result-confirmed';
 const clock={t:Date.now()},t0=clock.t;
 const call=name=>{calls.push(name);times[name]??=clock.t;};
 const tx=(prev,next)=>{p.CurrentTransaction={txHash:sha256(`${prev}>${next}>${calls.length}>${clock.t}`),status:'Confirmed',previousOnChainState:prev,newOnChainState:next};p.TransactionHistory.push(p.CurrentTransaction);p.onChainState=next;};
 const deliver=(xml,raw)=>{attempt++;result=raw?.(nonce)??buildResult({xml,kosit:{accepted:true,scenario:XRECHNUNG_UBL_SCENARIO},profileHash,attempt}).result;const h=resultHash(result,nonce);p.resultHash=cheat?sha256(`CHEAT;${h}`):h;};
 const job={id:'7d1c2a7e-0000-4000-8000-000000000001',job_id:'7d1c2a7e-0000-4000-8000-000000000001',blockchainIdentifier:'bcid-1',agentIdentifier:'agent',sellerVKey:'vk',smartContractAddress:'addr_test1contract',supportedPaymentSourceIndex:0,
  amounts:[{amount:'1000000',unit:USDM}],payByTime:t0+10*MIN,submitResultTime:t0+25*MIN,unlockTime:t0+45*MIN,externalDisputeUnlockTime:t0+65*MIN,...quote};
 const w={calls,times,tokens,clock,job,state:()=>p};
 const rm={
  async startJob(body){call('start_job');if(startJob429-->0)return {httpStatus:429,body:{error:'Too many new jobs, retry later'}};nonce=body.identifier_from_purchaser;return {httpStatus:200,body:{...job,input_hash:inputHashFor(body.input_data,nonce),job_token:TOKEN}};},
  async status(jobId,token){call('status');tokens.push(['status',token]);if(statusFails(w))return {httpStatus:500,body:{error:'Request failed'}};return {httpStatus:200,body:{status:'completed',phase,result}};},
  async dispute(body,token){
   call(`dispute#${body.round}`);tokens.push(['dispute',token]);
   if(disputeMode==='409')return {httpStatus:409,body:{error:'Dispute outcome requires inspection'}};
   if(disputeMode==='401once'){disputeMode=null;return {httpStatus:401,body:{error:'Missing or wrong job token'}};}
   const refuse=(httpStatus,body)=>{if(!refunded){refunded=refund=true;phase='refund-authorized';}return {httpStatus,body};};
   if(refunded||attempt>=2||silent)return refuse(200,{status:'refund-authorized',reasons:['Nachbesserung ausgeschöpft.']});
   if(cure==='reject')return refuse(422,{status:'cure-rejected',reasons:['Mangel nicht heilbar.']});
   if(cure==='silent'){silent=true;return {httpStatus:200,body:{status:'cure-submitted',attempt:attempt+1,patch:{},sources:{}}};}  // announces a cure, never submits it
   deliver(goodXml);tx('Disputed','Disputed');
   return {httpStatus:200,body:{status:'cure-submitted',attempt,patch:{buyerVatId:'DE287654321'},sources:{buyerVatId:'input_data.invoiceText'}}};
  },
 };
 const escrow={
  async purchase(j,{inputHash}){call('purchase');assert.equal(inputHash,inputHashFor({invoiceText:'x',recipientProfileId:'bau-isar',expectedTotal:'18400.00',acceptanceProfileHash:profileHash},nonce));
   p={id:'purchase-1',onChainState:null,resultHash:null,NextAction:{requestedAction:'FundsLockingRequested'},TransactionHistory:[],PaymentSource:{smartContractAddress:j.smartContractAddress}};return p;},
  async getPurchase(){
   if(!p)return null;
   if(p.onChainState==='FundsLocked'&&mpsDownPolls>0){mpsDownPolls--;throw new Error('fetch failed (ECONNREFUSED 127.0.0.1:3001)');}
   const a=p.NextAction.requestedAction,done=()=>{p.NextAction={requestedAction:'WaitingForExternalAction'};};
   if(a==='FundsLockingRequested'){done();tx(null,'FundsLocked');}
   else if(p.onChainState==='FundsLocked'){if(!deliverAt||clock.t>=deliverAt(job)){deliver(firstDefective?badXml:firstXml??goodXml,firstResult);tx('FundsLocked','ResultSubmitted');if(lateAt)clock.t=lateAt(job);}}
   else if(a==='SetRefundRequestedRequested'){if(refundLands){done();tx('ResultSubmitted','Disputed');}}
   else if(a==='AuthorizeWithdrawalRequested'){if(authorizeLands){done();p.authorizedHash=p.resultHash;tx('Disputed','WithdrawAuthorized');}}
   else if(refund&&p.onChainState==='Disputed'){refund=false;tx('Disputed','RefundAuthorized');}
   else if(p.onChainState==='WithdrawAuthorized')tx('WithdrawAuthorized','Withdrawn');
   else if(p.onChainState==='ResultSubmitted'&&rotateAfterUnlock&&clock.t>=job.unlockTime+5*MIN&&!p.rotated){p.rotated=true;deliver(badXml);}
   else if(p.onChainState==='ResultSubmitted'&&clock.t>=job.unlockTime+10*MIN)tx('ResultSubmitted','Withdrawn');  // MPS auto-withdraw for the seller
   const view=structuredClone(p);
   if(visibleAt&&clock.t<visibleAt(job)&&p.onChainState==='ResultSubmitted')Object.assign(view,{onChainState:'FundsLocked',resultHash:null,CurrentTransaction:p.TransactionHistory[0]});  // stale MPS row
   if(manualPolls>0&&p.onChainState==='ResultSubmitted'&&calls.includes('inspect')){manualPolls--;view.NextAction={requestedAction:'WaitingForManualAction',errorNote:'SetRefundRequested could not be built'};}
   return view;
  },
  async getPayment(){return null;},
  async requestRefund(){call('request-refund');assert.equal(p.onChainState,'ResultSubmitted');p.NextAction={requestedAction:'SetRefundRequestedRequested'};},
  async cancelRefundRequest(){call('cancel-refund-request');assert.equal(p.onChainState,'Disputed');p.NextAction={requestedAction:'AuthorizeWithdrawalRequested'};},
  async chainResultHash(...a){return chainResultHash?chainResultHash(w,...a):null;},
 };
 const inspect=async xml=>{call('inspect');
  if(inspectFails(w))throw new Error('KoSIT-Prüfdienst nicht verfügbar (HTTP 503); die Rechnung wurde nicht beurteilt.');
  const ok=xml.includes('DE287654321');
  // The seller re-submits from Disputed right after the buyer inspected the cure, before AuthorizeWithdrawal is built.
  if(rotateBeforeAccept&&ok&&attempt===2&&!p.rotated){p.rotated=true;deliver(badXml);tx('Disputed','Disputed');}
  return {mode:'x402',txHash:sha256(`x402-${calls.length}`),kosit:{accepted:ok,httpStatus:ok?200:406,scenario:XRECHNUNG_UBL_SCENARIO,messages:ok?[]:[{level:'error',code:'BR-AE-02',text:'[BR-AE-02] …'}],reportXml:'<rep/>'}};};
 return Object.assign(w,{rm,escrow,inspect,now:()=>clock.t,sleep:async ms=>{clock.t+=Math.max(ms,10000);}});
}

const run=(w,dir,extra={})=>runAbnahme({invoiceText:'x',recipientProfileId:'bau-isar',expectedTotal:'18400.00',...extra},{rm:w.rm,escrow:w.escrow,inspect:w.inspect,now:w.now,sleep:w.sleep,journalDir:dir,pollMs:10000,...w.deps});
const tmp=()=>mkdtempSync(join(tmpdir(),'abnahme-'));
const count=(w,name)=>w.calls.filter(c=>c===name).length;
const journal=(dir,id)=>JSON.parse(readFileSync(join(dir,`${id}.json`),'utf8'));
const onlyJournal=dir=>{const files=readdirSync(dir).filter(f=>f.endsWith('.json'));assert.equal(files.length,1);return JSON.parse(readFileSync(join(dir,files[0]),'utf8'));};

test('defect -> dispute -> cure -> AuthorizeWithdrawal -> Withdrawn is ACCEPTED',async()=>{
 const w=world(),dir=tmp();const lines=[];
 try{
  const r=await run(w,dir,{onProgress:l=>lines.push(l)});
  assert.equal(r.status,'ACCEPTED');
  assert.deepEqual(w.calls.filter(c=>c!=='status'),['start_job','purchase','inspect','request-refund','dispute#1','inspect','cancel-refund-request']);
  assert.equal(w.state().onChainState,'Withdrawn');
  assert.deepEqual(r.txs.map(t=>t.label),['FundsLocked','ResultSubmitted','Disputed','ResultSubmitted (cure)','AuthorizeWithdrawal','Withdrawn','x402 inspection 1','x402 inspection 2']);
  assert.match(r.protocolDe,/BR-AE-02/);assert.match(r.xml,/DE287654321/);
  assert.ok(lines.length>8);
 }finally{rmSync(dir,{recursive:true})}
});

test('a first delivery that passes is ACCEPTED without any dispute (deemed acceptance)',async()=>{
 const w=world({firstDefective:false}),dir=tmp();
 try{
  const r=await run(w,dir);
  assert.equal(r.status,'ACCEPTED');
  assert.ok(!w.calls.includes('request-refund')&&!w.calls.includes('cancel-refund-request'));
  assert.equal(w.state().onChainState,'ResultSubmitted');
 }finally{rmSync(dir,{recursive:true})}
});

test('ESCROW-3: an uncurable defect is REFUSED, never released to the seller, and the refund is followed until it is on chain',async()=>{
 const w=world({cure:'reject'}),dir=tmp();
 try{
  const r=await run(w,dir);
  assert.equal(r.status,'REFUSED');
  assert.ok(!w.calls.includes('cancel-refund-request'));
  assert.equal(w.state().onChainState,'RefundAuthorized');
  assert.match(r.protocolDe,/RefundAuthorized/);
 }finally{rmSync(dir,{recursive:true})}
});

test('a hash that does not match the delivered bytes is disputed and REFUSED (CHEAT)',async()=>{
 const w=world({firstDefective:false,cheat:true}),dir=tmp();
 try{
  const r=await run(w,dir);
  assert.equal(r.status,'REFUSED');
  assert.deepEqual(w.calls.filter(c=>c!=='status'),['start_job','purchase','inspect','request-refund','dispute#1','inspect','dispute#2']);
  assert.match(r.protocolDe,/ABN-HASH/);
  assert.ok(!w.calls.includes('cancel-refund-request'));
 }finally{rmSync(dir,{recursive:true})}
});

test('a crash after the dispute resumes from the journal without buying or disputing twice',async()=>{
 const w=world(),dir=tmp();
 class Crash extends Error{}
 try{
  w.deps={sleep:async()=>{if(w.calls.includes('dispute#1'))throw new Crash('power cut');}};
  // wait-result after the cure needs no sleep in this fake, so crash on the accept stage instead:
  const realCancel=w.escrow.cancelRefundRequest;let crashed=false;
  w.escrow.cancelRefundRequest=async(...a)=>{if(!crashed){crashed=true;throw new Crash('power cut');}return realCancel(...a);};
  await assert.rejects(run(w,dir),Crash);
  const journals=readdirSync(dir).filter(f=>f.endsWith('.json'));
  assert.equal(journals.length,1);
  assert.equal(JSON.parse(readFileSync(join(dir,journals[0]),'utf8')).stage,'accept');
  delete w.deps;
  const r=await run(w,dir);
  assert.equal(r.status,'ACCEPTED');
  assert.deepEqual(w.calls.filter(c=>['start_job','purchase','request-refund','dispute#1','cancel-refund-request'].includes(c)),['start_job','purchase','request-refund','dispute#1','cancel-refund-request']);
  assert.match(r.protocolDe,/Fortsetzung/);
 }finally{rmSync(dir,{recursive:true})}
});

// ---------- fail-open exits (ESCROW-1, STATEMACHINE-3, LIVE-2) ----------

test('ESCROW-1: a seller answering /status with HTTP 500 gets a protective Mängelrüge by unlockTime - 15 min; once it delivers, the buyer inspects and releases',async()=>{
 const w=world({firstDefective:false,statusFails:w=>!w.calls.includes('request-refund')}),dir=tmp();
 try{
  const r=await run(w,dir);
  assert.ok(w.times['request-refund']<=w.job.unlockTime-15*MIN+10000,'the protective dispute is filed by the decision deadline');
  assert.equal(r.status,'ACCEPTED');
  assert.ok(w.calls.includes('cancel-refund-request'),'the passed inspection releases the money with AuthorizeWithdrawal');
  assert.equal(w.state().onChainState,'Withdrawn');
  assert.match(r.protocolDe,/ABN-LIEFERUNG/);
 }finally{rmSync(dir,{recursive:true})}
});

test('ESCROW-1: an inspector that keeps failing (KoSIT 5xx) is no deemed acceptance; after the protective dispute the defect is cured and accepted',async()=>{
 const w=world({inspectFails:w=>!w.calls.includes('request-refund')}),dir=tmp();
 try{
  const r=await run(w,dir);
  assert.ok(w.times['request-refund']<=w.job.unlockTime-15*MIN+10000);
  assert.equal(r.status,'ACCEPTED');
  assert.deepEqual(w.calls.filter(c=>['request-refund','dispute#1','cancel-refund-request'].includes(c)),['request-refund','dispute#1','cancel-refund-request']);
  assert.match(r.protocolDe,/ABN-PRUEFUNG/);
 }finally{rmSync(dir,{recursive:true})}
});

test('STATEMACHINE-3: 13 polls of MPS outage after FundsLocked do not give up the veto; the defect is still disputed',async()=>{
 const w=world({mpsDownPolls:13}),dir=tmp();
 try{
  const r=await run(w,dir);
  assert.equal(r.status,'ACCEPTED');
  assert.ok(w.calls.includes('request-refund'));
 }finally{rmSync(dir,{recursive:true})}
});

test('STATEMACHINE-3: a result MPS shows only after submitResultTime + 4 min is still inspected and disputed, not FAILED as "no result"',async()=>{
 const w=world({deliverAt:job=>job.submitResultTime-MIN,visibleAt:job=>job.submitResultTime+4*MIN}),dir=tmp();
 try{
  const r=await run(w,dir);
  assert.ok(w.calls.includes('request-refund'));
  assert.equal(r.status,'ACCEPTED');
  assert.doesNotMatch(r.protocolDe,/erstattet das Geld automatisch/);
 }finally{rmSync(dir,{recursive:true})}
});

test('ESCROW-1: MPS WaitingForManualAction raises an alarm and is waited out, not ended FAILED while the escrow pays the seller',async()=>{
 const w=world({manualPolls:5}),dir=tmp();
 try{
  const r=await run(w,dir);
  assert.equal(r.status,'ACCEPTED');
  assert.ok(w.calls.includes('request-refund'));
  assert.match(r.protocolDe,/ALARM: MPS verlangt manuelles Eingreifen/);
 }finally{rmSync(dir,{recursive:true})}
});

test('LIVE-2: no refund request is sent within 5 min of unlockTime, where MPS would accept it silently and never build it',async()=>{
 const w=world({lateAt:job=>job.unlockTime-4.5*MIN}),dir=tmp();
 try{
  const r=await run(w,dir);
  assert.ok(!w.calls.includes('request-refund'));
  assert.equal(r.status,'FAILED');
  assert.match(r.protocolDe,/ohne Abnahme/);
 }finally{rmSync(dir,{recursive:true})}
});

test('LIVE-2: a refund request MPS never builds raises an alarm before unlockTime, and the outcome says the seller is paid without acceptance',async()=>{
 const w=world({refundLands:false}),dir=tmp();
 try{
  const r=await run(w,dir);
  assert.equal(r.status,'FAILED');
  const alarm=journal(dir,r.journalId).log.find(l=>/ALARM/.test(l.line));
  assert.ok(alarm&&Date.parse(alarm.at)<w.job.unlockTime,'alarm before unlockTime');
  assert.match(r.protocolDe,/ohne Abnahme/);
 }finally{rmSync(dir,{recursive:true})}
});

test('ESCROW-1: a defect found after the dispute window never tells Frau Berger "keine Kosten" while the seller is paid',async()=>{
 const w=world({lateAt:job=>job.unlockTime-3.5*MIN}),dir=tmp(),store=tmp();
 try{
  const buero=createBuero({runAbnahme:args=>run(w,dir,args),dir:store});
  const text=await buero.pruefen({taskId:'t1',input:'PRÜFEN\nEmpfänger: bau-isar\nBetrag: 18.400,00\nx'}).then(t=>t,e=>e.message);
  assert.doesNotMatch(text,/keine Kosten/);
  assert.match(text,/ohne Abnahme/);
  assert.equal(w.state().onChainState,'ResultSubmitted');
 }finally{rmSync(dir,{recursive:true});rmSync(store,{recursive:true})}
});

// ---------- one PRÜFEN, one purchase (STATEMACHINE-1, -6) ----------

test('STATEMACHINE-1: a rerun of an ACCEPTED job (worker died before the Task saved the result) answers from the journal and buys nothing',async()=>{
 const w=world({firstDefective:false}),dir=tmp();
 try{
  const first=await run(w,dir),again=await run(w,dir);
  assert.equal(again.status,'ACCEPTED');
  assert.equal(again.journalId,first.journalId);
  assert.equal(count(w,'purchase'),1);
  assert.equal(again.xml,first.xml);
 }finally{rmSync(dir,{recursive:true})}
});

test('STATEMACHINE-1: an AuthorizeWithdrawal that MPS defers past 25 min ends ACCEPTED (the buyer accepted), and a rerun buys nothing',async()=>{
 const w=world({authorizeLands:false}),dir=tmp();
 try{
  const first=await run(w,dir);
  assert.equal(first.status,'ACCEPTED');
  assert.match(first.protocolDe,/noch nicht bestätigt/);
  await run(w,dir);
  assert.equal(count(w,'purchase'),1);
 }finally{rmSync(dir,{recursive:true})}
});

test('STATEMACHINE-6: a kill right after the refund request does not pay a second inspection on resume',async()=>{
 const w=world(),dir=tmp();
 class Crash extends Error{}
 try{
  // SIGKILL right after MPS accepted the refund request: the journal on disk is whatever was saved before that write.
  const real=w.escrow.requestRefund;let atKill;
  w.escrow.requestRefund=async(...a)=>{await real(...a);atKill=onlyJournal(dir);throw new Crash('killed');};
  w.deps={sleep:async()=>{if(w.calls.includes('request-refund'))throw new Crash('killed');}};
  await assert.rejects(run(w,dir),Crash);
  writeFileSync(join(dir,`${atKill.id}.json`),JSON.stringify(atKill));
  assert.notEqual(atKill.stage,'inspect');
  assert.equal(atKill.inspectionTxs.length,1,'the paid x402 inspection is journaled before the next MPS write');
  w.escrow.requestRefund=real;delete w.deps;
  const r=await run(w,dir);
  assert.equal(r.status,'ACCEPTED');
  assert.equal(count(w,'inspect'),2);
  assert.equal(r.txs.filter(t=>t.label.startsWith('x402')).length,2);
 }finally{rmSync(dir,{recursive:true})}
});

test('STATEMACHINE-6: a kill right after the paid x402 inspection reuses its verdict on resume instead of paying again',async()=>{
 const w=world(),dir=tmp();
 class Crash extends Error{}
 try{
  let atKill;
  const onProgress=l=>{if(!atKill&&/^Prüfung 1 /.test(l)){atKill=onlyJournal(dir);throw new Crash('killed');}};
  w.deps={sleep:async()=>{if(atKill)throw new Crash('killed');}};
  await assert.rejects(run(w,dir,{onProgress}),Crash);
  writeFileSync(join(dir,`${atKill.id}.json`),JSON.stringify(atKill));
  delete w.deps;
  const r=await run(w,dir);
  assert.equal(r.status,'ACCEPTED');
  assert.equal(count(w,'inspect'),2,'one paid inspection per delivery');
 }finally{rmSync(dir,{recursive:true})}
});

test('STATEMACHINE-6: two PRÜFEN with the same input at the same time drive one escrow',async()=>{
 const w=world(),dir=tmp();
 try{
  const [a,b]=await Promise.all([run(w,dir),run(w,dir)]);
  assert.equal(a.status,'ACCEPTED');assert.equal(b.status,'ACCEPTED');
  assert.equal(count(w,'purchase'),1);
  assert.equal(count(w,'inspect'),2);
 }finally{rmSync(dir,{recursive:true})}
});

// ---------- what the Büro refuses later is a defect now (STATEMACHINE-2) ----------

test('STATEMACHINE-2: an invoice number the Büro cannot send is a defect before release, never an ACCEPTED that PRÜFEN then refuses',async()=>{
 const xml=await buildXml({...fields,invoiceNumber:'AR:2026:0087'});
 const w=world({firstDefective:false,firstXml:xml,cure:'reject'}),dir=tmp();
 try{
  const r=await run(w,dir);
  assert.equal(r.status,'REFUSED');
  assert.match(r.protocolDe,/ABN-BT1/);
  assert.equal(w.state().onChainState,'RefundAuthorized');
 }finally{rmSync(dir,{recursive:true})}
});

// ---------- refusals end in a refund, not in a frozen escrow (ESCROW-3) ----------

test('ESCROW-3: a cure the seller announces but never submits ends in the seller-side refund, not in a frozen Disputed escrow',async()=>{
 const w=world({cure:'silent'}),dir=tmp();
 try{
  const r=await run(w,dir);
  assert.equal(r.status,'REFUSED');
  assert.ok(w.calls.includes('dispute#2'),'the next round asks the seller for the refund');
  assert.equal(w.state().onChainState,'RefundAuthorized');
 }finally{rmSync(dir,{recursive:true})}
});

test('ESCROW-3: a seller that answers every /dispute with 409 leaves a FAILED with an alarm about the frozen money; the journal stays resumable',async()=>{
 const w=world({disputeMode:'409'}),dir=tmp();
 try{
  const r=await run(w,dir);
  assert.equal(r.status,'FAILED');
  assert.match(r.protocolDe,/ALARM/);assert.match(r.protocolDe,/eingefroren/);
  assert.notEqual(onlyJournal(dir).stage,'done');
 }finally{rmSync(dir,{recursive:true})}
});

// ---------- acceptance bound to what was inspected (ESCROW-6, -7, STATEMACHINE-5) ----------

test('ESCROW-6: a result_hash changed after the cure was inspected is never authorized; the new result is inspected first',async()=>{
 const w=world({rotateBeforeAccept:true}),dir=tmp();
 try{
  const r=await run(w,dir);
  const inspected=journal(dir,r.journalId).attempts.map(a=>a.onChainHash);
  assert.ok(!w.calls.includes('cancel-refund-request')||inspected.includes(w.state().authorizedHash));
  assert.equal(r.status,'REFUSED');
  assert.equal(count(w,'inspect'),3);
 }finally{rmSync(dir,{recursive:true})}
});

test('ESCROW-7: a delivery whose JSON is not canonical (duplicate keys) is a defect even when its hash matches',async()=>{
 const good=buildResult({xml:goodXml,kosit:{accepted:true,scenario:XRECHNUNG_UBL_SCENARIO},profileHash,attempt:1});
 const bad=buildResult({xml:badXml,kosit:{accepted:true,scenario:XRECHNUNG_UBL_SCENARIO},profileHash,attempt:1});
 const part=(r,k)=>JSON.stringify(JSON.parse(r.result)[k]);
 const dup=`{"manifest":${part(bad,'manifest')},"manifest":${part(good,'manifest')},"xmlBase64":${part(bad,'xmlBase64')},"xmlBase64":${part(good,'xmlBase64')}}`;
 const w=world({firstDefective:false,firstResult:()=>dup}),dir=tmp();
 try{
  const r=await run(w,dir);
  assert.match(r.protocolDe,/ABN-MANIFEST/);
  assert.ok(w.calls.includes('request-refund'));
  assert.equal(r.status,'ACCEPTED');  // after the clean retransmission
 }finally{rmSync(dir,{recursive:true})}
});

test('STATEMACHINE-5: a job resumed under another acceptance profile is not inspected against the new one',async()=>{
 const w=world({firstDefective:false}),dir=tmp();
 class Crash extends Error{}
 try{
  w.deps={sleep:async()=>{throw new Crash('killed');}};
  const real=w.escrow.getPurchase;let once=true;
  w.escrow.getPurchase=async(...a)=>{const p=await real(...a);if(p?.onChainState==='FundsLocked'&&once){once=false;throw new Error('fetch failed');}return p;};
  await assert.rejects(run(w,dir),Crash);
  const j=onlyJournal(dir);j.profileHash='0'.repeat(64);writeFileSync(join(dir,`${j.id}.json`),JSON.stringify(j));
  w.escrow.getPurchase=real;delete w.deps;
  const r=await run(w,dir);
  assert.notEqual(r.status,'ACCEPTED');
  assert.ok(w.calls.includes('request-refund'));
  assert.ok(!w.calls.includes('cancel-refund-request'));
  assert.match(r.protocolDe,/Prüfprofil/);
 }finally{rmSync(dir,{recursive:true})}
});

// ---------- independent hash check (ESCROW-4 / LIVE-1, STATEMACHINE-11) ----------

test('LIVE-1: in a batched tx the engine reads its own escrow datum (by input_hash) and records no false ABN-HASH',async()=>{
 const other='cd'.repeat(32);
 const w=world({firstDefective:false,chainResultHash:(w,txHash,contract,{inputHash}={})=>inputHash===w.journalInputHash?w.state().resultHash:other}),dir=tmp();
 w.escrow.purchase=(real=>async(j,o)=>{w.journalInputHash=o.inputHash;return real(j,o);})(w.escrow.purchase);
 try{
  const r=await run(w,dir);
  assert.doesNotMatch(r.protocolDe,/ABN-HASH/);
  assert.equal(r.status,'ACCEPTED');
  assert.equal(journal(dir,r.journalId).attempts[0].hashSource,'Datum (Blockfrost)');
 }finally{rmSync(dir,{recursive:true})}
});

test('STATEMACHINE-11: while Blockfrost fails, the engine waits for the datum instead of falling back to MPS at once',async()=>{
 let fails=3;
 const w=world({firstDefective:false,chainResultHash:w=>{if(fails-->0)throw new Error('Blockfrost /txs/x/utxos 429');return w.state().resultHash;}}),dir=tmp();
 try{
  const r=await run(w,dir);
  assert.equal(r.status,'ACCEPTED');
  assert.equal(journal(dir,r.journalId).attempts[0].hashSource,'Datum (Blockfrost)');
 }finally{rmSync(dir,{recursive:true})}
});

// ---------- quotes and the RechnungsMeister contract ----------

test('STATEMACHINE-9: a quote whose deadlines are longer than RechnungsMeister\'s own is refused before any purchase',async()=>{
 const t=Date.now(),w=world({quote:{submitResultTime:t+30*24*60*MIN,unlockTime:t+30*24*60*MIN+20*MIN,externalDisputeUnlockTime:t+365*24*60*MIN}}),dir=tmp();
 try{
  const r=await run(w,dir);
  assert.equal(r.status,'FAILED');
  assert.ok(!w.calls.includes('purchase'));
  const v=world({quote:{unlockTime:'not a time'}}),dir2=tmp();
  try{assert.equal((await run(v,dir2)).status,'FAILED');assert.equal(count(v,'start_job'),1);}finally{rmSync(dir2,{recursive:true})}
 }finally{rmSync(dir,{recursive:true})}
});

test('the job token from start_job goes with /status and /dispute; a 429 from start_job is retried',async()=>{
 const w=world({startJob429:1}),dir=tmp();
 try{
  const r=await run(w,dir);
  assert.equal(r.status,'ACCEPTED');
  assert.equal(count(w,'start_job'),2);
  assert.ok(w.tokens.length>=3);
  assert.deepEqual([...new Set(w.tokens.map(([,t])=>t))],[TOKEN]);
 }finally{rmSync(dir,{recursive:true})}
});

test('a 401 from /dispute is retried, not read as the seller refusing the cure',async()=>{
 const w=world({disputeMode:'401once'}),dir=tmp();
 try{
  const r=await run(w,dir);
  assert.equal(r.status,'ACCEPTED');
 }finally{rmSync(dir,{recursive:true})}
});

test('ESCROW-5: with --follow, a payout whose result_hash differs from the accepted one is flagged',async()=>{
 const w=world({firstDefective:false,rotateAfterUnlock:true}),dir=tmp();
 try{
  const r=await run(w,dir,{followSettlement:true});
  assert.equal(w.state().onChainState,'Withdrawn');
  assert.match(r.protocolDe,/WARNUNG/);
 }finally{rmSync(dir,{recursive:true})}
});

// ---------- x402 reports (ESCROW-2 / STATEMACHINE-10) ----------

const b64sha=xml=>createHash('sha256').update(xml,'utf8').digest('base64');
const report=({engine='KoSIT Validator 1.6.3',xrechnung='3.0.2',hash='',accept=true}={})=>`<rep:report><rep:engine><rep:name>${engine}</rep:name></rep:engine><rep:documentIdentification><rep:documentHash><rep:hashAlgorithm>SHA-256</rep:hashAlgorithm><rep:hashValue>${hash}</rep:hashValue></rep:documentHash></rep:documentIdentification><rep:scenarioMatched><s:scenario><s:name>EN16931 XRechnung (UBL Invoice)</s:name><s:description><s:p>Schematron rules from EN16931:2017, and XRechnung
                 ${xrechnung} </s:p></s:description></s:scenario></rep:scenarioMatched><rep:assessment>${accept?'<rep:accept/>':'<rep:reject/>'}</rep:assessment></rep:report>`;

test('ESCROW-2: an x402 report counts only from the pinned validator and only for the inspected bytes',()=>{
 const ok=kositFromReport(200,report({hash:b64sha(goodXml)}),XRECHNUNG_UBL_SCENARIO,goodXml);
 assert.equal(ok.accepted,true);
 assert.throws(()=>kositFromReport(200,report({engine:'KoSIT Validator 1.5.0',hash:b64sha(goodXml)}),XRECHNUNG_UBL_SCENARIO,goodXml),/nicht beurteilt/);
 assert.throws(()=>kositFromReport(200,report({xrechnung:'2.3.1',hash:b64sha(goodXml)}),XRECHNUNG_UBL_SCENARIO,goodXml),/nicht beurteilt/);
 assert.throws(()=>kositFromReport(200,report({hash:b64sha(badXml)}),XRECHNUNG_UBL_SCENARIO,goodXml),/anderen Dokument/);
});

test('ESCROW-2: an x402 answer without a settled payment is no inspection; the local KoSIT decides',async()=>{
 const server=createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{res.writeHead(406,{'content-type':'application/xml'});res.end(report({hash:b64sha(body),accept:false}));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const saved={KOSIT_URL:process.env.KOSIT_URL,INSPECT_MODE:process.env.INSPECT_MODE};
 process.env.KOSIT_URL=`http://127.0.0.1:${server.address().port}/`;delete process.env.INSPECT_MODE;
 try{
  let answered=0;
  const squatter=async()=>{answered++;return {httpStatus:200,txHash:null,receipt:null,result:{verdict:'ACCEPTABLE',httpStatus:200,report:report({hash:b64sha(badXml)})}};};
  const r=await inspectXml(badXml,{scenario:XRECHNUNG_UBL_SCENARIO,buyInspection:squatter});
  assert.equal(answered,1);
  assert.equal(r.mode,'local');
  assert.equal(r.kosit.accepted,false);
  assert.match(r.note,/x402/);
  const paid=async xml=>({httpStatus:200,txHash:'tx1',receipt:{success:true,transaction:'tx1'},result:{verdict:'ACCEPTABLE',httpStatus:200,report:report({hash:b64sha(xml)})}});
  const x=await inspectXml(goodXml,{scenario:XRECHNUNG_UBL_SCENARIO,buyInspection:paid});
  assert.equal(x.mode,'x402');assert.equal(x.kosit.accepted,true);
 }finally{server.close();for(const [k,v] of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});

test('escrow tx labels follow the V2 state transitions',()=>{
 const rec={TransactionHistory:[
  {txHash:'a',status:'Confirmed',previousOnChainState:null,newOnChainState:'FundsLocked',createdAt:'1'},
  {txHash:'b',status:'Confirmed',previousOnChainState:'Disputed',newOnChainState:'RefundAuthorized',createdAt:'2'},
  {txHash:'c',status:'Confirmed',previousOnChainState:'RefundAuthorized',newOnChainState:'RefundWithdrawn',createdAt:'3'}]};
 assert.deepEqual(escrowTxs(rec,rec).map(t=>t.label),['FundsLocked','AuthorizeRefund','RefundWithdrawn']);
});

test('on-chain result_hash decodes from raw or hex-string bytes',()=>{
 const h='ab'.repeat(32);
 const fields=v=>({fields:[...Array(11).fill({bytes:''}),{bytes:v}]});
 assert.equal(decodeResultHash(fields(h)),h);
 assert.equal(decodeResultHash(fields(Buffer.from(h).toString('hex'))),h);
 assert.equal(decodeResultHash(fields('')),null);
});
