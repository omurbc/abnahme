// refund-repair.mjs (#1327 workaround) against a fake MPS admin API and a fake Blockfrost behind one fetch: it repairs only
// a RefundAuthorized purchase with a stale resultHash whose own unspent escrow output on chain is RefundAuthorized with an
// empty result_hash, applies only what the preview derived, never forces, and is idempotent.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {repairStuckRefunds,repairStuckWithdrawals} from './refund-repair.mjs';

const ADMIN='sentinel-admin-key',BF='sentinel-blockfrost-key',CONTRACT='addr_test1wcontract',BUYER='addr_test1qbuyer';
const hex=c=>c.repeat(64);
// V2 datum: 19 fields, 10 input_hash, 11 result_hash, 18 state (constructor 5 = RefundAuthorized).
const datum=({inputHash,resultHash='',state=5})=>({constructor:0,fields:Array.from({length:19},(_,i)=>i===10?{bytes:inputHash}:i===11?{bytes:resultHash}:i===18?{constructor:state,fields:[]}:{bytes:''})});

function stuck(n,over={}){
 const tx=n.toString(16).padStart(64,'0');
 return {id:`purchase-${n}`,blockchainIdentifier:`bcid-${n}`,inputHash:'a'+n.toString(16).padStart(63,'0'),resultHash:hex('9'),onChainState:'RefundAuthorized',
  NextAction:{requestedAction:'WaitingForExternalAction',errorType:null},CurrentTransaction:{txHash:tx,status:'Confirmed',previousOnChainState:'RefundAuthorized',newOnChainState:'RefundAuthorized'},
  PaymentSource:{smartContractAddress:CONTRACT},...over};
}
// The chain for a purchase: its AuthorizeRefund tx has a buyer change output and the escrow output with the datum.
// consumed 'absent': Blockfrost did not report the field at all.
const chainFor=(p,{datumOver={},consumed=null,address=CONTRACT}={})=>({[p.CurrentTransaction.txHash]:[{address:BUYER,output_index:0,data_hash:null,consumed_by_tx:null},{address,output_index:1,data_hash:`dh-${p.id}`,...consumed==='absent'?{}:{consumed_by_tx:consumed},datum:datum({inputHash:p.inputHash,...datumOver})}]});

function world(purchases,{chain=Object.assign({},...purchases.map(p=>chainFor(p))),preview=()=>({}),blockfrostDown=new Set(),beforePreview=()=>{}}={}){
 const calls=[];
 const ok=data=>Response.json({status:'success',data});
 const fetchImpl=async(url,init={})=>{
  const u=new URL(url),body=init.body?JSON.parse(init.body):undefined;
  calls.push({host:u.host,path:u.pathname,query:Object.fromEntries(u.searchParams),method:init.method??'GET',headers:JSON.stringify(init.headers??{}),body});
  if(u.host==='cardano-preprod.blockfrost.io'){
   if(init.headers?.project_id!==BF)return Response.json({error:'Forbidden'},{status:403});
   const [,txHash]=u.pathname.match(/\/txs\/([^/]+)\/utxos$/)??[];
   if(txHash){if(blockfrostDown.has(txHash))return Response.json({error:'Internal'},{status:500});if(!chain[txHash])return Response.json({error:'Not Found'},{status:404});return Response.json({hash:txHash,inputs:[],outputs:chain[txHash].map(({datum,...o})=>o)});}
   const [,dataHash]=u.pathname.match(/\/scripts\/datum\/(.+)$/)??[];
   const out=Object.values(chain).flat().find(o=>o.data_hash===dataHash);
   return out?Response.json({json_value:out.datum}):Response.json({error:'Not Found'},{status:404});
  }
  if(init.headers?.token!==ADMIN)return Response.json({status:'error',error:{message:'Unauthorized'}},{status:401});
  const path=u.pathname.replace('/api/v1','');
  if(path==='/purchase'&&(init.method??'GET')==='GET'){
   const q=Object.fromEntries(u.searchParams);
   // MPS 0.29.0: no source type filter lists Web3CardanoV1 only; the cursor page starts with the cursor row (Prisma).
   let list=q.filterPaymentSourceType==='Web3CardanoV2'&&q.network==='Preprod'?purchases.filter(p=>!q.filterOnChainState||p.onChainState===q.filterOnChainState):[];
   if(q.cursorId)list=list.slice(list.findIndex(p=>p.id===q.cursorId));
   return ok({Purchases:structuredClone(list.slice(0,Number(q.limit??10)))});
  }
  const p=purchases.find(x=>x.blockchainIdentifier===body?.blockchainIdentifier);
  if(!p)return Response.json({status:'error',error:{message:'not found'}},{status:404});
  const version=`v-${p.id}-${p.resultHash}`;
  if(path==='/purchase/resolve-blockchain-identifier')return ok(structuredClone(p));
  if(path==='/request-repair/preview'){
   beforePreview(p);
   const out=chain[body.txHash]?.find(o=>o.address===CONTRACT);
   return ok({txHash:body.txHash,outputIndex:out.output_index,derivedOnChainState:'RefundAuthorized',resultHash:out.datum.fields[11].bytes||null,currentOnChainState:p.onChainState,requestVersion:version,...preview(p)});
  }
  if(path==='/request-repair'){
   if(body.requestVersion!==version)return Response.json({status:'error',error:{message:'Request changed after preview; preview the repair again'}},{status:409});
   p.resultHash=null;
   return ok({requestId:p.id,txHash:body.txHash,transactionId:'t1',previousOnChainState:'RefundAuthorized',newOnChainState:'RefundAuthorized',forced:false});
  }
  return Response.json({status:'error'},{status:404});
 };
 const lines=[];
 const pass=()=>repairStuckRefunds({url:'http://mps.test',adminKey:ADMIN,blockfrostKey:BF,fetchImpl,log:l=>lines.push(l)});
 return {calls,lines,pass,writes:()=>calls.filter(c=>c.path==='/api/v1/request-repair'),previews:()=>calls.filter(c=>c.path==='/api/v1/request-repair/preview')};
}

test('#1327: a stale resultHash over an empty on-chain result_hash is previewed, then repaired with the preview\'s requestVersion, never forced; a second pass does nothing',async()=>{
 const p=stuck(1),w=world([p,stuck(2,{resultHash:null})]);
 const r=await w.pass();
 assert.deepEqual(r.repaired,['purchase-1']);
 const list=w.calls.find(c=>c.path==='/api/v1/purchase');
 assert.equal(list.query.filterPaymentSourceType,'Web3CardanoV2');assert.equal(list.query.filterOnChainState,'RefundAuthorized');assert.equal(list.query.network,'Preprod');
 assert.equal(w.previews().length,1);
 const [apply]=w.writes();
 assert.deepEqual(apply.body,{kind:'Purchase',network:'Preprod',blockchainIdentifier:'bcid-1',txHash:p.CurrentTransaction.txHash,requestVersion:'v-purchase-1-'+hex('9')});
 assert.equal('force' in apply.body,false);
 assert.equal(w.lines.filter(l=>/^repaired purchase-1/.test(l)).length,1);
 for(const c of w.calls){
  if(c.host==='cardano-preprod.blockfrost.io')assert.doesNotMatch(c.headers,new RegExp(ADMIN),'ADMIN_KEY never goes to Blockfrost');
  else assert.doesNotMatch(c.headers,new RegExp(BF),'the Blockfrost key never goes to MPS');
 }
 for(const l of w.lines)assert.doesNotMatch(l,new RegExp(`${ADMIN}|${BF}`));
 const again=await w.pass();
 assert.deepEqual(again.repaired,[]);assert.equal(w.writes().length,1);assert.equal(w.previews().length,1);
});

test('the chain decides first: a datum with a result_hash, another state, a spent output or no own output is never previewed or repaired',async()=>{
 const cases={
  'result_hash set':{datumOver:{resultHash:hex('9')}},
  'state Disputed':{datumOver:{state:3}},
  'output spent':{consumed:hex('e')},
  'spent state unknown':{consumed:'absent'},
  'no own output':{datumOver:{inputHash:hex('f')}},
  'other address':{address:'addr_test1wother'},
 };
 for(const [name,over] of Object.entries(cases)){
  const p=stuck(3),w=world([p],{chain:chainFor(p,over)});
  const r=await w.pass();
  assert.deepEqual(r.repaired,[],name);assert.deepEqual(r.skipped,['purchase-3'],name);
  assert.equal(w.previews().length+w.writes().length,0,name);
  assert.equal(w.lines.filter(l=>/^skip purchase-3/.test(l)).length,1,name);
 }
});

test('a preview that derives another state or a result hash is not applied',async()=>{
 for(const preview of [()=>({derivedOnChainState:'Disputed'}),()=>({resultHash:hex('9')})]){
  const w=world([stuck(4)],{preview});
  const r=await w.pass();
  assert.deepEqual(r.repaired,[]);assert.equal(w.previews().length,1);assert.equal(w.writes().length,0);
 }
});

test('only the stuck shape is touched: already repaired, MPS busy or in error, or a pending current tx are left alone without asking the chain',async()=>{
 const w=world([
  stuck(5,{resultHash:null}),
  stuck(6,{NextAction:{requestedAction:'WithdrawRefundRequested',errorType:null}}),
  stuck(7,{NextAction:{requestedAction:'WaitingForExternalAction',errorType:'NetworkError'}}),
  stuck(8,{CurrentTransaction:{...stuck(8).CurrentTransaction,status:'Pending'}}),
 ]);
 const r=await w.pass();
 assert.deepEqual(r.repaired,[]);assert.deepEqual(r.skipped,['purchase-6','purchase-7','purchase-8']);
 assert.equal(w.calls.filter(c=>c.host==='cardano-preprod.blockfrost.io').length,0);
 assert.equal(w.previews().length+w.writes().length,0);
});

test('pages through more than 100 RefundAuthorized purchases (the cursor row is repeated) and repairs each stuck one once',async()=>{
 const many=Array.from({length:150},(_,i)=>stuck(i+10,{resultHash:i===120||i===99?hex('9'):null}));
 const w=world(many);
 const r=await w.pass();
 assert.deepEqual(r.repaired.sort(),['purchase-109','purchase-130']);
 assert.equal(r.checked,150);
 assert.ok(w.calls.some(c=>c.query.cursorId));
 assert.equal(w.writes().length,2);
});

test('one failing purchase (Blockfrost 500, a changed request) is logged and does not stop the others',async()=>{
 const a=stuck(20),b=stuck(21),c=stuck(22);
 const w=world([a,b,c],{blockfrostDown:new Set([a.CurrentTransaction.txHash]),preview:p=>p.id==='purchase-21'?{requestVersion:'stale'}:{}});
 const r=await w.pass();
 assert.deepEqual(r.repaired,['purchase-22']);assert.deepEqual(r.failed,['purchase-20','purchase-21']);
 assert.equal(w.lines.filter(l=>/^error purchase-2[01]/.test(l)).length,2);
});

test('refuses to run without the admin profile',async()=>{
 await assert.rejects(repairStuckRefunds({url:'http://mps.test',adminKey:undefined,blockfrostKey:BF,fetchImpl:async()=>{throw new Error('no call expected');}}),/mps-admin\.env/);
});

// LB2-1 (repairStuckWithdrawals): a V2 seller payment that MPS left in WaitingForManualAction after the buyer's AuthorizeWithdrawal.
// The fake MPS mirrors 0.29.0: GET /payment has no history unless includeHistory=true, resolve-blockchain-identifier wants
// includeHistory as a string, request-repair links the target tx into the history, and error-state-recovery repoints the payment
// to the newest Confirmed tx of its history (the spent cure tx, unless request-repair linked the AuthorizeWithdrawal first).
const NOW=Date.parse('2026-10-30T18:00:00Z'),MIN=60000,ago=m=>new Date(NOW-m*MIN).toISOString();
function stuckPay(n,over={}){
 const aw=n.toString(16).padStart(64,'a'),cure=n.toString(16).padStart(64,'c');
 return {id:`payment-${n}`,blockchainIdentifier:`pay-bcid-${n}`,inputHash:'b'+n.toString(16).padStart(63,'0'),resultHash:hex('7'),onChainState:'WithdrawAuthorized',
  updatedAt:ago(100),nextActionOrOnChainStateOrResultLastChangedAt:ago(100),
  NextAction:{requestedAction:'WaitingForManualAction',errorType:'Unknown',errorNote:'Unexpected state change detected. Possible a action was executed externally'},
  CurrentTransaction:{id:`tx-aw-${n}`,txHash:aw,status:'Confirmed',previousOnChainState:'Disputed',newOnChainState:'WithdrawAuthorized',createdAt:ago(100)},
  TransactionHistory:[{id:`tx-cure-${n}`,txHash:cure,status:'Confirmed',previousOnChainState:'Disputed',newOnChainState:'Disputed',createdAt:ago(102)}],
  PaymentSource:{smartContractAddress:CONTRACT},...over};
}
// The AuthorizeWithdrawal of a batch: a sibling escrow at #0, this payment's escrow at #1 (state 4 = WithdrawAuthorized).
const awChainFor=(p,{datumOver={},consumed=null,address=CONTRACT}={})=>({[p.CurrentTransaction.txHash]:[
 {address:CONTRACT,output_index:0,data_hash:`dh-sib-${p.id}`,consumed_by_tx:hex('d'),datum:datum({inputHash:hex('e'),resultHash:hex('6'),state:4})},
 {address,output_index:1,data_hash:`dh-${p.id}`,...consumed==='absent'?{}:{consumed_by_tx:consumed},datum:datum({inputHash:p.inputHash,resultHash:hex('7'),state:4,...datumOver})}]});
const STATES=['FundsLocked','ResultSubmitted','RefundRequested','Disputed','WithdrawAuthorized','RefundAuthorized'];

function payWorld(payments,{chain=Object.assign({},...payments.map(p=>awChainFor(p))),preview=()=>({}),blockfrostDown=new Set(),beforeRecovery=()=>{},beforePreview=()=>{}}={}){
 const calls=[];
 const ok=data=>Response.json({status:'success',data});
 const fail=(status,message)=>Response.json({status:'error',error:{message}},{status});
 const bump=p=>{p.updatedAt=new Date(Date.parse(p.updatedAt)+1000).toISOString();};
 const version=p=>`v-${p.id}-${p.updatedAt}-${p.CurrentTransaction?.id}-${p.resultHash}`;
 const ownOut=(txHash,p)=>chain[txHash]?.find(o=>o.address===CONTRACT&&o.datum.fields[10].bytes===p.inputHash);
 const fetchImpl=async(url,init={})=>{
  const u=new URL(url),body=init.body?JSON.parse(init.body):undefined;
  calls.push({host:u.host,path:u.pathname,query:Object.fromEntries(u.searchParams),method:init.method??'GET',headers:JSON.stringify(init.headers??{}),body});
  if(u.host==='cardano-preprod.blockfrost.io'){
   if(init.headers?.project_id!==BF)return Response.json({error:'Forbidden'},{status:403});
   const [,txHash]=u.pathname.match(/\/txs\/([^/]+)\/utxos$/)??[];
   if(txHash){if(blockfrostDown.has(txHash))return Response.json({error:'Internal'},{status:500});if(!chain[txHash])return Response.json({error:'Not Found'},{status:404});return Response.json({hash:txHash,inputs:[],outputs:chain[txHash].map(({datum,...o})=>o)});}
   const [,dataHash]=u.pathname.match(/\/scripts\/datum\/(.+)$/)??[];
   const out=Object.values(chain).flat().find(o=>o.data_hash===dataHash);
   return out?Response.json({json_value:out.datum}):Response.json({error:'Not Found'},{status:404});
  }
  if(init.headers?.token!==ADMIN)return fail(401,'Unauthorized');
  const path=u.pathname.replace('/api/v1','');
  if(path==='/payment'&&(init.method??'GET')==='GET'){
   const q=Object.fromEntries(u.searchParams);
   let list=q.filterPaymentSourceType==='Web3CardanoV2'&&q.network==='Preprod'?payments.filter(p=>!q.filterOnChainState||p.onChainState===q.filterOnChainState):[];
   if(q.cursorId)list=list.slice(list.findIndex(p=>p.id===q.cursorId));
   return ok({Payments:structuredClone(list.slice(0,Number(q.limit??10))).map(p=>q.includeHistory==='true'?p:{...p,TransactionHistory:null})});
  }
  const p=payments.find(x=>x.blockchainIdentifier===body?.blockchainIdentifier);
  if(!p)return fail(404,'not found');
  if(path==='/payment/resolve-blockchain-identifier'){
   if(body.includeHistory!==undefined&&typeof body.includeHistory!=='string')return fail(400,'includeHistory: Invalid input: expected string, received boolean');
   const r=structuredClone(p);
   r.TransactionHistory=body.includeHistory==='true'?r.TransactionHistory.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)):null;
   return ok(r);
  }
  if(path==='/request-repair/preview'){
   beforePreview(p);
   const out=ownOut(body.txHash,p);
   return ok({txHash:body.txHash,outputIndex:out.output_index,derivedOnChainState:STATES[out.datum.fields[18].constructor],resultHash:out.datum.fields[11].bytes||null,currentOnChainState:p.onChainState,requestVersion:version(p),...preview(p)});
  }
  if(path==='/request-repair'){
   if(body.requestVersion!==version(p))return fail(409,'Request changed after preview; preview the repair again');
   const out=ownOut(body.txHash,p);
   p.resultHash=out.datum.fields[11].bytes||null;
   Object.assign(p.CurrentTransaction,{previousOnChainState:p.onChainState,newOnChainState:'WithdrawAuthorized'});
   if(!p.TransactionHistory.some(t=>t.id===p.CurrentTransaction.id))p.TransactionHistory.push(structuredClone(p.CurrentTransaction));
   bump(p);
   return ok({requestId:p.id,txHash:body.txHash,transactionId:p.CurrentTransaction.id,previousOnChainState:'WithdrawAuthorized',newOnChainState:'WithdrawAuthorized',forced:false});
  }
  if(path==='/payment/error-state-recovery'){
   beforeRecovery(p);
   if(body.updatedAt!==p.updatedAt)return fail(404,'Payment request not found with the provided blockchain identifier or it was changed');
   if(p.NextAction.requestedAction!=='WaitingForManualAction')return fail(400,'Payment request is not in WaitingForManualAction state');
   if(!p.NextAction.errorType)return fail(400,'Payment request is not in an error state. No error to clear.');
   const newest=[...p.TransactionHistory].filter(t=>t.status==='Confirmed'&&t.txHash).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
   if(newest)p.CurrentTransaction=structuredClone(newest);
   p.NextAction=body.retryPreviousAction?{requestedAction:'SubmitResultRequested',errorType:null}:{requestedAction:'WaitingForExternalAction',errorType:null,errorNote:null};
   bump(p);p.nextActionOrOnChainStateOrResultLastChangedAt=new Date(NOW).toISOString();
   const {TransactionHistory,...rest}=structuredClone(p);
   return ok(rest);
  }
  return fail(404,'no route');
 };
 const lines=[];
 const pass=(o={})=>repairStuckWithdrawals({url:'http://mps.test',adminKey:ADMIN,blockfrostKey:BF,fetchImpl,log:l=>lines.push(l),now:()=>NOW,...o});
 const at=path=>calls.filter(c=>c.path===`/api/v1${path}`);
 return {calls,lines,pass,at,writes:()=>[...at('/request-repair'),...at('/payment/error-state-recovery')],chainCalls:()=>calls.filter(c=>c.host==='cardano-preprod.blockfrost.io')};
}

test('LB2-1: WaitingForManualAction over an unspent WithdrawAuthorized escrow: preview, repair, re-read, clear without retry; the AuthorizeWithdrawal stays current; a second pass does nothing',async()=>{
 const p=stuckPay(1),w=payWorld([p,stuckPay(2,{NextAction:{requestedAction:'WithdrawRequested',errorType:null},nextActionOrOnChainStateOrResultLastChangedAt:ago(1)})]);
 const aw=p.CurrentTransaction.txHash,before=p.updatedAt;
 const r=await w.pass();
 assert.deepEqual(r,{checked:2,repaired:['payment-1'],skipped:[],failed:[]});
 const [list]=w.at('/payment');
 assert.equal(list.query.filterPaymentSourceType,'Web3CardanoV2');assert.equal(list.query.filterOnChainState,'WithdrawAuthorized');assert.equal(list.query.network,'Preprod');
 assert.deepEqual(w.calls.filter(c=>c.method==='POST').map(c=>c.path),['/api/v1/request-repair/preview','/api/v1/payment/resolve-blockchain-identifier','/api/v1/request-repair','/api/v1/payment/resolve-blockchain-identifier','/api/v1/payment/error-state-recovery']);
 const [preview]=w.at('/request-repair/preview'),[repair]=w.at('/request-repair'),[recover]=w.at('/payment/error-state-recovery');
 assert.deepEqual(preview.body,{kind:'Payment',network:'Preprod',blockchainIdentifier:'pay-bcid-1',txHash:aw});
 assert.deepEqual(repair.body,{kind:'Payment',network:'Preprod',blockchainIdentifier:'pay-bcid-1',txHash:aw,requestVersion:`v-payment-1-${before}-tx-aw-1-${hex('7')}`});
 assert.deepEqual(recover.body,{blockchainIdentifier:'pay-bcid-1',network:'Preprod',updatedAt:new Date(Date.parse(before)+1000).toISOString()},'fresh updatedAt, no retryPreviousAction');
 assert.equal(p.NextAction.requestedAction,'WaitingForExternalAction');
 assert.equal(p.CurrentTransaction.txHash,aw,'not repointed to the spent cure tx');
 assert.equal(w.lines.filter(l=>/^repaired payment-1/.test(l)).length,1);
 for(const c of w.calls){
  if(c.host==='cardano-preprod.blockfrost.io')assert.doesNotMatch(c.headers,new RegExp(ADMIN));
  else assert.doesNotMatch(c.headers,new RegExp(BF));
 }
 for(const l of w.lines)assert.doesNotMatch(l,new RegExp(`${ADMIN}|${BF}`));
 const again=await w.pass();
 assert.deepEqual(again.repaired,[]);assert.equal(w.writes().length,2);
});

test('LB2-1: if error-state-recovery would still repoint to another tx after the repair, it is not called',async()=>{
 const p=stuckPay(3);
 p.TransactionHistory.push({id:'tx-odd',txHash:hex('f'),status:'Confirmed',previousOnChainState:'Disputed',newOnChainState:'Disputed',createdAt:ago(50)});
 const w=payWorld([p]);
 const r=await w.pass();
 assert.deepEqual(r.failed,['payment-3']);
 assert.equal(w.at('/payment/error-state-recovery').length,0);
 assert.equal(p.NextAction.requestedAction,'WaitingForManualAction');
 assert.equal(w.lines.filter(l=>/^error payment-3/.test(l)).length,1);
});

test('LB2-1: the chain decides first: another state, another or empty result_hash, a spent output or no own output is never previewed or repaired',async()=>{
 const cases={
  'state Disputed':{datumOver:{state:3}},
  'state RefundAuthorized':{datumOver:{state:5}},
  'other result_hash':{datumOver:{resultHash:hex('8')}},
  'empty result_hash':{datumOver:{resultHash:''}},
  'output spent':{consumed:hex('e')},
  'spent state unknown':{consumed:'absent'},
  'no own output':{datumOver:{inputHash:hex('f')}},
  'other address':{address:'addr_test1wother'},
 };
 for(const [name,over] of Object.entries(cases)){
  const p=stuckPay(4),w=payWorld([p],{chain:awChainFor(p,over)});
  const r=await w.pass();
  assert.deepEqual(r.repaired,[],name);assert.deepEqual(r.skipped,['payment-4'],name);
  assert.equal(w.at('/request-repair/preview').length+w.writes().length,0,name);
  assert.equal(w.lines.filter(l=>/^skip payment-4/.test(l)).length,1,name);
 }
});

test('LB2-1: a preview that derives another state, output or result hash is not applied',async()=>{
 for(const preview of [()=>({derivedOnChainState:'Disputed'}),()=>({outputIndex:0}),()=>({resultHash:hex('6')})]){
  const w=payWorld([stuckPay(5)],{preview});
  const r=await w.pass();
  assert.deepEqual(r.skipped,['payment-5']);assert.equal(w.at('/request-repair/preview').length,1);assert.equal(w.writes().length,0);
 }
});

test('LB2-1: progressing payments are left alone; a payment unchanged for more than 15 min that has no safe repair only raises an alarm',async()=>{
 const w=payWorld([
  stuckPay(6,{NextAction:{requestedAction:'WaitingForExternalAction',errorType:null},nextActionOrOnChainStateOrResultLastChangedAt:ago(5)}),
  stuckPay(7,{NextAction:{requestedAction:'WithdrawRequested',errorType:null},nextActionOrOnChainStateOrResultLastChangedAt:ago(14)}),
  stuckPay(8,{NextAction:{requestedAction:'WithdrawInitiated',errorType:null},nextActionOrOnChainStateOrResultLastChangedAt:ago(40)}),
  stuckPay(9,{NextAction:{requestedAction:'WaitingForManualAction',errorType:null},nextActionOrOnChainStateOrResultLastChangedAt:ago(40)}),
  stuckPay(10,{CurrentTransaction:{...stuckPay(10).CurrentTransaction,status:'Pending'}}),
  stuckPay(11,{CurrentTransaction:{...stuckPay(11).CurrentTransaction,newOnChainState:'Disputed'}}),
 ]);
 const r=await w.pass();
 assert.deepEqual(r.repaired,[]);assert.deepEqual(r.skipped,['payment-8','payment-9','payment-10','payment-11']);
 assert.match(w.lines.find(l=>/^skip payment-8/.test(l)),/WithdrawInitiated unchanged for 40 min/);
 assert.equal(w.chainCalls().length,0);
 assert.equal(w.at('/request-repair/preview').length+w.writes().length,0);
});

test('LB2-1: idle in WaitingForExternalAction for more than 15 min: a null resultHash is repaired from the datum without error-state-recovery, a set one only raises an alarm',async()=>{
 const idle={NextAction:{requestedAction:'WaitingForExternalAction',errorType:null},nextActionOrOnChainStateOrResultLastChangedAt:ago(16)};
 const a=stuckPay(12,{...idle,resultHash:null}),b=stuckPay(13,idle);
 const w=payWorld([a,b]);
 const r=await w.pass();
 assert.deepEqual(r.repaired,['payment-12']);assert.deepEqual(r.skipped,['payment-13']);
 assert.equal(a.resultHash,hex('7'));
 assert.equal(w.at('/request-repair').length,1);assert.equal(w.at('/payment/error-state-recovery').length,0);
 assert.match(w.lines.find(l=>/^skip payment-13/.test(l)),/WaitingForExternalAction for 16 min/);
});

test('LB2-1: pages through more than 100 WithdrawAuthorized payments and repairs each stuck one once',async()=>{
 const fresh={NextAction:{requestedAction:'WithdrawRequested',errorType:null},nextActionOrOnChainStateOrResultLastChangedAt:ago(1)};
 const many=Array.from({length:150},(_,i)=>stuckPay(i+100,i===99||i===120?{}:fresh));
 const w=payWorld(many);
 const r=await w.pass();
 assert.equal(r.checked,150);assert.deepEqual(r.repaired.sort(),['payment-199','payment-220']);
 assert.ok(w.calls.some(c=>c.query.cursorId));
 assert.equal(w.at('/payment/error-state-recovery').length,2);
});

test('LB2-1: one failing payment (Blockfrost 500, a payment changed before the clear) is logged and does not stop the others',async()=>{
 const a=stuckPay(30),b=stuckPay(31),c=stuckPay(32);
 const w=payWorld([a,b,c],{blockfrostDown:new Set([a.CurrentTransaction.txHash]),beforeRecovery:p=>{if(p.id==='payment-31')p.updatedAt=ago(0);}});
 const r=await w.pass();
 assert.deepEqual(r.repaired,['payment-32']);assert.deepEqual(r.failed,['payment-30','payment-31']);
 assert.equal(w.lines.filter(l=>/^error payment-3[01]/.test(l)).length,2);
});

test('repairStuckWithdrawals refuses to run without the admin profile',async()=>{
 await assert.rejects(repairStuckWithdrawals({url:'http://mps.test',adminKey:ADMIN,blockfrostKey:undefined,fetchImpl:async()=>{throw new Error('no call expected');}}),/mps-admin\.env/);
});

// ---- Fix round 5 (delta review).
test('DELTA-OPERATOR-1: a payment MPS parks again after every clear is repaired at most once an hour and three times in all, then raises one alarm with the MPS error',async()=>{
 const parked={requestedAction:'WaitingForManualAction',errorType:'Unknown',errorNote:'Collecting payments failed: Insufficient collateral'};
 const p=stuckPay(40,{NextAction:{...parked}}),w=payWorld([p]),attempts=new Map();
 let t=NOW;
 for(let i=0;i<10;i++){  // a pass every 30 min for 5 hours; MPS parks the payment again after each one
  await w.pass({now:()=>t,attempts});
  p.NextAction={...parked};p.updatedAt=new Date(Date.parse(p.updatedAt)+1000).toISOString();t+=30*MIN;
 }
 assert.equal(w.at('/request-repair').length,3);assert.equal(w.at('/payment/error-state-recovery').length,3);
 const repaired=w.lines.filter(l=>/^repaired payment-40/.test(l)),alarms=w.lines.filter(l=>/^alarm payment-40/.test(l));
 assert.equal(repaired.length,3);for(const l of repaired)assert.match(l,/Collecting payments failed: Insufficient collateral/);
 assert.equal(alarms.length,1);assert.match(alarms[0],/3 automatic repairs.*Collecting payments failed: Insufficient collateral/s);
});
test('DELTA-OPERATOR-3: a record that changed after the listing is re-read after the preview and not written to (purchase and payment)',async()=>{
 const p=stuck(50),w=world([p],{beforePreview:x=>{x.resultHash=null;x.NextAction={requestedAction:'WithdrawRefundInitiated',errorType:null};x.CurrentTransaction={txHash:hex('b'),status:'Pending',previousOnChainState:'RefundAuthorized',newOnChainState:'RefundWithdrawn'};}});
 const r=await w.pass();
 assert.deepEqual([r.repaired,r.skipped,w.writes().length],[[],['purchase-50'],0]);
 assert.match(w.lines.find(l=>/^skip purchase-50/.test(l)),/changed after the listing/);
 const q=stuckPay(51),v=payWorld([q],{beforePreview:x=>{x.NextAction={requestedAction:'WithdrawInitiated',errorType:null};x.CurrentTransaction={id:'tx-wd',txHash:hex('5'),status:'Pending',previousOnChainState:'WithdrawAuthorized',newOnChainState:'Withdrawn',createdAt:ago(0)};x.updatedAt=ago(0);}});
 const s=await v.pass();
 assert.deepEqual([s.repaired,s.skipped,v.writes().length],[[],['payment-51'],0]);
 assert.match(v.lines.find(l=>/^skip payment-51/.test(l)),/changed after the listing/);
});
test('DELTA-OPERATOR-3: one instance at a time: a second pass or loop is refused by the lock in .local/, and a pass releases it',async()=>{
 const {spawnSync}=await import('node:child_process');const {mkdtempSync,mkdirSync,writeFileSync,existsSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {fileURLToPath}=await import('node:url');
 const cli=fileURLToPath(new URL('./refund-repair.mjs',import.meta.url));
 const env={PATH:process.env.PATH,MPS_URL:'http://127.0.0.1:1',ADMIN_KEY:'x',BLOCKFROST_API_KEY_PREPROD:'y'};
 const locked=mkdtempSync(join(tmpdir(),'repair-'));mkdirSync(join(locked,'.local'),{mode:0o700});writeFileSync(join(locked,'.local/refund-repair.lock'),String(process.pid));
 for(const args of [[],['--loop']]){
  const r=spawnSync(process.execPath,[cli,...args],{cwd:locked,env,encoding:'utf8',timeout:20000});
  assert.equal(r.status,1,args.join(' '));assert.match(r.stderr,/already running/,args.join(' '));assert.doesNotMatch(r.stdout,/pass:/);
 }
 const free=mkdtempSync(join(tmpdir(),'repair-'));
 const r=spawnSync(process.execPath,[cli],{cwd:free,env,encoding:'utf8',timeout:20000});
 assert.equal(r.status,1,'MPS is not reachable, so the pass fails');assert.match(r.stdout,/error: /);
 assert.equal(existsSync(join(free,'.local/refund-repair.lock')),false,'the lock is released on exit');
});
