// Drives the real seller.mjs (child process) against a fake facilitator and a fake KoSIT. No chain, no real facilitator.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir,networkInterfaces} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {encodePaymentSignatureHeader,decodePaymentRequiredHeader,decodePaymentResponseHeader} from '@x402/core/http';
import {x402Facilitator} from '@x402/core/facilitator';
import {ExactCardanoScheme} from '@x402/cardano/exact/facilitator';

const TX='ab'.repeat(32);
const PAID=Object.values(JSON.parse(readFileSync(new URL('./fixtures/paid-txs.json',import.meta.url),'utf8'))); // real signed preprod txs, one per test
const listen=async handler=>{ const s=createServer(handler); await new Promise(r=>s.listen(0,'127.0.0.1',r)); return s; };
const json=(res,code,obj)=>{ res.writeHead(code,{'content-type':'application/json'}); res.end(JSON.stringify(obj)); };
const readBody=req=>new Promise(r=>{ let b=''; req.on('data',c=>b+=c); req.on('end',()=>r(b)); });

// Fake facilitator: verify valid unless `onChain` (then it fails like the hosted one does once the tx is in a block);
// settle answers from `settlePlan` (shifted per call), else success.
const fac={verify:0,settle:0,settlePlan:[],onChain:false};
const supported=new x402Facilitator().register('cardano:preprod',new ExactCardanoScheme({getAddresses:()=>[],getCurrentSlot:async()=>0n,getUtxo:async()=>({exists:false}),submitTransaction:async()=>{ throw new Error('fake'); },getTransactionEvidence:async()=>({status:'unknown',confirmations:-2})})).getSupported();
const facServer=await listen(async(req,res)=>{
 if(req.url==='/supported') return json(res,200,supported);
 const {paymentRequirements}=JSON.parse(await readBody(req)||'{}');
 if(req.url==='/verify'){ fac.verify++; return json(res,200,fac.onChain?{isValid:false,invalidReason:'invalid_exact_cardano_payload_nonce_not_on_chain',payer:''}:{isValid:true,payer:'addr_test1_fake_payer'}); }
 fac.settle++;
 const plan=fac.settlePlan.shift();
 if(plan==='504'){ res.writeHead(504,{'content-type':'text/html'}); return res.end('<html>504 Gateway Time-out</html>'); }
 json(res,200,{success:true,transaction:TX,network:paymentRequirements.network,payer:'addr_test1_fake_payer'});
});
// Fake KoSIT: always acceptable under the XRechnung UBL scenario, counts calls.
const kosit={calls:0};
const kositServer=await listen(async(req,res)=>{ kosit.calls++; await readBody(req); res.writeHead(200,{'content-type':'application/xml'}); res.end('<rep:report><rep:scenarioMatched><s:scenario><s:name>EN16931 XRechnung (UBL Invoice)</s:name></s:scenario></rep:scenarioMatched></rep:report>'); });

const ledger=join(mkdtempSync(join(tmpdir(),'gutachter-test-')),'ledger.json');
const port=await (async()=>{ const s=await listen(()=>{}); const p=s.address().port; s.close(); return p; })();
const base=`http://127.0.0.1:${port}`;
let seller;
async function startSeller(){
 const env={...process.env,GUTACHTER_PORT:String(port),GUTACHTER_STUB:'',GUTACHTER_LEDGER:ledger,
  GUTACHTER_SELLER_ADDRESS:'addr_test1qzmzrgq7ux2zmn2gn8g7ddwnewu2cuwpluxf9aatn6yjeyfv68x94frsck5pt7hgq5pjk7edjxshy5ep46aw09cuex4qg6x5ce',
  FACILITATOR_URL:`http://127.0.0.1:${facServer.address().port}`,KOSIT_URL:`http://127.0.0.1:${kositServer.address().port}/`};
 delete env.GUTACHTER_HOST;
 seller=spawn(process.execPath,['seller.mjs'],{cwd:fileURLToPath(new URL('.',import.meta.url)),stdio:'ignore',env});
 for(let i=0;i<100;i++){ try{ if((await fetch(`${base}/health`)).ok) return; }catch{} await new Promise(r=>setTimeout(r,50)); }
 throw new Error('seller did not start');
}
async function stopSeller(){ seller.kill(); await new Promise(r=>seller.once('exit',r)); }
after(async()=>{ await stopSeller(); facServer.close(); kositServer.close(); });
await startSeller();

const offer=decodePaymentRequiredHeader((await fetch(`${base}/inspect`,{method:'POST',body:'<Invoice/>'})).headers.get('payment-required'));
const header=(transaction,nonce='00'.repeat(32)+'#0')=>encodePaymentSignatureHeader({x402Version:2,resource:offer.resource,accepted:offer.accepts[0],payload:{transaction,nonce}});
async function paid(sig,xml){
 const res=await fetch(`${base}/inspect`,{method:'POST',headers:{'payment-signature':sig,'content-type':'application/xml'},body:xml});
 const pr=res.headers.get('payment-response');
 return {status:res.status,body:await res.json().catch(()=>null),receipt:pr?decodePaymentResponseHeader(pr):null};
}
const reset=()=>{ kosit.calls=0; fac.settle=0; fac.verify=0; fac.settlePlan=[]; fac.onChain=false; };

test('a resend of the same payment and body returns the cached report: KoSIT and settle run once',async()=>{
 reset(); const sig=header(PAID[0]);
 const first=await paid(sig,'<Invoice>A</Invoice>');
 const again=await paid(sig,'<Invoice>A</Invoice>');
 assert.equal(first.status,200); assert.equal(first.body.verdict,'ACCEPTABLE'); assert.equal(first.receipt.transaction,TX);
 fac.onChain=true; const late=await paid(sig,'<Invoice>A</Invoice>'); // a replay after the block
 assert.equal(again.status,200); assert.deepEqual(again.body,first.body); assert.equal(again.receipt.transaction,TX);
 assert.equal(late.status,200); assert.deepEqual(late.body,first.body); assert.equal(late.receipt.transaction,TX);
 assert.equal(kosit.calls,1); assert.equal(fac.settle,1);
});
test('the same payment with a different body is 409 and is not settled',async()=>{
 reset(); const sig=header(PAID[1]);
 assert.equal((await paid(sig,'<Invoice>A</Invoice>')).status,200);
 const other=await paid(sig,'<Invoice>B</Invoice>');
 assert.equal(other.status,409); assert.equal(kosit.calls,1); assert.equal(fac.settle,1);
});
test('after a facilitator 504 on settle, the resend gets the cached report and the receipt; KoSIT runs once',async()=>{
 reset(); fac.settlePlan=['504']; const sig=header(PAID[2]);
 const first=await paid(sig,'<Invoice>A</Invoice>');
 assert.equal(first.status,402); assert.equal(first.receipt.transaction,'');
 fac.onChain=true; // the tx landed meanwhile: the facilitator's /verify now rejects it, its /settle still reconciles
 const again=await paid(sig,'<Invoice>A</Invoice>');
 assert.equal(again.status,200); assert.equal(again.body.verdict,'ACCEPTABLE'); assert.equal(again.receipt.transaction,TX);
 assert.equal(kosit.calls,1); assert.equal(fac.settle,2); assert.equal(fac.verify,1);
});
test('one tx is one payment, whichever of its inputs or spellings is sent as the nonce',async()=>{
 reset();
 assert.equal((await paid(header(PAID[3],'cd'.repeat(32)+'#0'),'<Invoice>A</Invoice>')).status,200);
 const again=await paid(header(PAID[3],'CD'.repeat(32)+'#0'),'<Invoice>A</Invoice>');
 assert.equal(again.status,200); assert.equal(kosit.calls,1); assert.equal(fac.settle,1);
});
test('the ledger survives a seller restart',async()=>{
 await stopSeller(); await startSeller(); reset();
 const again=await paid(header(PAID[0]),'<Invoice>A</Invoice>');
 assert.equal(again.status,200); assert.equal(again.receipt.transaction,TX);
 assert.equal(kosit.calls,0); assert.equal(fac.settle,0);
});
test('binds 127.0.0.1 by default, so a non-loopback address is refused',async t=>{
 const lan=Object.values(networkInterfaces()).flat().find(i=>i.family==='IPv4'&&!i.internal)?.address;
 if(!lan) return t.skip('no non-loopback IPv4 interface');
 const err=await new Promise(r=>request({host:lan,port,path:'/health',timeout:2000},()=>r(null)).on('error',r).on('timeout',function(){ this.destroy(new Error('timeout')); }).end());
 assert.equal(err?.code,'ECONNREFUSED');
});
