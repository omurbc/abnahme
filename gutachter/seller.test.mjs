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
import {documentHashOf,parseReport,assertDocumentHash} from '../verifier/kosit.mjs';
import {sha256} from './ledger.mjs';

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
// Fake KoSIT 1.6.3: acceptable under the XRechnung UBL scenario, names the bytes it got, counts calls; `mode` 'drop' breaks
// off after the status line, 422 is KoSIT's answer to XML it cannot read.
const kosit={calls:0,mode:null};
const kositServer=await listen(async(req,res)=>{ kosit.calls++; const body=await readBody(req);
 if(kosit.mode==='drop'){ res.writeHead(200,{'content-type':'application/xml'}); res.write('<rep:report>'); return setTimeout(()=>res.socket.destroy(),50); }
 if(kosit.mode===422){ res.writeHead(422); return res.end('error while processing the xml file'); }
 res.writeHead(200,{'content-type':'application/xml'});
 res.end(`<rep:report><rep:engine><rep:name>KoSIT Validator 1.6.3</rep:name></rep:engine><rep:documentIdentification><rep:documentHash><rep:hashAlgorithm>SHA-256</rep:hashAlgorithm><rep:hashValue>${documentHashOf(body)}</rep:hashValue></rep:documentHash></rep:documentIdentification><rep:scenarioMatched><s:scenario><s:name>EN16931 XRechnung (UBL Invoice)</s:name><s:description><s:p>Schematron rules from EN16931:2017, and XRechnung 3.0.2 </s:p></s:description></s:scenario></rep:scenarioMatched><rep:assessment><rep:accept/></rep:assessment></rep:report>`); });

const ledger=join(mkdtempSync(join(tmpdir(),'gutachter-test-')),'ledger.json');
const port=await (async()=>{ const s=await listen(()=>{}); const p=s.address().port; s.close(); return p; })();
const base=`http://127.0.0.1:${port}`;
let seller;
// Only what the seller reads: the test process may hold the operator's secrets, the child must not.
const sellerEnv=()=>({PATH:process.env.PATH,GUTACHTER_PORT:String(port),GUTACHTER_LEDGER:ledger,
 GUTACHTER_SELLER_ADDRESS:'addr_test1qzmzrgq7ux2zmn2gn8g7ddwnewu2cuwpluxf9aatn6yjeyfv68x94frsck5pt7hgq5pjk7edjxshy5ep46aw09cuex4qg6x5ce',
 FACILITATOR_URL:`http://127.0.0.1:${facServer.address().port}`,KOSIT_URL:`http://127.0.0.1:${kositServer.address().port}/`});
async function startSeller(){
 seller=spawn(process.execPath,['seller.mjs'],{cwd:fileURLToPath(new URL('.',import.meta.url)),stdio:'ignore',env:sellerEnv()});
 for(let i=0;i<100;i++){ try{ if((await fetch(`${base}/health`)).ok) return; }catch{} await new Promise(r=>setTimeout(r,50)); }
 throw new Error('seller did not start');
}
async function stopSeller(){ if(seller.exitCode!==null||seller.signalCode!==null) return; seller.kill(); await new Promise(r=>seller.once('exit',r)); }
after(async()=>{ await stopSeller(); facServer.close(); kositServer.close(); });
await startSeller();

const offer=decodePaymentRequiredHeader((await fetch(`${base}/inspect`,{method:'POST',body:'<Invoice/>'})).headers.get('payment-required'));
const header=(transaction,nonce='00'.repeat(32)+'#0')=>encodePaymentSignatureHeader({x402Version:2,resource:offer.resource,accepted:offer.accepts[0],payload:{transaction,nonce}});
async function paid(sig,xml){
 const res=await fetch(`${base}/inspect`,{method:'POST',headers:{'payment-signature':sig,'content-type':'application/xml'},body:xml});
 const pr=res.headers.get('payment-response');
 return {status:res.status,body:await res.json().catch(()=>null),receipt:pr?decodePaymentResponseHeader(pr):null};
}
const reset=()=>{ kosit.calls=0; kosit.mode=null; fac.settle=0; fac.verify=0; fac.settlePlan=[]; fac.onChain=false; };

test('a resend of the same payment and body returns the cached report: KoSIT and settle run once',async()=>{
 reset(); const sig=header(PAID[0]);
 const first=await paid(sig,'<Invoice>A</Invoice>');
 const again=await paid(sig,'<Invoice>A</Invoice>');
 assert.equal(first.status,200); assert.equal(first.body.verdict,'ACCEPTABLE'); assert.equal(first.receipt.transaction,TX);
 assert.equal(first.body.xmlSha256,sha256('<Invoice>A</Invoice>')); assert.equal(first.body.documentHash,documentHashOf('<Invoice>A</Invoice>')); assert.equal(first.body.engine,'KoSIT Validator 1.6.3');
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
test('/health answers only {ok:true}, and no response advertises X-Powered-By',async()=>{
 const health=await fetch(`${base}/health`);
 assert.deepEqual(await health.json(),{ok:true});
 const unpaid=await fetch(`${base}/inspect`,{method:'POST',body:'<Invoice/>'});
 assert.equal(unpaid.status,402);
 for(const res of [health,unpaid]) assert.equal(res.headers.get('x-powered-by'),null);
});
test('refuses to start when it holds a project secret it does not need',async()=>{
 const free=await (async()=>{ const s=await listen(()=>{}); const p=s.address().port; s.close(); return p; })();
 const child=spawn(process.execPath,['seller.mjs'],{cwd:fileURLToPath(new URL('.',import.meta.url)),stdio:['ignore','ignore','pipe'],
  env:{...sellerEnv(),GUTACHTER_PORT:String(free),ANTHROPIC_API_KEY:'sentinel-anthropic',GUTACHTER_BUYER_MNEMONIC:'sentinel-mnemonic'}});
 let stderr=''; child.stderr.on('data',c=>stderr+=c);
 const [code,signal]=await new Promise(r=>{ const t=setTimeout(()=>child.kill(),5000); child.once('exit',(c,s)=>{ clearTimeout(t); r([c,s]); }); });
 assert.equal(signal,null,'the seller started instead of refusing'); assert.notEqual(code,0);
 assert.match(stderr,/ANTHROPIC_API_KEY/); assert.match(stderr,/GUTACHTER_BUYER_MNEMONIC/);
 assert.doesNotMatch(stderr,/sentinel-/);
});
test('without KOSIT_URL the seller uses KOSIT_PORT on 127.0.0.1',async()=>{
 const free=await (async()=>{ const s=await listen(()=>{}); const p=s.address().port; s.close(); return p; })();
 const env={...sellerEnv(),GUTACHTER_PORT:String(free),KOSIT_PORT:'18090'}; delete env.KOSIT_URL;
 const child=spawn(process.execPath,['seller.mjs'],{cwd:fileURLToPath(new URL('.',import.meta.url)),stdio:['ignore','pipe','ignore'],env});
 let out='';
 await new Promise((resolve,reject)=>{ const t=setTimeout(()=>reject(new Error(`no KoSIT line in: ${out}`)),5000); child.stdout.on('data',c=>{ out+=c; if(/KoSIT: .*\n/.test(out)){ clearTimeout(t); resolve(); } }); });
 child.kill(); await new Promise(r=>child.once('exit',r));
 assert.match(out,/KoSIT: http:\/\/127\.0\.0\.1:18090\/\n/);
});
test('binds 127.0.0.1 by default, so a non-loopback address is refused',async t=>{
 const lan=Object.values(networkInterfaces()).flat().find(i=>i.family==='IPv4'&&!i.internal)?.address;
 if(!lan) return t.skip('no non-loopback IPv4 interface');
 const err=await new Promise(r=>request({host:lan,port,path:'/health',timeout:2000},()=>r(null)).on('error',r).on('timeout',function(){ this.destroy(new Error('timeout')); }).end());
 assert.equal(err?.code,'ECONNREFUSED');
});

// PAID[4] is fresh here: the answers below store nothing in the ledger (status >= 400) until the BOM test, which uses it last.
// DELTA-X402-6: Express's default error page carries the stack trace and absolute paths outside production; on the
// resend path a public past tx is enough to reach the body parser.
test('a body the parser refuses gets a short JSON error without stack trace or path, on the resend and the paid path',async()=>{
 reset();
 const send=(sig,body,headers={})=>fetch(`${base}/inspect`,{method:'POST',headers:{'payment-signature':sig,'content-type':'application/xml',...headers},body});
 for(const [name,res] of [
  ['resend 415',await send(header(PAID[0]),'<Invoice>A</Invoice>',{'content-encoding':'x-unknown'})],
  ['resend 413',await send(header(PAID[0]),'x'.repeat(5*1024*1024+1))],
  ['paid 413',await send(header(PAID[4]),'x'.repeat(5*1024*1024+1))],
 ]){
  const text=await res.text();
  assert.ok([413,415].includes(res.status),`${name}: ${res.status}`);
  assert.match(res.headers.get('content-type'),/application\/json/,name);
  assert.doesNotMatch(text,/\sat\s|\/Users\/|\/home\/|node_modules|Error:/,name);
  assert.ok(JSON.parse(text).error,name);
 }
 assert.equal(fac.settle,0); assert.equal(kosit.calls,0);
 assert.match(JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8')).scripts.seller,/^NODE_ENV=production /);
});
// DELTA-X402-1: an unhandled rejection in the paid handler ended the seller.
test('KoSIT breaking off in the middle of its answer is 503, not charged, and the seller stays up',async()=>{
 reset(); kosit.mode='drop';
 const r=await paid(header(PAID[4]),'<Invoice>A</Invoice>');
 assert.equal(r.status,503); assert.equal(r.body.charged,false); assert.equal(fac.settle,0);
 assert.deepEqual(await (await fetch(`${base}/health`)).json(),{ok:true});
});
// DELTA-X402-2: the buyer must not take this 502 for one that may still settle.
test('KoSIT 422 is no inspection: 502 with charged:false, not settled',async()=>{
 reset(); kosit.mode=422;
 const r=await paid(header(PAID[4]),'<Invoice>A</Invoice>');
 assert.equal(r.status,502); assert.deepEqual(r.body,{error:'KoSIT answered HTTP 422',httpStatus:422,charged:false}); assert.equal(fac.settle,0);
});
// DELTA-X402-5: express.text stripped a leading BOM, so the paid report named other bytes than the buyer sent.
test('the exact bytes sent are inspected: a leading BOM reaches KoSIT, and the report binds to the buyer\'s own string',async()=>{
 reset(); const xml='\uFEFF<Invoice>bom</Invoice>';
 const r=await paid(header(PAID[4]),xml);
 assert.equal(r.status,200); assert.equal(r.body.verdict,'ACCEPTABLE');
 assert.equal(r.body.documentHash,documentHashOf(xml)); assert.equal(r.body.xmlSha256,sha256(xml));
 assertDocumentHash(parseReport(r.body.report),xml);
});
