import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {parseFixed} from '../einvoice/parse-fixed.mjs';
import {buildXml} from '../einvoice/build.mjs';
import {validate,kositAvailable,parseReport,assertPinnedValidator,assertDocumentHash,documentHashOf} from './kosit.mjs';

const skip=await kositAvailable()?false:'KoSIT not running on 127.0.0.1:8090 (start it with kosit/start.sh)';
const fixture=name=>readFileSync(new URL(`../fixtures/${name}`,import.meta.url),'utf8');

test('scenario pin: plain EN16931 CustomizationID passes KoSIT (HTTP 200) but is not accepted',{skip},async()=>{
 const xml=(await buildXml(parseFixed(fixture('d-reparatur-ohne-bt10.fixed.txt'))))
  .replace(/<cbc:CustomizationID>[^<]*<\/cbc:CustomizationID>/,'<cbc:CustomizationID>urn:cen.eu:en16931:2017</cbc:CustomizationID>');
 const r=await validate(xml);
 assert.equal(r.httpStatus,200);
 assert.equal(r.scenario,'EN16931 (UBL Invoice)');
 assert.equal(r.accepted,false);
 assert.deepEqual(r.messages.map(m=>m.code),['KOSIT-SCENARIO']);
});

test('non-invoice XML is rejected without a matched scenario',{skip},async()=>{
 const r=await validate('<foo/>');
 assert.equal(r.httpStatus,406);
 assert.equal(r.scenario,null);
 assert.equal(r.accepted,false);
});

test('report parser reads scenario, levels, codes and decodes entities',()=>{
 const r=parseReport('<rep:report><rep:scenarioMatched><s:scenario><s:name>X</s:name></s:scenario></rep:scenarioMatched><rep:message id="1" level="information" xpathLocation="/a" code="BR-DE-27">[BR-DE-27] &quot;Tel&quot; &amp; mehr</rep:message><rep:assessment><rep:accept/></rep:assessment></rep:report>');
 assert.deepEqual(r,{scenario:'X',messages:[{level:'information',code:'BR-DE-27',text:'[BR-DE-27] "Tel" & mehr'}],assessment:'accept',engine:null,xrechnungVersion:null,documentHash:null});
});

// A minimal accepting report for the pinned scenario, as KoSIT 1.6.3 writes it (description wrapped like the real one).
const report=({engine='KoSIT Validator 1.6.3',xrechnung='3.0.2'}={})=>`<rep:report><rep:engine><rep:name>${engine}</rep:name></rep:engine><rep:scenarioMatched><s:scenario><s:name>EN16931 XRechnung (UBL Invoice)</s:name><s:description><s:p>Validates UBL Invoice in version 2.1</s:p><s:p>Uses UBL Invoice 2.1 XML Schema,                 Schematron rules from EN16931:2017, and XRechnung
                 ${xrechnung} </s:p></s:description></s:scenario></rep:scenarioMatched><rep:assessment><rep:accept/></rep:assessment></rep:report>`;

test('the verdict counts only from the pinned validator and XRechnung release, otherwise nothing was inspected',async()=>{
 const ok=await withFakeKosit(200,report(),()=>validate('<Invoice/>'));
 assert.equal(ok.accepted,true);assert.equal(ok.engine,'KoSIT Validator 1.6.3');
 await withFakeKosit(200,report({engine:'KoSIT Validator 1.4.2'}),()=>assert.rejects(validate('<Invoice/>'),/„KoSIT Validator 1\.4\.2“, festgelegt ist „KoSIT Validator 1\.6\.3“; die Rechnung wurde nicht beurteilt/));
 await withFakeKosit(406,report({engine:'KoSIT Validator 1.4.2'}).replace('<rep:accept/>','<rep:reject/>'),()=>assert.rejects(validate('<Invoice/>'),/KoSIT Validator 1\.4\.2/));
 await withFakeKosit(200,report({xrechnung:'2.3.1'}),()=>assert.rejects(validate('<Invoice/>'),/XRechnung 3\.0\.2/));
 await withFakeKosit(200,report({xrechnung:'3.0.20'}),()=>assert.rejects(validate('<Invoice/>'),/XRechnung 3\.0\.2/));
 assertPinnedValidator(parseReport(report()));
 assert.throws(()=>assertPinnedValidator(parseReport('<stub>GUTACHTER_STUB=1</stub>')),/keine Version/,'reports from elsewhere (x402) use the same pin');
});

// KoSIT names the bytes it judged: rep:documentHash is base64(sha256(document)), as in the real 1.6.3 reports.
test('a report counts only for the bytes it names (rep:documentHash), else nothing was inspected',()=>{
 const xml='<Invoice>ä</Invoice>';
 assert.equal(documentHashOf(xml),createHash('sha256').update(Buffer.from(xml,'utf8')).digest('base64'));
 const named=hash=>parseReport(report().replace('<rep:engine>',`<rep:documentIdentification><rep:documentHash><rep:hashAlgorithm>SHA-256</rep:hashAlgorithm><rep:hashValue>${hash}</rep:hashValue></rep:documentHash><rep:documentReference>supplied_instance_1</rep:documentReference></rep:documentIdentification><rep:engine>`));
 assert.equal(named(documentHashOf(xml)).documentHash,documentHashOf(xml));
 assertDocumentHash(named(documentHashOf(xml)),xml);
 assert.throws(()=>assertDocumentHash(named(documentHashOf('<Invoice>other</Invoice>')),xml),/anderen Dokument.*die Rechnung wurde nicht beurteilt/);
 assert.throws(()=>assertDocumentHash(parseReport(report()),xml),/documentHash fehlt/);
});

// A fake KoSIT on an ephemeral port answering every POST with one status. KOSIT_URL/KOSIT_PORT are read per call.
async function withFakeKosit(status,body,run,env=port=>({KOSIT_URL:`http://127.0.0.1:${port}/`})){
 const server=createServer((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(status,{'content-type':'text/html'});res.end(body);});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const saved={KOSIT_URL:process.env.KOSIT_URL,KOSIT_PORT:process.env.KOSIT_PORT};
 for(const k of Object.keys(saved))delete process.env[k];
 Object.assign(process.env,env(server.address().port));
 try{return await run();}
 finally{server.close();for(const [k,v] of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;}
}

test('KoSIT 5xx: the invoice was not inspected, validate() throws instead of reporting a defect',async()=>{
 for(const status of [500,502,503])
  await withFakeKosit(status,'<html>Service Unavailable</html>',()=>assert.rejects(validate('<Invoice/>'),new RegExp(`KoSIT-Prüfdienst nicht verfügbar \\(HTTP ${status}\\); die Rechnung wurde nicht beurteilt`)));
 const r=await withFakeKosit(422,'error while processing the xml file',()=>validate('not xml'));
 assert.equal(r.accepted,false);
 assert.deepEqual(r.messages.map(m=>[m.level,m.code]),[['error','KOSIT-HTTP-422']]);
});

// The KoSIT 1.6.3 daemon answers 200/406 (report) or 400/422 (document unreadable). Anything else comes from a wrong
// URL or a proxy, never from an inspection: no Mängelrüge against a correct delivery.
test('statuses KoSIT never sends (401, 403, 404, 429, 204) are not inspected; 400 and 422 stay defects of the document',async()=>{
 for(const status of [401,403,404,429,204])
  await withFakeKosit(status,'<html>Not Found</html>',()=>assert.rejects(validate('<Invoice/>'),new RegExp(`\\(HTTP ${status}\\); die Rechnung wurde nicht beurteilt`)),undefined);
 for(const status of [400,422]){
  const r=await withFakeKosit(status,'',()=>validate('<Invoice/>'));
  assert.equal(r.accepted,false); assert.deepEqual(r.messages.map(m=>m.code),[`KOSIT-HTTP-${status}`]);
 }
});

// A Gutachter answer reaches parseReport before the validator pin (buero/abnahme.mjs kositFromReport): the PoC inputs
// of DELTA-VERIFIER-2 took 48 s (description), 2.1 s (documentHash) and 2.3 s (message) with the old regexes.
test('parseReport is linear on hostile reports and refuses a report over its size limit',{timeout:20000},()=>{
 for(const [name,hostile] of [
  ['description',`${'<rep:scenarioMatched><s:scenario>'.repeat(3000)}${'<s:description>'.repeat(3000)}`],
  ['documentHash','<rep:documentHash>'.repeat(29000)],
  ['message','<rep:message>'.repeat(40000)],
  ['description tags',`<rep:scenarioMatched><s:scenario><s:description>${'<'.repeat(200000)}</s:description>`],
  ['version',`<rep:scenarioMatched><s:scenario><s:description>${'XRechnung 1.'.repeat(40000)}</s:description>`],
 ]){
  const started=performance.now(); parseReport(hostile);
  assert.ok(performance.now()-started<1000,`${name}: ${Math.round(performance.now()-started)} ms`);
 }
 assert.throws(()=>parseReport(`<rep:report>${' '.repeat(16*1024*1024)}</rep:report>`),/KoSIT-Bericht ist größer als 16 MiB; die Rechnung wurde nicht beurteilt/);
});

test('a busy KoSIT that answers its health check after 3 s still counts as running',async()=>{
 const server=createServer((req,res)=>setTimeout(()=>{res.writeHead(200);res.end('ok');},3000));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const before=process.env.KOSIT_URL;process.env.KOSIT_URL=`http://127.0.0.1:${server.address().port}/`;
 try{assert.equal(await kositAvailable(),true);}
 finally{before===undefined?delete process.env.KOSIT_URL:process.env.KOSIT_URL=before;server.close();}
});

test('an XML over 5 MB (the Gutachter limit) is a defect and never reaches KoSIT; 5 MB exactly is posted',async()=>{
 let posts=0;
 const big=n=>`<Invoice>${'x'.repeat(n-'<Invoice></Invoice>'.length)}</Invoice>`;
 const counted=async xml=>{
  const server=createServer((req,res)=>{posts++;req.resume();req.on('end',()=>{res.writeHead(200);res.end(report());});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const before=process.env.KOSIT_URL;process.env.KOSIT_URL=`http://127.0.0.1:${server.address().port}/`;
  try{return await validate(xml);}finally{before===undefined?delete process.env.KOSIT_URL:process.env.KOSIT_URL=before;server.close();}
 };
 const over=await counted(big(5*1024*1024+1));
 assert.equal(posts,0);assert.equal(over.accepted,false);assert.equal(over.httpStatus,413);
 assert.deepEqual(over.messages.map(m=>[m.level,m.code]),[['error','KOSIT-SIZE']]);
 assert.match(over.messages[0].text,/größer als 5 MB/);
 const at=await counted(big(5*1024*1024));
 assert.equal(posts,1);assert.equal(at.accepted,true);
});

test('KOSIT_PORT alone points the client at another daemon (kosit/start.sh honours it too)',async()=>{
 await withFakeKosit(503,'down',()=>assert.rejects(validate('<Invoice/>'),/HTTP 503/),port=>({KOSIT_PORT:String(port)}));
});
