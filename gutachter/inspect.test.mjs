import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {inspect} from './inspect.mjs';
import {sha256} from './ledger.mjs';
import {documentHashOf} from '../verifier/kosit.mjs';

// A report as KoSIT 1.6.3 writes it, about the bytes `about` (default: the posted '<Invoice/>').
const report=({scenario='EN16931 XRechnung (UBL Invoice)',engine='KoSIT Validator 1.6.3',xrechnung='3.0.2',about='<Invoice/>',hash=documentHashOf(about),assessment='accept'}={})=>
 `<rep:report>${engine?`<rep:engine><rep:name>${engine}</rep:name></rep:engine>`:''}${hash?`<rep:documentIdentification><rep:documentHash><rep:hashAlgorithm>SHA-256</rep:hashAlgorithm><rep:hashValue>${hash}</rep:hashValue></rep:documentHash></rep:documentIdentification>`:''}<rep:scenarioMatched><s:scenario><s:name>${scenario}</s:name><s:description><s:p>Schematron rules from EN16931:2017, and XRechnung ${xrechnung} </s:p></s:description></s:scenario></rep:scenarioMatched><rep:assessment><rep:${assessment}/></rep:assessment></rep:report>`;
async function kosit(status,body=`<rep got="10"/>`){
 const server=createServer((req,res)=>{ req.resume(); req.on('end',()=>{ res.writeHead(status,{'content-type':'application/xml'}); res.end(body); }); });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {url:`http://127.0.0.1:${server.address().port}/`,close:()=>server.close()};
}

test('KoSIT 200 with the XRechnung UBL scenario is a paid ACCEPTABLE inspection that names the validator and the inspected bytes',async()=>{
 const body=report();
 const k=await kosit(200,body);
 const r=await inspect('<Invoice/>',{url:k.url}); k.close();
 assert.deepEqual(r,{status:200,body:{verdict:'ACCEPTABLE',httpStatus:200,scenario:'EN16931 XRechnung (UBL Invoice)',engine:'KoSIT Validator 1.6.3',xrechnungVersion:'3.0.2',
  xmlSha256:sha256('<Invoice/>'),documentHash:documentHashOf('<Invoice/>'),report:body}});
});
test('KoSIT 200 under the plain EN16931 scenario is REJECT (scenario pin)',async()=>{
 const k=await kosit(200,report({scenario:'EN16931 (UBL Invoice)'}));
 const r=await inspect('<Invoice/>',{url:k.url}); k.close();
 assert.equal(r.status,200); assert.equal(r.body.verdict,'REJECT'); assert.equal(r.body.scenario,'EN16931 (UBL Invoice)');
});
test('KoSIT 406 is a paid REJECT inspection, still HTTP 200 to the buyer',async()=>{
 const k=await kosit(406,report({assessment:'reject'}));
 const r=await inspect('<Invoice/>',{url:k.url}); k.close();
 assert.equal(r.status,200); assert.equal(r.body.verdict,'REJECT'); assert.equal(r.body.httpStatus,406);
});
test('a report from another validator or XRechnung release is no inspection: 502, so the middleware does not settle',async()=>{
 for(const [status,body] of [[200,report({engine:'KoSIT Validator 1.4.2'})],[200,report({engine:null})],[200,report({xrechnung:'2.3.1'})],[406,report({engine:'KoSIT Validator 1.4.2',assessment:'reject'})]]){
  const k=await kosit(status,body);
  const r=await inspect('<Invoice/>',{url:k.url}); k.close();
  assert.equal(r.status,502,body); assert.equal(r.body.verdict,undefined); assert.match(r.body.error,/pinned validator/);
 }
});
test('a report about other bytes than the posted body is no inspection: 502, not settled',async()=>{
 for(const body of [report({about:'<Invoice>other</Invoice>'}),report({hash:null})]){
  const k=await kosit(200,body);
  const r=await inspect('<Invoice/>',{url:k.url}); k.close();
  assert.equal(r.status,502); assert.equal(r.body.verdict,undefined);
 }
});
test('other KoSIT status is 502, so the middleware does not settle; the raw KoSIT body stays server-side',async()=>{
 const k=await kosit(500,'<html>java.lang.OutOfMemoryError at de.kosit.validationtool.daemon.Handler</html>');
 const r=await inspect('<Invoice/>',{url:k.url}); k.close();
 assert.equal(r.status,502); assert.equal(r.body.verdict,undefined);
 assert.doesNotMatch(JSON.stringify(r.body),/OutOfMemoryError|validationtool/);
});
test('unreachable KoSIT is 503, so the middleware does not settle; the internal KoSIT URL is not sent',async()=>{
 const k=await kosit(200); const url=k.url; k.close();
 const r=await inspect('<Invoice/>',{url});
 assert.equal(r.status,503); assert.match(r.body.error,/unreachable/);
 assert.doesNotMatch(JSON.stringify(r.body),/127\.0\.0\.1/);
});
// DELTA-X402-1: res.text() rejected outside the try, and the unhandled rejection ended the seller process.
test('KoSIT breaking off or stalling in the middle of its answer is 503 (not charged), never an exception',async()=>{
 for(const mode of ['drop','stall']){
  const server=createServer((req,res)=>{ req.resume(); req.on('end',()=>{ res.writeHead(200,{'content-type':'application/xml'}); res.write('<rep:report>'); if(mode==='drop') setTimeout(()=>res.socket.destroy(),50); }); });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
   const r=await inspect('<Invoice/>',{url:`http://127.0.0.1:${server.address().port}/`,timeoutMs:300});
   assert.equal(r.status,503,mode); assert.equal(r.body.verdict,undefined,mode); assert.equal(r.body.charged,false,mode);
  }finally{ server.closeAllConnections(); server.close(); }
 }
});
// DELTA-X402-2: the buyer resends a 502/504 that may still settle; these answers say they never will.
test('every answer without an inspection says charged:false; a completed inspection does not',async()=>{
 for(const [status,body] of [[200,report({engine:'KoSIT Validator 1.4.2'})],[200,report({about:'<Invoice>other</Invoice>'})],[422,'error while processing the xml file'],[500,'<html>boom</html>']]){
  const k=await kosit(status,body);
  const r=await inspect('<Invoice/>',{url:k.url}); k.close();
  assert.equal(r.status,502,`${status}`); assert.equal(r.body.charged,false,`${status}`);
 }
 const k=await kosit(200); const url=k.url; k.close();
 assert.equal((await inspect('<Invoice/>',{url})).body.charged,false);
 const ok=await kosit(200,report());
 assert.equal('charged' in (await inspect('<Invoice/>',{url:ok.url})).body,false); ok.close();
});
test('stub mode answers ACCEPTABLE without calling KoSIT',async()=>{
 const r=await inspect('<Invoice/>',{url:'http://127.0.0.1:1/',stub:true});
 assert.equal(r.status,200); assert.equal(r.body.verdict,'ACCEPTABLE');
});
