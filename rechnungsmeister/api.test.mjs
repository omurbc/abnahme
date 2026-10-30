// HTTP and timer-loop tests for the RechnungsMeister server against a fake MPS 0.29.0 and a fake KoSIT.
// The server keeps its job store and registry relative to the working directory, so this file runs it in a
// scratch directory and never touches the live .local/rechnungsmeister-jobs.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {loadProfile} from '../verifier/profile.mjs';
import {parseFixed} from '../einvoice/parse-fixed.mjs';
import {sha256} from '../standard-hash.mjs';
import {USDM} from '../paid-task.mjs';

const MIN=60000;
const fixture=name=>readFileSync(new URL(`../fixtures/${name}`,import.meta.url),'utf8');
const dir=mkdtempSync(join(tmpdir(),'rm-api-'));
mkdirSync(join(dir,'docs'));
writeFileSync(join(dir,'docs/rechnungsmeister-registration-state.json'),JSON.stringify({registrationState:'RegistrationConfirmed',supportedPaymentSourceIndex:0,agentIdentifier:'agent-rm'}));
process.chdir(dir);
const jobsDir=join(dir,'.local/rechnungsmeister-jobs');

// Fake MPS: the routes RechnungsMeister uses, with the state preconditions of MPS 0.29.0
// (submit-result and authorize-refund need NextAction WaitingForExternalAction).
const mps={calls:[],payments:new Map(),failNextPayment:false};
const callsTo=path=>mps.calls.filter(c=>c.path===path);
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const mpsServer=createServer(async(req,res)=>{
 let text='';for await(const chunk of req)text+=chunk;
 const input=text?JSON.parse(text):null,path=req.url.replace('/api/v1','');mps.calls.push({path,input});
 const send=(status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(status<300?{status:'success',data}:{status:'error',error:data}));};
 if(path==='/payment'){
  if(mps.failNextPayment){mps.failNextPayment=false;return send(500,'down');}
  const now=Date.now(),p={blockchainIdentifier:`bc-${mps.payments.size+1}`,onChainState:null,NextAction:{requestedAction:'WaitingForExternalAction'},resultHash:null,
   RequestedFunds:[{unit:USDM,amount:'1000000'}],payByTime:String(now+10*MIN),submitResultTime:String(now+25*MIN),unlockTime:String(now+45*MIN),externalDisputeUnlockTime:String(now+65*MIN),
   SmartContractWallet:{walletVkey:'vk'},PaymentSource:{smartContractAddress:'addr'},TransactionHistory:[]};
  mps.payments.set(p.blockchainIdentifier,p);return send(200,p);
 }
 const p=mps.payments.get(input?.blockchainIdentifier);
 if(!p)return send(404,'Payment not found');
 if(path==='/payment/resolve-blockchain-identifier')return send(200,p);
 const idle=p.NextAction.requestedAction==='WaitingForExternalAction';
 if(path==='/payment/submit-result'){
  if(!idle||!['FundsLocked','Disputed','RefundRequested'].includes(p.onChainState))return send(404,'Payment not found or in invalid state');
  p.NextAction={requestedAction:'SubmitResultRequested',resultHash:input.submitResultHash};return send(200,p);
 }
 if(path==='/payment/authorize-refund'){
  if(!idle||!['Disputed','RefundRequested'].includes(p.onChainState))return send(404,'Payment not found or in invalid state');
  p.NextAction={requestedAction:'AuthorizeRefundRequested'};return send(200,p);
 }
 send(404,'Route not found');
});
// Fake KoSIT 1.6.3 accepting everything under the pinned scenario (report shape as in verifier/kosit.test.mjs).
const report=`<rep:report><rep:engine><rep:name>KoSIT Validator 1.6.3</rep:name></rep:engine><rep:scenarioMatched><s:scenario><s:name>EN16931 XRechnung (UBL Invoice)</s:name><s:description><s:p>Uses Schematron rules from EN16931:2017, and XRechnung 3.0.2 </s:p></s:description></s:scenario></rep:scenarioMatched><rep:assessment><rep:accept/></rep:assessment></rep:report>`;
const kositServer=createServer((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200,{'content-type':'text/xml'});res.end(report);});});

process.env.MPS_URL=`http://127.0.0.1:${await listen(mpsServer)}`;
process.env.MPS_RUNTIME_TOKEN='test-only';
process.env.KOSIT_URL=`http://127.0.0.1:${await listen(kositServer)}/`;
delete process.env.DEMO_SEED_DEFECT;delete process.env.CHEAT;
const rm=await import('./server.mjs');
const api=createServer(rm.handler);
const base=`http://127.0.0.1:${await listen(api)}`;
after(()=>{for(const s of [api,mpsServer,kositServer]){s.closeAllConnections();s.close();}});

async function call(path,{body,token,headers={}}={}){
 const post=body!==undefined;
 const r=await fetch(base+path,{method:post?'POST':'GET',body:post?(typeof body==='string'?body:JSON.stringify(body)):undefined,
  headers:{...(post?{'content-type':'application/json'}:{}),...(token?{authorization:`Bearer ${token}`}:{}),...headers}});
 return {status:r.status,body:await r.json().catch(()=>null),headers:r.headers};
}
const {profileHash}=loadProfile('bau-isar');
const inputData={invoiceText:fixture('b-abschlag-13b-bau-isar.txt'),recipientProfileId:'bau-isar',expectedTotal:'18400.00',acceptanceProfileHash:profileHash};
const fields0=parseFixed(fixture('b-abschlag-13b-bau-isar.fixed.txt'));
const newNonce=()=>randomBytes(10).toString('hex');
const startJob=(nonce=newNonce())=>call('/start_job',{body:{identifier_from_purchaser:nonce,input_data:inputData}});
const readJob=id=>JSON.parse(readFileSync(join(jobsDir,`${id}.json`),'utf8'));

// A job file as the server writes it after the first delivery (seeded BT-48 defect), with its escrow in the fake MPS.
function makeJob({phase='result-confirmed',onChainState='Disputed',nextAction={requestedAction:'WaitingForExternalAction'},ext=Date.now()+65*MIN,payBy=Date.now()-5*MIN,
 attempts=[{attempt:1,fields:{...fields0,buyerVatId:null},result:'result-1',resultHash:'h1',submittedAt:Date.now()-5*MIN}],disputes=[],chainHash='h1'}={}){
 const id=randomUUID(),token=randomBytes(32).toString('hex'),nonce=newNonce();
 const payment={blockchainIdentifier:`bc-${id}`,onChainState,NextAction:nextAction,resultHash:chainHash,payByTime:String(payBy),submitResultTime:String(ext-40*MIN),
  unlockTime:String(ext-20*MIN),externalDisputeUnlockTime:String(ext),CurrentTransaction:{status:'Confirmed',newOnChainState:onChainState},TransactionHistory:[]};
 mps.payments.set(payment.blockchainIdentifier,payment);
 const last=attempts.at(-1);
 writeFileSync(join(jobsDir,`${id}.json`),JSON.stringify({id,nonceKey:sha256(nonce),nonce,input:inputData,inputHash:'ih',status:phase==='waiting-payment'?'awaiting_payment':'completed',phase,
  attempts,disputes,demo:{seedDefect:true,cheat:false},fields0,payment,token,response:{id,job_id:id,job_token:token},result:last?.result,resultHash:last?.resultHash}),{mode:0o600});
 return {id,token,payment};
}

test('start_job gives the buyer a job token; a replay with the same nonce and input gets the same response',async()=>{
 const nonce=newNonce();
 const first=await startJob(nonce);
 assert.equal(first.status,200);
 assert.match(first.body.job_token,/^[0-9a-f]{64}$/);
 const replay=await startJob(nonce);
 assert.deepEqual(replay.body,first.body);
});

test('RMPENTEST-2: /status shows the delivered invoice only to the holder of the job token',async()=>{
 const {id,token}=makeJob();
 const anonymous=await call(`/status?job_id=${id}`);
 assert.equal(anonymous.status,200);
 assert.equal(anonymous.body.phase,'result-confirmed');
 assert.equal(anonymous.body.result,undefined,'no invoice without the token');
 assert.deepEqual(anonymous.body.demo,{seedDefect:true,cheat:false},'demo switches stay public on purpose (disclosure)');
 assert.equal((await call(`/status?job_id=${id}`,{token})).body.result,'result-1');
 assert.equal((await call(`/status?job_id=${id}`,{token:'0'.repeat(64)})).status,401);
});

test('RMPENTEST-1: an unauthenticated /dispute changes nothing: no refund, no dispute entry',async()=>{
 const {id}=makeJob();
 const before=callsTo('/payment/authorize-refund').length;
 for(const token of [undefined,'f'.repeat(64)]){
  for(const failures of [[],[{code:'BR-DE-99'}],[{code:'BR-AE-02'},{code:'ZZZ'}]]){
   const r=await call('/dispute',{body:{jobId:id,round:1,failures},token});
   assert.equal(r.status,401,JSON.stringify(r.body));
  }
 }
 assert.equal(callsTo('/payment/authorize-refund').length,before,'no AuthorizeRefund');
 assert.equal(readJob(id).disputes.length,0,'no round was used up');
});

test('the token holder can still refuse: a non-curable defect list authorizes the refund',async()=>{
 const {id,token}=makeJob();
 const r=await call('/dispute',{body:{jobId:id,round:1,failures:[{code:'BR-DE-99',textDe:'x'}]},token});
 assert.equal(r.status,422);
 assert.equal(r.body.status,'cure-rejected');
 assert.equal(callsTo('/payment/authorize-refund').filter(c=>c.input.blockchainIdentifier===`bc-${id}`).length,1);
 assert.deepEqual((await call('/dispute',{body:{jobId:id,round:1,failures:[]},token})).body,r.body,'the round is answered from the cache');
});

test('the token holder gets the cure for the seeded BT-48 defect',async()=>{
 const {id,token}=makeJob();
 const r=await call('/dispute',{body:{jobId:id,round:1,failures:[{code:'BR-AE-02',textDe:'x'},{code:'ABN-BT48',textDe:'y'}],kositReport:'<rep/>'},token});
 assert.equal(r.status,200,JSON.stringify(r.body));
 assert.equal(r.body.status,'cure-submitted');
 assert.deepEqual(r.body.patch,{buyerVatId:'DE287654321'});
 const submitted=callsTo('/payment/submit-result').filter(c=>c.input.blockchainIdentifier===`bc-${id}`);
 assert.equal(submitted.length,1);
 const job=readJob(id);
 assert.equal(job.phase,'awaiting-result');
 assert.equal(submitted[0].input.submitResultHash,job.resultHash);
 assert.ok(job.attempts.at(-1).submittedAt>Date.now()-MIN,'the cure records when it was submitted');
});

test('ESCROW-5 (seller side): a dispute while the escrow is not Disputed never submits a result',async()=>{
 const {id,token}=makeJob({onChainState:'ResultSubmitted'});
 const r=await call('/dispute',{body:{jobId:id,round:1,failures:[{code:'BR-AE-02'}]},token});
 assert.equal(r.status,409);
 assert.equal(callsTo('/payment/submit-result').filter(c=>c.input.blockchainIdentifier===`bc-${id}`).length,0);
 assert.equal(readJob(id).disputes.length,0);
});

test('ESCROW-3: a dispute after the cure cutoff gets the refund, not a cure the buyer could not accept in time',async()=>{
 const {id,token}=makeJob({ext:Date.now()+25*MIN});
 const r=await call('/dispute',{body:{jobId:id,round:1,failures:[{code:'BR-AE-02'},{code:'ABN-BT48'}]},token});
 assert.equal(r.status,422,JSON.stringify(r.body));
 assert.equal(callsTo('/payment/submit-result').filter(c=>c.input.blockchainIdentifier===`bc-${id}`).length,0);
 assert.equal(callsTo('/payment/authorize-refund').filter(c=>c.input.blockchainIdentifier===`bc-${id}`).length,1);
});

test('ESCROW-3: the seller refunds an escrow that is still Disputed shortly before the external dispute deadline',async()=>{
 const early=makeJob({ext:Date.now()+40*MIN});
 const late=makeJob({ext:Date.now()+9*MIN});
 await rm.tick();
 const refunded=id=>callsTo('/payment/authorize-refund').filter(c=>c.input.blockchainIdentifier===`bc-${id}`).length;
 assert.equal(refunded(early.id),0,'still inside the window for a cure and its acceptance');
 assert.equal(refunded(late.id),1);
 assert.equal(readJob(late.id).phase,'refund-authorized');
 const next=await call('/dispute',{body:{jobId:late.id,round:1,failures:[{code:'BR-AE-02'}]},token:late.token});
 assert.equal(next.status,200,JSON.stringify(next.body));
 assert.equal(next.body.status,'refund-authorized','a later round gets the outcome, not a 409 that never clears');
});

test('ESCROW-3: a cure not confirmed on chain within 20 minutes is refunded',async()=>{
 const cure={attempt:2,fields:fields0,result:'result-2',resultHash:'h2',submittedAt:Date.now()-21*MIN,cure:{patch:{buyerVatId:'DE287654321'},sources:{},retransmit:false}};
 const {id}=makeJob({phase:'awaiting-result',attempts:[{attempt:1,fields:fields0,result:'result-1',resultHash:'h1'},cure],disputes:[{round:1,status:200,response:{status:'cure-submitted'}}]});
 await rm.tick();
 assert.equal(callsTo('/payment/authorize-refund').filter(c=>c.input.blockchainIdentifier===`bc-${id}`).length,1);
 assert.equal(readJob(id).phase,'refund-authorized');
});

test('ESCROW-3 / STATEMACHINE-8: a cure whose submit failed is refunded and the open round gets an answer',async()=>{
 const cure={attempt:2,fields:fields0,result:'result-2',resultHash:'h2',submittedAt:Date.now()-MIN,cure:{patch:{buyerVatId:'DE287654321'},sources:{},retransmit:false}};
 const {id,token}=makeJob({phase:'submit-pending',attempts:[{attempt:1,fields:fields0,result:'result-1',resultHash:'h1'},cure],disputes:[{round:1,receivedAt:new Date().toISOString(),failures:[{code:'BR-AE-02',textDe:''}]}]});
 assert.equal((await call('/dispute',{body:{jobId:id,round:1,failures:[]},token})).status,409,'before: requires inspection');
 await rm.tick();
 assert.equal(callsTo('/payment/authorize-refund').filter(c=>c.input.blockchainIdentifier===`bc-${id}`).length,1);
 const r=await call('/dispute',{body:{jobId:id,round:1,failures:[]},token});
 assert.equal(r.status,422);
 assert.equal(r.body.status,'cure-rejected');
});

test('STATEMACHINE-8: a submit that reached MPS before a crash is recovered, one that did not is resent',async()=>{
 const reached=makeJob({phase:'submit-pending',onChainState:'FundsLocked',chainHash:null,nextAction:{requestedAction:'SubmitResultRequested',resultHash:'h1'}});
 const lost=makeJob({phase:'submit-pending',onChainState:'FundsLocked',chainHash:null});
 await rm.tick();
 assert.equal(readJob(reached.id).phase,'awaiting-result');
 assert.equal(callsTo('/payment/submit-result').filter(c=>c.input.blockchainIdentifier===`bc-${reached.id}`).length,0);
 assert.equal(readJob(lost.id).phase,'awaiting-result');
 assert.deepEqual(callsTo('/payment/submit-result').filter(c=>c.input.blockchainIdentifier===`bc-${lost.id}`).map(c=>c.input.submitResultHash),['h1']);
 Object.assign(reached.payment,{onChainState:'ResultSubmitted',resultHash:'h1',NextAction:{requestedAction:'WaitingForExternalAction'},CurrentTransaction:{status:'Confirmed',newOnChainState:'ResultSubmitted'}});
 await rm.tick();
 assert.equal(readJob(reached.id).phase,'result-confirmed');
});

test('STATEMACHINE-8: a payment request that failed once can be retried with the same nonce',async()=>{
 const nonce=newNonce();
 mps.failNextPayment=true;
 assert.equal((await startJob(nonce)).status,500);
 const retry=await startJob(nonce);
 assert.equal(retry.status,200,JSON.stringify(retry.body));
 assert.match(retry.body.blockchainIdentifier,/^bc-/);
});

test('RMPENTEST-3: an unfunded job stops being polled after its pay-by time',async()=>{
 const {id}=makeJob({phase:'waiting-payment',onChainState:null,attempts:[],payBy:Date.now()-20*MIN,chainHash:null});
 await rm.tick();
 assert.equal(readJob(id).phase,'expired');
 const polled=()=>callsTo('/payment/resolve-blockchain-identifier').filter(c=>c.input.blockchainIdentifier===`bc-${id}`).length;
 const count=polled();
 await rm.tick();
 assert.equal(polled(),count);
});

test('STATEMACHINE-7: a torn job file neither crashes the loop nor blocks start_job',async()=>{
 writeFileSync(join(jobsDir,`${randomUUID()}.json`),'{"id":"torn","phase":"awaiting-re');
 const {id}=makeJob({phase:'awaiting-result',onChainState:'ResultSubmitted'});
 await rm.tick();
 assert.equal(readJob(id).phase,'result-confirmed','other jobs keep advancing');
 assert.equal((await startJob()).status,200);
});

test('RMPENTEST-4 / PENTEST-6: state-changing routes refuse browser requests and malformed bodies',async()=>{
 const body=JSON.stringify({identifier_from_purchaser:'zz',input_data:{}});
 assert.equal((await call('/start_job',{body,headers:{'content-type':'text/plain'}})).status,415);
 assert.equal((await call('/dispute',{body:'{}',headers:{'content-type':'text/plain'}})).status,415);
 assert.equal((await call('/start_job',{body,headers:{origin:'https://evil.example'}})).status,403);
 assert.equal((await call('/dispute',{body:'{}',headers:{'sec-fetch-site':'cross-site'}})).status,403);
 assert.equal((await call('/start_job',{body:'{"identifier_from'})).status,400);
 assert.equal((await call('/start_job',{body:'null'})).status,400);
 assert.equal((await call('/start_job',{body})).status,400,'Node fetch from the buyer still gets through');
});

test('the server binds loopback only (guard against the part-1 PENTEST-1 slip)',()=>{
 assert.match(readFileSync(new URL('./server.mjs',import.meta.url),'utf8'),/createServer\(handler\)\.listen\(port,'127\.0\.0\.1'/);
});

// Last: it uses up the window for new jobs.
test('RMPENTEST-3 / PENTEST-4: /start_job limits new jobs; replays of a known nonce still answer',async()=>{
 const nonce=newNonce();
 assert.equal((await startJob(nonce)).status,200);
 let created=0,limited;
 for(;;){
  const r=await startJob();
  if(r.status===429){limited=r;break;}
  assert.equal(r.status,200);assert.ok(++created<=10,'at most 10 new jobs per 10 minutes');
 }
 assert.match(limited.headers.get('retry-after'),/^\d+$/);
 const payments=callsTo('/payment').length;
 assert.equal((await startJob()).status,429);
 assert.equal(callsTo('/payment').length,payments,'a refused job writes nothing to MPS');
 assert.equal((await startJob(nonce)).status,200);
});
