// Drives buyInspection() against a fake seller with a stub signer: no wallet, no chain, no facilitator.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,mkdtempSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {x402Client} from '@x402/fetch';
import {encodePaymentRequiredHeader,encodePaymentResponseHeader} from '@x402/core/http';

delete process.env.GUTACHTER_BUYER_MNEMONIC; // a test must never reach the real wallet
const TX='5820e591b57f7baac9ea31818499dc37615a9697032919da83d183a0039ac4a9';
const TX_B64=JSON.parse(readFileSync(new URL('./fixtures/paid-txs.json',import.meta.url),'utf8'))[TX]; // the real signed tx, never sent anywhere real
const NETWORK='cardano:preprod';
const accepts=[{scheme:'exact',network:NETWORK,amount:'1000000',asset:'lovelace',payTo:'addr_test1qzmzrgq7ux2zmn2gn8g7ddwnewu2cuwpluxf9aatn6yjeyfv68x94frsck5pt7hgq5pjk7edjxshy5ep46aw09cuex4qg6x5ce',maxTimeoutSeconds:300,extra:{areFeesSponsored:false}}];

// Fake seller: unpaid -> 402 offer; paid -> the next answer from `plan`.
let plan=[],paidHeaders=[],logAtFirstPaid=null,logPath;
const server=createServer((req,res)=>{
 req.resume(); req.on('end',()=>{
  const sig=req.headers['payment-signature'];
  if(!sig){ res.writeHead(402,{'PAYMENT-REQUIRED':encodePaymentRequiredHeader({x402Version:2,error:'Payment required',resource:{url:'http://x/inspect'},accepts}),'content-type':'application/json'}); return res.end('{}'); }
  if(!paidHeaders.length) logAtFirstPaid=existsSync(logPath)?readFileSync(logPath,'utf8'):'';
  paidHeaders.push(sig);
  const {status,receipt,body}=plan.length>1?plan.shift():plan[0];
  res.writeHead(status,{'content-type':'application/json',...receipt?{'PAYMENT-RESPONSE':encodePaymentResponseHeader({network:NETWORK,...receipt})}:{}});
  res.end(JSON.stringify(body??{}));
 });
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
after(()=>server.close());
process.env.GUTACHTER_URL=`http://127.0.0.1:${server.address().port}`;
const {buyInspection}=await import('./buy.mjs');

let signs=0;
function stubClient(){
 const c=new x402Client().setSpendControls({allowedAssets:[{network:'cardano:*',asset:'lovelace',maxAmountPerPayment:'1500000'}]});
 c.register('cardano:*',{scheme:'exact',createPaymentPayload:async()=>{ signs++; return {x402Version:2,payload:{transaction:TX_B64,nonce:'db265614ca'.padEnd(64,'0')+'#0'}}; }});
 return c;
}
function setup(answers){
 plan=answers; paidHeaders=[]; logAtFirstPaid=null; signs=0;
 logPath=join(mkdtempSync(join(tmpdir(),'gutachter-buy-')),'payments.log.json');
 return {client:stubClient(),logPath,retryDelayMs:5,budgetMs:500};
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
