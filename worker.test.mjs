import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,chmodSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorker,createPaidSenden,runWorker,sokosumiCli,abnahmeModule} from './worker.mjs';
import {createBuero} from './buero/sokosumi.mjs';
import {parseFixed} from './einvoice/parse-fixed.mjs';
import {buildXml} from './einvoice/build.mjs';
import {USDM} from './paid-task.mjs';

// Fakes for the Sokosumi CLI, Core runtime API and MPS. Each test runs in a fresh cwd, so journals stay out of the repo.
process.env.PAID_TASKS_ENABLED='true';
const fixture=name=>readFileSync(new URL(`./fixtures/${name}`,import.meta.url),'utf8');
const xmlB=await buildXml(parseFixed(fixture('b-abschlag-13b-bau-isar.fixed.txt')));
const pruefenInput=`PRÜFEN\nEmpfänger: bau-isar\nBetrag: 18.400,00 €\n${fixture('b-abschlag-13b-bau-isar.txt')}`;
const target={coworkerId:'cw',organizationId:'org',taskArgs:[],runtimeArgs:['--organization-id','org']};
const registration={walletId:'seller-wallet',agentIdentifier:'a'.repeat(80),supportedPaymentSourceIndex:0};
const task=(id,description,extra={})=>({id,description,status:'READY',coworkerId:'cw',organizationId:'org',userId:'user-berger',...extra});
const accepted=async()=>({status:'ACCEPTED',protocolDe:'Abnahme: ABGENOMMEN',xml:xmlB,kositReport:null,txs:[],purchaseId:null});
const tick=()=>new Promise(r=>setImmediate(r));
function sandbox(){process.chdir(mkdtempSync(join(tmpdir(),'worker-')));mkdirSync('.local',{mode:0o700});}
function fakeSokosumi(initial){
 const tasks=[...initial],posted=[],calls=[];
 const byId=id=>tasks.find(t=>t.id===id);
 const cli=args=>{calls.push(args.slice(0,2).join(' '));
  if(args[0]==='tasks'&&args[1]==='list')return {tasks:tasks.map(t=>({...t}))};
  const t=byId(args[2]);
  if(args[1]==='start'){if(t.failStart){t.failStart--;throw new Error('HTTP 503')}if(t.status!=='READY')throw new Error('Task must be READY. No further operation was submitted.');t.status='RUNNING';return {...t};}
  if(args[1]==='complete'){if(t.failComplete){t.failComplete--;throw new Error('HTTP 503')}if(t.status!=='RUNNING')throw new Error('Task must be RUNNING. No further operation was submitted.');t.status='COMPLETED';t.result=readFileSync(args[args.indexOf('--result-file')+1],'utf8');return {status:'COMPLETED'};}
  throw new Error(`unexpected cli ${args.join(' ')}`);
 };
 const post=async(taskId,body)=>{const t=byId(taskId);if(body.status&&t.status!=='RUNNING')throw new Error('HTTP 409');posted.push({taskId,...body});if(body.status)t.status=body.status;return {data:{id:`ev${posted.length}`}};};
 const core={get:async path=>{calls.push('core get');return {data:{...byId(decodeURIComponent(path.split('/')[3]))}}},post:async(path,body)=>post(decodeURIComponent(path.split('/')[3]),body)};
 const events={comment:(id,text)=>post(id,{comment:text}),fail:(id,text)=>post(id,{status:'FAILED',comment:text})};
 return {cli,core,events,posted,calls,task:byId,add:(...more)=>tasks.push(...more),failText:id=>posted.find(e=>e.taskId===id&&e.status==='FAILED')?.comment};
}
function fakeMps({lock=true}={}){
 const calls=[],payments=new Map();
 const mps=async(path,body)=>{calls.push(path);
  if(path==='/api/v1/payment'){const p={sellerReturnAddress:null,forceLayer:null,PaymentSource:{network:'Preprod',paymentSourceType:'Web3CardanoV2',smartContractAddress:'addr_test1contract',policyId:'a'.repeat(56)},
   SmartContractWallet:{id:'seller-wallet',walletVkey:'b'.repeat(56)},RequestedFunds:[{amount:'1000000',unit:USDM}],agentIdentifier:body.agentIdentifier,blockchainIdentifier:`bc-${payments.size+1}`,inputHash:body.inputHash,
   payByTime:String(Date.parse(body.payByTime)),submitResultTime:String(Date.parse(body.submitResultTime)),unlockTime:String(Date.parse(body.unlockTime)),externalDisputeUnlockTime:String(Date.parse(body.externalDisputeUnlockTime)),onChainState:null};
   payments.set(p.blockchainIdentifier,p);return p;}
  const p=payments.get(body.blockchainIdentifier);
  if(path==='/api/v1/payment/submit-result'){Object.assign(p,{resultHash:body.submitResultHash,onChainState:'ResultSubmitted',CurrentTransaction:{status:'Confirmed',newOnChainState:'ResultSubmitted'}});return p;}
  if(lock&&!p.onChainState)Object.assign(p,{onChainState:'FundsLocked',CurrentTransaction:{status:'Confirmed',newOnChainState:'FundsLocked'}});
  return {...p};
 };
 return {mps,calls,payments:()=>calls.filter(p=>p==='/api/v1/payment').length};
}
async function setup(s,m=fakeMps(),{runAbnahme=accepted,send,probe=async()=>true,reply=async()=>{}}={}){
 const mails=[],runs=[];
 const buero=createBuero({runAbnahme:async a=>{runs.push(a);return runAbnahme(a)},probe,
  send:send??(async mail=>{mails.push(mail);return {messageId:`<m${mails.length}@abnahme.local>`,smtpReply:'250 Ok'}})});
 const paid=await createPaidSenden({buero,target,registration,core:s.core,mps:m.mps});
 const worker=createWorker({target,cli:s.cli,buero,paid,events:s.events,reply,paidReady:()=>true});
 return {worker,mails,runs,buero};
}
async function polls(worker,n){for(let i=0;i<n;i++){await worker.poll();await Promise.all(worker.inflight.values());}}
const journal=id=>JSON.parse(readFileSync(`.local/${id}.json`,'utf8'));

test('QA-1: two SENDEN Tasks for one accepted invoice: one payment request, the second fails free before payment',async()=>{
 sandbox();const s=fakeSokosumi([task('p1',pruefenInput)]),m=fakeMps();const {worker,mails}=await setup(s,m);
 await polls(worker,2);assert.equal(s.task('p1').status,'COMPLETED');
 s.add(task('s1','SENDEN AR-2026-0087'),task('s2','SENDEN AR-2026-0087'));
 await polls(worker,8);
 assert.equal(m.payments(),1);
 assert.equal(s.task('s2').status,'FAILED');assert.match(s.failText('s2'),/läuft bereits.*s1/su);assert.match(s.failText('s2'),/nichts berechnet/);
 assert.equal(s.task('s1').status,'COMPLETED');assert.equal(mails.length,1);
});

test('QA-2: a PRÜFEN left at model-pending by a stopped worker is resumed and completed after restart',async()=>{
 sandbox();const s=fakeSokosumi([task('p1',pruefenInput,{status:'RUNNING'})]);
 writeFileSync('.local/p1.json',JSON.stringify({phase:'model-pending',input:pruefenInput}));
 const {worker,runs}=await setup(s);
 await polls(worker,3);
 assert.equal(runs.length,1);assert.equal(s.task('p1').status,'COMPLETED');assert.match(s.task('p1').result,/ABGENOMMEN/);
});

test('QA-2: stop during a PRÜFEN waits for its result, completes the Task and starts nothing new',async()=>{
 sandbox();let release;const gate=new Promise(r=>{release=r});
 const s=fakeSokosumi([task('p1',pruefenInput)]);
 const {worker}=await setup(s,undefined,{runAbnahme:async()=>{await gate;return accepted()}});
 assert.equal(typeof worker.stop,'function','worker.stop() drains the loop');
 let done=false;const loop=runWorker(worker,{wait:tick}).then(()=>{done=true});
 while(!worker.inflight.size)await tick();
 worker.stop();s.add(task('p2',pruefenInput));
 for(let i=0;i<20;i++)await tick();
 assert.equal(done,false);
 release();await loop;
 assert.equal(s.task('p1').status,'COMPLETED');assert.equal(s.task('p2').status,'READY');
});

async function sendenUntilResultSaved(){
 const s=fakeSokosumi([task('p1',pruefenInput)]),m=fakeMps();const first=await setup(s,m);
 await polls(first.worker,2);
 s.add(task('s1','SENDEN AR-2026-0087'));
 for(let i=0;i<10&&!(existsSync('.local/s1.json')&&journal('s1').paid?.stage==='result-saved');i++)await polls(first.worker,1);
 assert.equal(journal('s1').paid.stage,'result-saved');assert.equal(first.mails.length,1);
 return {s,m,first};
}
test('QA-2: a paid SENDEN found at model-pending after the mail went out completes without a second mail',async()=>{
 sandbox();const {s,m,first}=await sendenUntilResultSaved();
 const j=journal('s1');writeFileSync('.local/s1.json',JSON.stringify({...j,paid:{...j.paid,stage:'model-pending'}}));  // crash after the ledger said sent
 const {worker,mails}=await setup(s,m);
 await polls(worker,6);
 assert.equal(s.task('s1').status,'COMPLETED');assert.match(s.task('s1').result??s.posted.find(e=>e.taskId==='s1'&&e.status==='COMPLETED').comment,/Versendet: XRechnung AR-2026-0087/);
 assert.equal(mails.length+first.mails.length,1);
});
test('QA-2: a paid SENDEN found at model-pending with the ledger still at sending is FAILED with an inbox hint',async()=>{
 sandbox();const {s,m}=await sendenUntilResultSaved();
 const j=journal('s1');writeFileSync('.local/s1.json',JSON.stringify({...j,paid:{...j.paid,stage:'model-pending'}}));
 const ledger=JSON.parse(readFileSync('.local/sent-ledger.json','utf8'));ledger.entries[0].status='sending';writeFileSync('.local/sent-ledger.json',JSON.stringify(ledger));
 const {worker,mails}=await setup(s,m);
 await polls(worker,3);
 assert.equal(s.task('s1').status,'FAILED');assert.match(s.failText('s1'),/Postfach prüfen/);assert.match(s.failText('s1'),/Credits/);
 assert.equal(mails.length,0);
});

test('QA-5: a runtime start that fails once is retried on the next poll',async()=>{
 sandbox();const s=fakeSokosumi([task('p1',pruefenInput,{failStart:1})]);const {worker}=await setup(s);
 await polls(worker,3);
 assert.equal(s.task('p1').status,'COMPLETED');
});
test('QA-5: a runtime complete that fails once is retried on the next poll',async()=>{
 sandbox();const s=fakeSokosumi([task('p1',pruefenInput,{failComplete:1})]);const {worker}=await setup(s);
 await polls(worker,4);
 assert.equal(s.task('p1').status,'COMPLETED');
});
test('QA-5: a FAILED post that fails once is retried on the next poll',async()=>{
 sandbox();const s=fakeSokosumi([task('p1','Suggest names')]);const {worker}=await setup(s);
 const fail=s.events.fail;let once=true;s.events.fail=async(...a)=>{if(once){once=false;throw new Error('HTTP 503')}return fail(...a)};
 await polls(worker,4);
 assert.equal(s.task('p1').status,'FAILED');assert.match(s.failText('p1'),/Unbekannter Auftrag/);
});
test('QA-5/QA-8: a PRÜFEN cancelled while running ends in a terminal phase, and its acceptance cannot be sent',async()=>{
 sandbox();let release;const gate=new Promise(r=>{release=r});
 const s=fakeSokosumi([task('p1',pruefenInput)]),m=fakeMps();
 const {worker}=await setup(s,m,{runAbnahme:async()=>{await gate;return accepted()}});
 await worker.poll();s.task('p1').status='CANCELED';release();await polls(worker,3);
 assert.match(journal('p1').phase,/^(closed|cancelled)$/);
 s.add(task('s1','SENDEN AR-2026-0087'));await polls(worker,3);
 assert.equal(m.payments(),0);assert.equal(s.task('s1').status,'FAILED');assert.match(s.failText('s1'),/nichts berechnet/);
});
test('QA-8: SENDEN from another Sokosumi user is refused before any payment request',async()=>{
 sandbox();const s=fakeSokosumi([task('p1',pruefenInput)]),m=fakeMps();const {worker}=await setup(s,m);
 await polls(worker,2);
 s.add(task('s1','SENDEN AR-2026-0087',{userId:'user-other'}));await polls(worker,3);
 assert.equal(m.payments(),0);assert.equal(s.task('s1').status,'FAILED');assert.match(s.failText('s1'),/nichts berechnet/);
});
test('QA-3: SENDEN is refused before payment when the outgoing mail server is unreachable',async()=>{
 sandbox();const s=fakeSokosumi([task('p1',pruefenInput)]),m=fakeMps();const {worker}=await setup(s,m,{probe:async()=>false});
 await polls(worker,2);
 s.add(task('s1','SENDEN AR-2026-0087'));await polls(worker,3);
 assert.equal(m.payments(),0);assert.equal(s.task('s1').status,'FAILED');assert.match(s.failText('s1'),/SMTP.*nichts berechnet/su);
});
test('QA-9: an oversized PRÜFEN is refused in German without running the acceptance test',async()=>{
 sandbox();const s=fakeSokosumi([task('p1',pruefenInput+'x'.repeat(20000))]);const {worker,runs}=await setup(s);
 await polls(worker,3);
 assert.equal(runs.length,0);assert.equal(s.task('p1').status,'FAILED');assert.match(s.failText('p1'),/zu lang/);
});
test('QA-9: a Task listing above 4 MiB does not stop the CLI reader',()=>{
 sandbox();mkdirSync('bin');const big='x'.repeat(5*1024*1024);
 writeFileSync('bin/sokosumi',`#!${process.execPath}\nprocess.stdout.write(JSON.stringify({tasks:[{id:'t',description:${JSON.stringify(big)}}]}))\n`);chmodSync('bin/sokosumi',0o755);
 const path=process.env.PATH;process.env.PATH=`${process.cwd()}/bin:${path}`;
 try{assert.equal(sokosumiCli(['tasks','list']).tasks[0].description.length,big.length);}finally{process.env.PATH=path;}
});
test('QA-15: finished Tasks cause no Core, CLI or comment traffic per poll',async()=>{
 sandbox();const s=fakeSokosumi([task('p1',pruefenInput)]),m=fakeMps();let replies=0;
 const {worker}=await setup(s,m,{send:async()=>{throw Object.assign(new Error('connect ECONNREFUSED'),{dataSent:false})},reply:async()=>{replies++}});
 await polls(worker,2);s.add(task('s1','SENDEN AR-2026-0087'));
 for(let i=0;i<10&&s.task('s1').status!=='FAILED';i++)await polls(worker,1);
 assert.equal(s.task('s1').status,'FAILED');await polls(worker,1);
 const before={calls:s.calls.length,mps:m.calls.length,replies};
 await polls(worker,3);
 assert.deepEqual(s.calls.slice(before.calls),['tasks list','tasks list','tasks list']);
 assert.equal(m.calls.length,before.mps);assert.equal(replies,before.replies);
});
test('QA-10: the worker resolves its acceptance engine for both ABNAHME_IMPL values',async()=>{
 for(const impl of ['local',undefined])assert.equal(typeof (await import(abnahmeModule(impl))).runAbnahme,'function',String(impl));
});
test('at most two PRÜFEN run at once; a third waits in the queue with one German comment and starts when a slot frees',async()=>{
 sandbox();let release;const gate=new Promise(r=>{release=r});
 const s=fakeSokosumi([task('p1',pruefenInput),task('p2',pruefenInput),task('p3',pruefenInput)]);
 const {worker,runs}=await setup(s,undefined,{runAbnahme:async()=>{await gate;return accepted()}});
 await worker.poll();await worker.poll();
 assert.equal(runs.length,2);assert.equal(journal('p3').phase,'started');
 assert.equal(s.posted.filter(e=>e.taskId==='p3'&&/Warteschlange/.test(e.comment??'')).length,1);
 release();await polls(worker,3);
 assert.equal(runs.length,3);assert.deepEqual(['p1','p2','p3'].map(id=>s.task(id).status),['COMPLETED','COMPLETED','COMPLETED']);
});
test('a journal is closed only on a terminal Core status, not on INPUT_REQUIRED or DRAFT',async()=>{
 sandbox();const s=fakeSokosumi([task('p1','Suggest names',{status:'INPUT_REQUIRED'})]);
 writeFileSync('.local/p1.json',JSON.stringify({phase:'gate-failed',input:'Suggest names',error:'x'}));
 const {worker}=await setup(s);await polls(worker,2);
 assert.notEqual(journal('p1').phase,'closed');
});
// G1: an escrow run that ends FAILED with its journal still open is resumed by the worker, once per journal.
const failedOpen=async()=>({status:'FAILED',protocolDe:'ALARM: Abnahme j1 hängt nach 12 Fehlern',xml:null,kositReport:null,txs:[],purchaseId:'purchase-1',journalId:'j1'});
const escrowJournal=stage=>{mkdirSync('.local/abnahme-journal',{recursive:true});writeFileSync('.local/abnahme-journal/j1.json',JSON.stringify({id:'j1',stage}));};
const pauseOver=id=>writeFileSync(`.local/${id}.json`,JSON.stringify({...journal(id),resumeAt:0}));
test('G1: a FAILED PRÜFEN whose escrow journal is still open is resumed once after a pause and completes',async()=>{
 sandbox();escrowJournal('notify');let n=0;
 const s=fakeSokosumi([task('p1',pruefenInput)]);const {worker,runs}=await setup(s,undefined,{runAbnahme:()=>++n===1?failedOpen():accepted()});
 await polls(worker,3);
 assert.equal(runs.length,1);assert.equal(s.task('p1').status,'RUNNING');
 assert.equal(journal('p1').resumedJournal,'j1');assert.ok(journal('p1').resumeAt>Date.now());
 assert.equal(s.posted.filter(e=>e.taskId==='p1'&&/automatisch fortgesetzt/.test(e.comment??'')).length,1);
 pauseOver('p1');await polls(worker,3);
 assert.equal(runs.length,2);assert.equal(s.task('p1').status,'COMPLETED');assert.match(s.task('p1').result,/ABGENOMMEN/);
});
test('G1: the automatic resume is bounded: a second FAILED for the same journal fails the Task',async()=>{
 sandbox();escrowJournal('notify');
 const s=fakeSokosumi([task('p1',pruefenInput)]);const {worker,runs}=await setup(s,undefined,{runAbnahme:failedOpen});
 await polls(worker,2);pauseOver('p1');await polls(worker,4);
 assert.equal(runs.length,2);assert.equal(s.task('p1').status,'FAILED');assert.match(s.failText('p1'),/hängt nach 12 Fehlern/);
});
test('G1: a FAILED PRÜFEN whose escrow journal is closed is not resumed (a rerun would buy again)',async()=>{
 sandbox();escrowJournal('done');
 const s=fakeSokosumi([task('p1',pruefenInput)]);const {worker,runs}=await setup(s,undefined,{runAbnahme:failedOpen});
 await polls(worker,3);
 assert.equal(runs.length,1);assert.equal(s.task('p1').status,'FAILED');
});

test('LANE-A2-3: queued PRÜFEN start oldest first, and a PRÜFEN with an input error fails at once instead of waiting in the queue',async()=>{
 sandbox();let release;const gate=new Promise(r=>{release=r});
 const at=m=>`2026-10-30T16:0${m}:00.000Z`;
 // the CLI lists newest first, like `sokosumi tasks list`
 const s=fakeSokosumi([task('p4',pruefenInput,{createdAt:at(4)}),task('bad',pruefenInput.replace(/^Betrag: .*\n/mu,''),{createdAt:at(3)}),
  task('p3',pruefenInput,{createdAt:at(2)}),task('p2',pruefenInput,{createdAt:at(1)}),task('p1',pruefenInput,{createdAt:at(0)})]);
 const started=[];
 const {worker}=await setup(s,undefined,{runAbnahme:async a=>{started.push(a);await gate;return accepted()}});
 await worker.poll();
 assert.deepEqual([...worker.inflight.keys()],['p1','p2'],'the two oldest run first');
 assert.equal(s.task('bad').status,'FAILED');assert.match(s.failText('bad'),/Die Zeile „Betrag: <Bruttobetrag>“ fehlt/);
 assert.equal(s.posted.filter(e=>e.taskId==='bad'&&/Warteschlange/.test(e.comment??'')).length,0,'no queue comment for a bad input');
 assert.deepEqual(['p3','p4'].map(id=>journal(id).queued),[true,true]);
 release();await Promise.all(worker.inflight.values());await worker.poll();
 assert.deepEqual([...worker.inflight.keys()],['p3','p4'],'then the next two, oldest first');
 await polls(worker,3);
 assert.deepEqual(['p1','p2','p3','p4'].map(id=>s.task(id).status),['COMPLETED','COMPLETED','COMPLETED','COMPLETED']);
});

// ---- Fix round 5 (delta review).
test('DELTA-WORKER-2: a paid SENDEN at result-saved after the result deadline is COMPLETED and then left alone',async()=>{
 sandbox();const {s,m}=await sendenUntilResultSaved();
 const j=journal('s1');writeFileSync('.local/s1.json',JSON.stringify({...j,paid:{...j.paid,payment:{...j.paid.payment,submitResultTime:String(Date.now()-1000)}}}));
 const {worker,mails}=await setup(s,m);
 await polls(worker,3);
 assert.equal(s.task('s1').status,'COMPLETED');assert.match(s.posted.find(e=>e.taskId==='s1'&&e.status==='COMPLETED').comment,/Versendet: XRechnung AR-2026-0087[\s\S]*nicht vor Ablauf der Frist/);
 assert.equal(mails.length,0);assert.equal(m.calls.includes('/api/v1/payment/submit-result'),false);
 const before={core:s.calls.length,mps:m.calls.length};
 await polls(worker,2);
 assert.deepEqual(s.calls.slice(before.core),['tasks list','tasks list']);assert.equal(m.calls.length,before.mps);
});
test('DELTA-WORKER-3: a SENDEN whose Task closes before the paid adapter saved a stage releases its reservation',async()=>{
 sandbox();const s=fakeSokosumi([task('p1',pruefenInput)]),m=fakeMps();const {worker}=await setup(s,m);
 await polls(worker,2);
 s.add(task('s1','SENDEN AR-2026-0087'));
 const get=s.core.get;let fail=true;s.core.get=async(...a)=>{if(fail){fail=false;throw new Error('HTTP 503')}return get(...a)};
 await polls(worker,1);
 assert.equal(JSON.parse(readFileSync('.local/sent-ledger.json','utf8')).entries[0].status,'reserved','the gate reserved before the Core read failed');
 s.task('s1').status='CANCELED';await polls(worker,1);
 assert.equal(journal('s1').phase,'closed');
 assert.deepEqual(JSON.parse(readFileSync('.local/sent-ledger.json','utf8')).entries,[]);
 s.add(task('s2','SENDEN AR-2026-0087'));await polls(worker,6);
 assert.equal(m.payments(),1);assert.equal(s.task('s2').status,'COMPLETED');
});
test('DELTA-WORKER-4: a paid SENDEN cancelled after the payment request is not mailed when FundsLocked arrives, and gives its reservation back',async()=>{
 sandbox();const s=fakeSokosumi([task('p1',pruefenInput)]),m=fakeMps();const {worker,mails}=await setup(s,m);
 await polls(worker,2);s.add(task('s1','SENDEN AR-2026-0087'));
 for(let i=0;i<5&&!(existsSync('.local/s1.json')&&journal('s1').paid?.stage==='awaiting-escrow');i++)await polls(worker,1);
 assert.equal(journal('s1').paid.stage,'awaiting-escrow');
 s.task('s1').status='CANCELED';await polls(worker,3);
 assert.equal(mails.length,0);assert.equal(m.calls.includes('/api/v1/payment/submit-result'),false);
 assert.equal(journal('s1').paid.stage,'failed');assert.equal(journal('s1').phase,'closed');
 assert.equal(s.posted.some(e=>e.taskId==='s1'&&e.status),false);
 assert.deepEqual(JSON.parse(readFileSync('.local/sent-ledger.json','utf8')).entries,[]);
});
