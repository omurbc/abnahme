import {test} from 'node:test';
import assert from 'node:assert/strict';
import {taskHash,purchasePayload,createPaidAdapter,confirmedState,USDM} from './paid-task.mjs';
const registration={walletId:'seller-wallet',agentIdentifier:'a'.repeat(80),supportedPaymentSourceIndex:0};
const target={coworkerId:'coworker',organizationId:null};
const task={id:'task',coworkerId:'coworker',organizationId:null};
const core={get:async()=>({data:task})};
const payment={sellerReturnAddress:null,forceLayer:null,PaymentSource:{network:'Preprod',paymentSourceType:'Web3CardanoV2',smartContractAddress:'addr_test1contract',policyId:'a'.repeat(56)},SmartContractWallet:{id:'seller-wallet',walletVkey:'b'.repeat(56)},RequestedFunds:[{amount:'1000000',unit:USDM}],agentIdentifier:registration.agentIdentifier,blockchainIdentifier:'signed',inputHash:taskHash('abc'),payByTime:String(Date.now()+100000),submitResultTime:String(Date.now()+200000),unlockTime:'9999999999999',externalDisputeUnlockTime:'9999999999999'};
test('Task compatibility hashes exact UTF-8 bytes without JSON escapes or nonce',()=>{
 assert.equal(taskHash('abc'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
 assert.notEqual(taskHash('a\nb'),taskHash('a\\nb'));
});
test('signed fields preserved and unsupported signed override rejected',()=>{
 const payload=purchasePayload(payment,'01020304050607',registration);
 assert.equal(payload.blockchainIdentifier,payment.blockchainIdentifier);
 assert.equal(payload.unlockTime,payment.unlockTime);
 assert.throws(()=>purchasePayload({...payment,forceLayer:'L1'},'nonce',registration),/cannot preserve/);
 assert.throws(()=>purchasePayload({...payment,sellerReturnAddress:'addr_test1seller'},'nonce',registration),/cannot preserve/);
 assert.throws(()=>purchasePayload({...payment,SmartContractWallet:{id:'other'}},'nonce',registration),/differs/);
});
test('uncertain purchase never reposted',async()=>{
 let posts=0;const adapter=await createPaidAdapter({target,registration,save:async()=>{},answer:async()=>{throw Error('unexpected model')},core:{...core,post:async()=>{posts++;throw Error('timeout')}}});
 const state=await adapter.advance(task,{input:'abc',paid:{stage:'purchase-pending'}});
 assert.equal(state.paid.stage,'awaiting-escrow');  // MPS FundsLocked, not a second event, decides whether the purchase arrived
 assert.equal(posts,0);
});
test('unconfirmed escrow does not invoke model',async()=>{
 let sends=0;const adapter=await createPaidAdapter({target,core,registration,save:async()=>{},answer:async()=>{sends++;},mps:async()=>({...payment,onChainState:'FundsLocked',CurrentTransaction:{status:'Pending'}})});
 const state=await adapter.advance(task,{input:'abc',paid:{stage:'awaiting-escrow',payment}});
 assert.equal(sends,0);assert.equal(state.paid.stage,'awaiting-escrow');
});
test('expired deadline prevents model after confirmed read',async()=>{
 let sends=0;const expired={...payment,submitResultTime:'1'};
 const adapter=await createPaidAdapter({target,core,registration,save:async()=>{},answer:async()=>{sends++;},mps:async()=>({...expired,onChainState:'FundsLocked',CurrentTransaction:{status:'Confirmed',newOnChainState:'FundsLocked'}})});
 const state=await adapter.advance(task,{input:'abc',paid:{stage:'awaiting-escrow',payment:expired}});
 assert.equal(sends,0);assert.equal(state.paid.stage,'gate-failed');assert.match(state.paid.error,/Frist für das Ergebnis/);
});
test('failed answer after FundsLocked ends in gate-failed and FAILED, never model-pending or submit',async()=>{
 const posts=[],calls=[];const locked={...payment,onChainState:'FundsLocked',CurrentTransaction:{status:'Confirmed',newOnChainState:'FundsLocked'}};
 const adapter=await createPaidAdapter({target,registration,save:async()=>{},answer:async()=>{throw Error('§ 14c duplicate')},
  core:{...core,post:async(path,body)=>{posts.push(body);return {data:{id:'event'}}}},mps:async path=>{calls.push(path);return locked}});
 let state=await adapter.advance(task,{input:'abc',paid:{stage:'awaiting-escrow',payment}});
 assert.equal(state.paid.stage,'gate-failed');assert.match(state.paid.error,/14c/);
 state=await adapter.advance(task,state);
 assert.equal(state.paid.stage,'failed');assert.equal(state.phase,'failed');
 assert.deepEqual(posts.map(b=>b.status),['FAILED']);assert.match(posts[0].comment,/14c/);
 assert.equal(calls.includes('/api/v1/payment/submit-result'),false);
 state=await adapter.advance(task,state);assert.equal(posts.length,1);
});

test('confirmed history proves lock when CurrentTransaction is absent',()=>{
 assert.equal(confirmedState({CurrentTransaction:null,TransactionHistory:[{status:'Confirmed',newOnChainState:'FundsLocked'}]},'FundsLocked'),true);
 assert.equal(confirmedState({CurrentTransaction:null,TransactionHistory:[{status:'Confirmed',newOnChainState:'ResultSubmitted'}]},'FundsLocked'),false);
});
test('successful quote survives later payload rejection',async()=>{
 let saved; const adapter=await createPaidAdapter({target,core,registration,save:async(_,s)=>{saved=s},answer:async()=>{},mps:async()=>({...payment,forceLayer:'L1'})});
 const state=await adapter.advance(task,{input:'abc'});
 assert.equal(saved.paid.payment.blockchainIdentifier,'signed');
 assert.equal(state.paid.stage,'terms-saved');
 await assert.rejects(()=>adapter.advance(task,state),/cannot preserve/);
});

test('running MPS legacy response without unsigned forceLayer is supported',()=>{const older={...payment};delete older.forceLayer;assert.equal(purchasePayload(older,'nonce',registration).blockchainIdentifier,'signed');});

test('unrelated confirmed transaction cannot prove escrow',()=>{assert.equal(confirmedState({CurrentTransaction:{status:'Confirmed',newOnChainState:'Withdrawn'}},'FundsLocked'),false)});

test('paid execution rejects another Workspace or Coworker before any saved state or payment write',async()=>{
 let writes=0;
 const target={coworkerId:'event-coworker',organizationId:'event-organization'};
 const adapter=await createPaidAdapter({target,registration,save:async()=>{writes++;},answer:async()=>{},mps:async()=>{writes++;return payment;}});
 for(const task of [
  {id:'task',coworkerId:'event-coworker',organizationId:null},
  {id:'task',coworkerId:'event-coworker',organizationId:'other-organization'},
  {id:'task',coworkerId:'other-coworker',organizationId:'event-organization'},
 ])await assert.rejects(adapter.advance(task,{input:'abc'}),/configured Coworker and Workspace/);
 assert.equal(writes,0);
});

// Regression tests for the audit findings. They write .local/<task>.txt, so they run in a temporary cwd.
const sandbox=async()=>{const {mkdtempSync,mkdirSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');process.chdir(mkdtempSync(join(tmpdir(),'paid-')));mkdirSync('.local');};
const lockedPayment={...payment,onChainState:'FundsLocked',CurrentTransaction:{status:'Confirmed',newOnChainState:'FundsLocked'}};
function recorder(statuses={}){const posts=[];return {posts,core:{get:async()=>({data:{...task,status:statuses.status??'RUNNING'}}),post:async(path,body)=>{posts.push(body);return {data:{id:`event${posts.length}`}}}}};}
async function drive(adapter,state,n=4){for(let i=0;i<n;i++)state=await adapter.advance(task,state);return state;}
test('QA-4: an escrow that is not funded by payByTime plus grace posts FAILED once and names the credits',async()=>{
 const {posts,core}=recorder();const late={...payment,payByTime:String(Date.now()-4*60*1000)};
 const adapter=await createPaidAdapter({target,registration,core,save:async()=>{},answer:async()=>{throw Error('unexpected model')},mps:async()=>({...late,onChainState:null})});
 const state=await drive(adapter,{input:'abc',paid:{stage:'awaiting-escrow',payment:late,payload:{}}});
 assert.equal(state.paid.stage,'failed');assert.deepEqual(posts.map(b=>b.status),['FAILED']);
 assert.match(posts[0].comment,/nicht bestätigt/);assert.match(posts[0].comment,/Credits/);
 const fresh={...payment,payByTime:String(Date.now()-60*1000)};
 const waiting=await createPaidAdapter({target,registration,core,save:async()=>{},answer:async()=>{},mps:async()=>({...fresh,onChainState:null})});
 assert.equal((await waiting.advance(task,{input:'abc',paid:{stage:'awaiting-escrow',payment:fresh}})).paid.stage,'awaiting-escrow');
});
test('QA-4: a quote that expired before the purchase event fails free, exactly once, without posting a payment',async()=>{
 const {posts,core}=recorder();const expired={...payment,payByTime:'1'};
 const adapter=await createPaidAdapter({target,registration,core,save:async()=>{},answer:async()=>{},mps:async()=>expired});
 const state=await drive(adapter,{input:'abc',paid:{stage:'terms-saved',payment:expired,nonce:'n'}});
 assert.equal(state.paid.stage,'failed');assert.equal(posts.some(b=>b.masumiPayment),false);
 assert.deepEqual(posts.map(b=>b.status),['FAILED']);assert.match(posts[0].comment,/nichts berechnet/);assert.doesNotMatch(posts[0].comment,/Credits/);
});
test('QA-4: an MPS error at quote time, or a restart at terms-pending, fails free exactly once',async()=>{
 for(const start of [{input:'abc'},{input:'abc',paid:{stage:'terms-pending',nonce:'n'}}]){
  const {posts,core}=recorder();
  const adapter=await createPaidAdapter({target,registration,core,save:async()=>{},answer:async()=>{},mps:async()=>{throw new Error('fetch failed')}});
  let state=start;for(let i=0;i<4;i++)state=await adapter.advance(task,state).catch(e=>{throw new Error(`advance threw: ${e.message}`)});
  assert.equal(state.paid.stage,'failed');assert.deepEqual(posts.map(b=>b.status),['FAILED']);assert.match(posts[0].comment,/nichts berechnet/);
 }
});
test('QA-3/QA-13: the purchase comment is German and a failure after FundsLocked names the credits',async()=>{
 await sandbox();const {posts,core}=recorder();
 const adapter=await createPaidAdapter({target,registration,core,save:async()=>{},answer:async()=>{throw Error('Versand fehlgeschlagen (nichts versendet)')},mps:async path=>path==='/api/v1/payment'?payment:lockedPayment});
 const state=await drive(adapter,{input:'abc',paid:{stage:'terms-saved',payment,nonce:'n'}});
 assert.equal(state.paid.stage,'failed');assert.match(posts[0].comment,/Zahlung angefordert/);
 assert.equal(posts[1].status,'FAILED');assert.match(posts[1].comment,/Credits/);
});
test('QA-2: a paid model-pending after a restart is resolved through recover(): sent result, retry, or FAILED',async()=>{
 await sandbox();
 const run=async found=>{const {posts,core}=recorder();let sends=0;
  const adapter=await createPaidAdapter({target,registration,core,save:async()=>{},answer:async()=>{sends++;return 'neu'},recover:async t=>{assert.equal(t.id,'task');return found},mps:async()=>lockedPayment});
  return {state:await adapter.advance(task,{input:'abc',paid:{stage:'model-pending',payment,payload:{}}}),posts,sends};};
 const sent=await run({result:'Versendet: XRechnung X'});
 assert.equal(sent.state.paid.stage,'result-saved');assert.equal(sent.state.paid.result,'Versendet: XRechnung X');assert.equal(sent.sends,0);
 assert.equal((await run({retry:true})).state.paid.stage,'awaiting-escrow');
 const unclear=await run({error:'Versand mit ungeklärtem Ausgang. Bitte Postfach prüfen.'});
 assert.equal(unclear.state.paid.stage,'gate-failed');assert.match(unclear.state.paid.error,/Postfach prüfen/);
});
test('QA-2: submit-pending, complete-pending and fail-pending are reconciled with MPS and the Core Task status',async()=>{
 await sandbox();const result='r',resultHash=taskHash(result);
 const submitted={...payment,resultHash,onChainState:'ResultSubmitted',CurrentTransaction:{status:'Confirmed',newOnChainState:'ResultSubmitted'}};
 const cases=[
  ['submit-pending','RUNNING','awaiting-result',[]],
  ['complete-pending','COMPLETED','awaiting-withdrawal',[]],
  ['complete-pending','RUNNING','awaiting-withdrawal',['COMPLETED']],
  ['fail-pending','FAILED','failed',[]],
  ['fail-pending','RUNNING','failed',['FAILED']],
 ];
 for(const [stage,status,expected,statuses] of cases){
  const {posts,core}=recorder({status});const calls=[];
  const adapter=await createPaidAdapter({target,registration,core,save:async()=>{},answer:async()=>{},mps:async path=>{calls.push(path);return submitted}});
  let state={input:'abc',paid:{stage,payment,payload:{},result,resultHash,error:'x'}};
  for(let i=0;i<3&&state.paid.stage!==expected;i++)state=await adapter.advance(task,state);
  assert.equal(state.paid.stage,expected,`${stage}/${status}`);assert.deepEqual(posts.map(b=>b.status),statuses,`${stage}/${status}`);
  assert.equal(calls.includes('/api/v1/payment/submit-result'),false);
 }
});
