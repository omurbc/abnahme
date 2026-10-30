import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runAbnahme} from './abnahme.mjs';
import {escrowTxs,decodeResultHash} from './escrow.mjs';
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

// A fake MPS + RechnungsMeister on one simulated chain. Every getPurchase is one "block": queued actions land.
function world({firstDefective=true,cure='ok',cheat=false}={}){
 const calls=[];let p=null,nonce,result,attempt=0;
 const tx=(prev,next)=>{p.CurrentTransaction={txHash:sha256(`${prev}>${next}>${calls.length}`),status:'Confirmed',previousOnChainState:prev,newOnChainState:next};p.TransactionHistory.push(p.CurrentTransaction);p.onChainState=next;};
 const deliver=xml=>{attempt++;result=buildResult({xml,kosit:{accepted:true,scenario:XRECHNUNG_UBL_SCENARIO},profileHash,attempt}).result;const h=resultHash(result,nonce);p.resultHash=cheat?sha256(`CHEAT;${h}`):h;};
 const now=Date.now();
 const job={id:'7d1c2a7e-0000-4000-8000-000000000001',job_id:'7d1c2a7e-0000-4000-8000-000000000001',blockchainIdentifier:'bcid-1',agentIdentifier:'agent',sellerVKey:'vk',smartContractAddress:'addr_test1contract',supportedPaymentSourceIndex:0,
  amounts:[{amount:'1000000',unit:USDM}],payByTime:now+10*MIN,submitResultTime:now+25*MIN,unlockTime:now+45*MIN,externalDisputeUnlockTime:now+65*MIN};
 const rm={
  async startJob(body){calls.push('start_job');nonce=body.identifier_from_purchaser;return {httpStatus:200,body:{...job,input_hash:inputHashFor(body.input_data,nonce)}};},
  async status(){calls.push('status');return {httpStatus:200,body:{status:'completed',phase:'result-confirmed',result}};},
  async dispute(body){
   calls.push(`dispute#${body.round}`);
   if(cure==='reject'||attempt>=2)return {httpStatus:422,body:{status:'cure-rejected',reasons:['Mangel nicht heilbar.']}};
   deliver(goodXml);tx('Disputed','Disputed');
   return {httpStatus:200,body:{status:'cure-submitted',attempt,patch:{buyerVatId:'DE287654321'},sources:{buyerVatId:'input_data.invoiceText'}}};
  },
 };
 const escrow={
  async purchase(j,{inputHash}){calls.push('purchase');assert.equal(inputHash,inputHashFor({invoiceText:'x',recipientProfileId:'bau-isar',expectedTotal:'18400.00',acceptanceProfileHash:profileHash},nonce));
   p={id:'purchase-1',onChainState:null,resultHash:null,NextAction:{requestedAction:'FundsLockingRequested'},TransactionHistory:[],PaymentSource:{smartContractAddress:j.smartContractAddress}};return p;},
  async getPurchase(){
   if(!p)return null;
   const a=p.NextAction.requestedAction;p.NextAction={requestedAction:'WaitingForExternalAction'};
   if(a==='FundsLockingRequested')tx(null,'FundsLocked');
   else if(p.onChainState==='FundsLocked'){deliver(firstDefective?badXml:goodXml);tx('FundsLocked','ResultSubmitted');}
   else if(a==='SetRefundRequestedRequested')tx('ResultSubmitted','Disputed');
   else if(a==='AuthorizeWithdrawalRequested')tx('Disputed','WithdrawAuthorized');
   else if(p.onChainState==='WithdrawAuthorized')tx('WithdrawAuthorized','Withdrawn');
   return structuredClone(p);
  },
  async getPayment(){return null;},
  async requestRefund(){calls.push('request-refund');assert.equal(p.onChainState,'ResultSubmitted');p.NextAction={requestedAction:'SetRefundRequestedRequested'};},
  async cancelRefundRequest(){calls.push('cancel-refund-request');assert.equal(p.onChainState,'Disputed');p.NextAction={requestedAction:'AuthorizeWithdrawalRequested'};},
  async chainResultHash(){return null;},
 };
 const inspect=async xml=>{calls.push('inspect');const ok=xml.includes('DE287654321');
  return {mode:'x402',txHash:sha256(`x402-${calls.length}`),kosit:{accepted:ok,httpStatus:ok?200:406,scenario:XRECHNUNG_UBL_SCENARIO,messages:ok?[]:[{level:'error',code:'BR-AE-02',text:'[BR-AE-02] …'}],reportXml:'<rep/>'}};};
 return {calls,rm,escrow,inspect,state:()=>p};
}

const run=(w,dir,extra={})=>runAbnahme({invoiceText:'x',recipientProfileId:'bau-isar',expectedTotal:'18400.00',...extra},{rm:w.rm,escrow:w.escrow,inspect:w.inspect,now:()=>Date.now(),sleep:async()=>{},journalDir:dir,pollMs:0,...w.deps});
const tmp=()=>mkdtempSync(join(tmpdir(),'abnahme-'));

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

test('an uncurable defect is REFUSED and the money is never released',async()=>{
 const w=world({cure:'reject'}),dir=tmp();
 try{
  const r=await run(w,dir);
  assert.equal(r.status,'REFUSED');
  assert.ok(!w.calls.includes('cancel-refund-request'));
  assert.equal(w.state().onChainState,'Disputed');
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
