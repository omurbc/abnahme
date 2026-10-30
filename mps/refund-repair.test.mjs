// refund-repair.mjs (#1327 workaround) against a fake MPS admin API and a fake Blockfrost behind one fetch: it repairs only
// a RefundAuthorized purchase with a stale resultHash whose own unspent escrow output on chain is RefundAuthorized with an
// empty result_hash, applies only what the preview derived, never forces, and is idempotent.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {repairStuckRefunds} from './refund-repair.mjs';

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

function world(purchases,{chain=Object.assign({},...purchases.map(p=>chainFor(p))),preview=()=>({}),blockfrostDown=new Set()}={}){
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
  if(path==='/request-repair/preview'){
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
