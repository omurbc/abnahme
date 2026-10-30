// Drives buyInspection() against a fake seller with a stub signer: no wallet, no chain, no facilitator.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,writeFileSync,mkdtempSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {x402Client} from '@x402/fetch';
import {encodePaymentRequiredHeader,encodePaymentResponseHeader} from '@x402/core/http';

delete process.env.GUTACHTER_BUYER_MNEMONIC; // a test must never reach the real wallet
const TX='5820e591b57f7baac9ea31818499dc37615a9697032919da83d183a0039ac4a9';
const TX_B64=JSON.parse(readFileSync(new URL('./fixtures/paid-txs.json',import.meta.url),'utf8'))[TX]; // the real signed tx, never sent anywhere real
const NETWORK='cardano:preprod';
const accepts=[{scheme:'exact',network:NETWORK,amount:'1000000',asset:'lovelace',payTo:'addr_test1qzmzrgq7ux2zmn2gn8g7ddwnewu2cuwpluxf9aatn6yjeyfv68x94frsck5pt7hgq5pjk7edjxshy5ep46aw09cuex4qg6x5ce',maxTimeoutSeconds:300,extra:{areFeesSponsored:false}}];

// Fake seller: unpaid -> 402 offer (or `unpaidAnswer`); paid -> the next answer from `plan`.
let plan=[],paidHeaders=[],logAtFirstPaid=null,logAtPaid=[],unpaidAnswer=null,hangUnpaid=0,logPath;
const server=createServer((req,res)=>{
 req.resume(); req.on('end',()=>{
  const sig=req.headers['payment-signature'];
  if(!sig&&hangUnpaid>0){ hangUnpaid--; return; } // never answers
  if(!sig&&unpaidAnswer){ res.writeHead(unpaidAnswer.status,{'content-type':'application/json'}); return res.end(JSON.stringify(unpaidAnswer.body)); }
  if(!sig){ res.writeHead(402,{'PAYMENT-REQUIRED':encodePaymentRequiredHeader({x402Version:2,error:'Payment required',resource:{url:'http://x/inspect'},accepts}),'content-type':'application/json'}); return res.end('{}'); }
  if(!paidHeaders.length) logAtFirstPaid=existsSync(logPath)?readFileSync(logPath,'utf8'):'';
  logAtPaid.push(existsSync(logPath)?readFileSync(logPath,'utf8'):'');
  paidHeaders.push(sig);
  const {status,receipt,body}=plan.length>1?plan.shift():plan[0];
  res.writeHead(status,{'content-type':'application/json',...receipt?{'PAYMENT-RESPONSE':encodePaymentResponseHeader({network:NETWORK,...receipt})}:{}});
  res.end(JSON.stringify(body??{}));
 });
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
after(()=>{ server.closeAllConnections(); server.close(); });
process.env.GUTACHTER_URL=`http://127.0.0.1:${server.address().port}`;
const PAY_TO=accepts[0].payTo;
process.env.GUTACHTER_SELLER_ADDRESS=PAY_TO; // the buyer pays only this address
delete process.env.GUTACHTER_MAX_PAYMENTS_PER_DAY;
const {buyInspection,SPEND_CONTROLS}=await import('./buy.mjs');
// A fresh copy of buy.mjs, loaded with `env` applied (the module reads its env at load).
async function loadWith(env,tag){
 const saved=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));
 for(const [k,v] of Object.entries(env)) v===undefined?delete process.env[k]:process.env[k]=v;
 try{ return await import(`./buy.mjs?${tag}`); }
 finally{ for(const [k,v] of Object.entries(saved)) v===undefined?delete process.env[k]:process.env[k]=v; }
}

let signs=0,signDelayMs=0;
function stubClient(){
 const c=new x402Client().setSpendControls(SPEND_CONTROLS);
 c.register('cardano:*',{scheme:'exact',createPaymentPayload:async()=>{ signs++; await new Promise(r=>setTimeout(r,signDelayMs)); return {x402Version:2,payload:{transaction:TX_B64,nonce:'db265614ca'.padEnd(64,'0')+'#0'}}; }});
 return c;
}
function setup(answers){
 plan=answers; paidHeaders=[]; logAtFirstPaid=null; logAtPaid=[]; unpaidAnswer=null; hangUnpaid=0; signs=0; signDelayMs=0;
 logPath=join(mkdtempSync(join(tmpdir(),'gutachter-buy-')),'payments.log.json');
 return {client:stubClient(),logPath,retryDelayMs:5,budgetMs:500,inputState:async()=>'unspent'};
}
const settled={status:200,receipt:{success:true,transaction:TX},body:{verdict:'ACCEPTABLE',httpStatus:200,report:'<r/>'}};
const log=()=>JSON.parse(readFileSync(logPath,'utf8'));

test('settlement_pending: resends the SAME signed header until settled, signs once, logs the tx before sending',async()=>{
 const opts=setup([{status:402,receipt:{success:false,errorReason:'settlement_pending',transaction:TX}},settled]);
 const r=await buyInspection('<Invoice/>',opts);
 assert.equal(r.httpStatus,200); assert.equal(r.txHash,TX); assert.equal(r.verdict,'ACCEPTABLE');
 assert.equal(signs,1); assert.equal(paidHeaders.length,2); assert.equal(paidHeaders[1],paidHeaders[0]);
 assert.match(logAtFirstPaid,new RegExp(TX));
 assert.deepEqual(log().map(e=>[e.txHash,e.verdict,e.status]),[[TX,'ACCEPTABLE','settled']]);
});
test('the 10:16 shape (402, PAYMENT-RESPONSE without tx) is resent with the same header',async()=>{
 const opts=setup([{status:402,receipt:{success:false,errorReason:'Facilitator settle failed (504): <html>',transaction:''}},settled]);
 const r=await buyInspection('<Invoice/>',opts);
 assert.equal(r.httpStatus,200); assert.equal(r.txHash,TX);
 assert.equal(signs,1); assert.equal(paidHeaders.length,2); assert.equal(paidHeaders[1],paidHeaders[0]);
});
test('a 503 from the seller (KoSIT down, never settled) is not resent and is logged not-charged',async()=>{
 const opts=setup([{status:503,body:{error:'KoSIT unreachable'}}]);
 const r=await buyInspection('<Invoice/>',opts);
 assert.equal(r.httpStatus,503); assert.equal(r.txHash,null); assert.equal(paidHeaders.length,1);
 assert.equal(log()[0].status,'not-charged');
});
test('gives up after the budget, never signs again, and keeps the tx hash in the log',async()=>{
 const opts=setup([{status:402,receipt:{success:false,errorReason:'settlement_pending',transaction:TX}}]);
 const r=await buyInspection('<Invoice/>',opts);
 assert.equal(r.httpStatus,402); assert.equal(r.txHash,TX); assert.equal(signs,1); assert.ok(paidHeaders.length>1);
 assert.ok(paidHeaders.every(h=>h===paidHeaders[0]));
 assert.deepEqual(log().map(e=>[e.txHash,e.status]),[[TX,'unknown']]);
});
test('an offer above the 1 tADA price is refused before signing',async()=>{
 const opts=setup([settled]); accepts[0].amount='1000001';
 try{ await assert.rejects(buyInspection('<Invoice/>',opts)); }finally{ accepts[0].amount='1000000'; }
 assert.equal(signs,0); assert.equal(paidHeaders.length,0);
});
test('daily budget: refuses to sign once 20 payments were charged in the last 24 h; not-charged and older ones do not count',async()=>{
 const entry=(hoursAgo,status,i)=>({time:new Date(Date.now()-hoursAgo*3_600_000).toISOString(),txHash:`${status}-${hoursAgo}-${i}`,status});
 const fill=entries=>writeFileSync(logPath,JSON.stringify(entries));
 let opts=setup([settled]);
 fill(Array.from({length:20},(_,i)=>entry(1,i%2?'settled':'unknown',i)));
 // The message reaches the board and the Sokosumi protocol: no local file paths in it.
 await assert.rejects(buyInspection('<Invoice/>',opts),e=>/budget/.test(e.message)&&!e.message.includes(logPath)&&!/(^|\s)\//.test(e.message));
 assert.equal(signs,0); assert.equal(paidHeaders.length,0);
 opts=setup([settled]);
 fill([...Array.from({length:19},(_,i)=>entry(1,'settled',i)),...Array.from({length:5},(_,i)=>entry(1,'not-charged',i)),...Array.from({length:5},(_,i)=>entry(25,'settled',i))]);
 const r=await buyInspection('<Invoice/>',opts);
 assert.equal(r.httpStatus,200); assert.equal(signs,1);
});
test('without GUTACHTER_URL the buyer calls 127.0.0.1, so a squatter on [::1] of the same port is never asked',async t=>{
 const real=createServer((req,res)=>{ req.resume(); req.on('end',()=>{ res.writeHead(418,{'content-type':'application/json'}); res.end('{}'); }); });
 await new Promise(r=>real.listen(0,'127.0.0.1',r));
 const port=real.address().port;
 let squatHits=0;
 const squat=createServer((req,res)=>{ squatHits++; req.resume(); req.on('end',()=>{ res.writeHead(200,{'content-type':'application/json'}); res.end('{"verdict":"ACCEPTABLE","httpStatus":200,"report":"<r/>"}'); }); });
 const bound=await new Promise(r=>{ squat.once('error',()=>r(false)); squat.listen(port,'::1',()=>r(true)); });
 try{
  if(!bound) return t.skip('no IPv6 loopback to squat on');
  const {buyInspection:fresh}=await loadWith({GUTACHTER_URL:undefined,GUTACHTER_PORT:String(port)},'default-url');
  const r=await fresh('<Invoice/>',setup([settled]));
  assert.equal(squatHits,0); assert.equal(r.httpStatus,418);
 }finally{ real.close(); if(bound) squat.close(); }
});
test('an offer that pays another address than GUTACHTER_SELLER_ADDRESS is refused before signing; so is a buyer without it',async()=>{
 const opts=setup([settled]); accepts[0].payTo='addr_test1qpdym62fsquatter0000000000000000000000000000000000000000000000000000000';
 try{ await assert.rejects(buyInspection('<Invoice/>',opts),/GUTACHTER_SELLER_ADDRESS/); }finally{ accepts[0].payTo=PAY_TO; }
 assert.equal(signs,0); assert.equal(paidHeaders.length,0); assert.equal(existsSync(logPath),false);
 const {buyInspection:unpinned}=await loadWith({GUTACHTER_SELLER_ADDRESS:undefined},'no-payto');
 await assert.rejects(unpinned('<Invoice/>',setup([settled])),/GUTACHTER_SELLER_ADDRESS/);
 assert.equal(signs,0); assert.equal(paidHeaders.length,0);
});
test('a 200 to the unpaid request is no inspection: refused, nothing signed or logged',async()=>{
 const opts=setup([settled]); unpaidAnswer={status:200,body:{verdict:'ACCEPTABLE',httpStatus:200,report:'<r/>'}};
 await assert.rejects(buyInspection('<Invoice/>',opts),/without asking for payment/);
 assert.equal(signs,0); assert.equal(paidHeaders.length,0); assert.equal(existsSync(logPath),false);
});
test('a malformed GUTACHTER_MAX_PAYMENTS_PER_DAY refuses to load instead of switching the budget off; 0 refuses every payment',async()=>{
 for(const [i,value] of ['twenty','20 per day','1.5','-1','0x10','1e3',' 20'].entries())
  await assert.rejects(loadWith({GUTACHTER_MAX_PAYMENTS_PER_DAY:value},`cap-${i}`),/GUTACHTER_MAX_PAYMENTS_PER_DAY/,value);
 const {buyInspection:capped}=await loadWith({GUTACHTER_MAX_PAYMENTS_PER_DAY:'0'},'cap-zero');
 await assert.rejects(capped('<Invoice/>',setup([settled])),/budget/);
 assert.equal(signs,0);
});
test('daily budget: two concurrent calls with one slot left, exactly one signs',async()=>{
 const opts=setup([settled]); signDelayMs=30;
 writeFileSync(logPath,JSON.stringify(Array.from({length:19},(_,i)=>({time:new Date().toISOString(),txHash:`old-${i}`,status:'settled'}))));
 const results=await Promise.allSettled([buyInspection('<Invoice>A</Invoice>',opts),buyInspection('<Invoice>B</Invoice>',opts)]);
 assert.equal(signs,1);
 assert.deepEqual(results.map(r=>r.status),['fulfilled','rejected']); assert.match(results[1].reason.message,/budget/);
});
test('concurrent calls run one after the other, and each call has its own log entry even when the wallet builds the same tx',async()=>{
 const opts=setup([settled,{status:409,body:{error:'This payment was already used for a different invoice'}}]); signDelayMs=30;
 const [a,b]=await Promise.all([buyInspection('<Invoice>A</Invoice>',opts),buyInspection('<Invoice>B</Invoice>',opts)]);
 assert.equal(a.verdict,'ACCEPTABLE'); assert.equal(a.txHash,TX); assert.equal(b.httpStatus,409); assert.equal(b.txHash,null);
 assert.deepEqual(log().map(e=>[e.txHash,e.status,e.verdict]),[[TX,'settled','ACCEPTABLE'],[TX,'not-charged',null]]);
 assert.match(logAtPaid[1],/"status": "settled"/,'the second payment was sent only after the first one had finished');
});
test('a seller that never answers the unpaid request fails that call and does not hold up the next one',{timeout:5000},async()=>{
 const opts={...setup([settled]),offerTimeoutMs:100}; hangUnpaid=1;
 const [a,b]=await Promise.allSettled([buyInspection('<Invoice>A</Invoice>',opts),buyInspection('<Invoice>B</Invoice>',opts)]);
 assert.equal(a.status,'rejected'); assert.equal(b.value?.verdict,'ACCEPTABLE'); assert.equal(signs,1);
});
test('LANE-A-3: a tx built on an input that is not yet in a block (or already spent) is never sent; it is built again once the wallet view caught up',async()=>{
 const states=['unconfirmed','spent','unspent'],asked=[];
 const opts={...setup([settled]),inputState:async ref=>{asked.push(ref);return states.length>1?states.shift():states[0];},confirmPollMs:5,confirmWaitMs:1000};
 const r=await buyInspection('<Invoice/>',opts);
 assert.equal(r.httpStatus,200); assert.equal(r.txHash,TX);
 assert.equal(signs,3); assert.equal(paidHeaders.length,1);
 assert.deepEqual(asked,Array(3).fill('db265614caeac14c2f20a168386b85e8619c87b95306f1107a95ccb55d7fb45b#0'));
 assert.deepEqual(log().map(e=>[e.txHash,e.status]),[[TX,'settled']]);
});
test('LANE-A-3: inputs still unconfirmed after the bounded wait: nothing is sent or logged, and the next call is not held up',{timeout:5000},async()=>{
 const opts={...setup([settled]),inputState:async()=>'unconfirmed',confirmPollMs:5,confirmWaitMs:50};
 await assert.rejects(buyInspection('<Invoice/>',opts),/not confirmed/);
 assert.ok(signs>=2); assert.equal(paidHeaders.length,0); assert.equal(existsSync(logPath),false);
 const r=await buyInspection('<Invoice/>',{...opts,inputState:async()=>'unspent'});
 assert.equal(r.httpStatus,200); assert.equal(paidHeaders.length,1);
});
test('the CLI prints its usage and exits 2 without a file (also on Node without import.meta.main)',()=>{
 const r=spawnSync(process.execPath,[fileURLToPath(new URL('./buy.mjs',import.meta.url))],{encoding:'utf8',env:{PATH:process.env.PATH}});
 assert.equal(r.status,2); assert.match(r.stderr,/usage: node buy\.mjs/);
});
