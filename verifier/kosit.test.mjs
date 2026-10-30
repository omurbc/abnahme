import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseFixed} from '../einvoice/parse-fixed.mjs';
import {buildXml} from '../einvoice/build.mjs';
import {validate,kositAvailable,parseReport} from './kosit.mjs';

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
 assert.deepEqual(r,{scenario:'X',messages:[{level:'information',code:'BR-DE-27',text:'[BR-DE-27] "Tel" & mehr'}],assessment:'accept'});
});
