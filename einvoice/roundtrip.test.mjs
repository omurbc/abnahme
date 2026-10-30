import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseFixed} from './parse-fixed.mjs';
import {buildXml} from './build.mjs';
import {validate,kositAvailable,XRECHNUNG_UBL_SCENARIO} from '../verifier/kosit.mjs';
import {runChecks} from '../verifier/checks.mjs';
import {loadProfile} from '../verifier/profile.mjs';

const fixture=name=>readFileSync(new URL(`../fixtures/${name}`,import.meta.url),'utf8');
const skip=await kositAvailable()?false:'KoSIT not running on 127.0.0.1:8090 (start it with kosit/start.sh)';
const CASES=[
 {name:'a-reparatur-hv-giesing',recipient:'hv-giesing',httpStatus:200,passed:true,codes:[]},
 {name:'b-abschlag-13b-bau-isar',recipient:'bau-isar',httpStatus:200,passed:true,codes:[]},
 {name:'c-abschlag-13b-ohne-ustid',recipient:'bau-isar',httpStatus:406,passed:false,codes:['BR-AE-02','ABN-BT48']},
 {name:'d-reparatur-ohne-bt10',recipient:'hv-giesing',httpStatus:406,passed:false,codes:['BR-DE-15','ABN-BT10']},
];

test('fixed-layout fixtures parse into the flat fields',()=>{
 const b=parseFixed(fixture('b-abschlag-13b-bau-isar.fixed.txt'));
 assert.equal(b.invoiceType,'875');
 assert.equal(b.reverseCharge,true);
 assert.equal(b.buyerVatId,'DE287654321');
 assert.deepEqual(b.lines[1],{description:'Unterverteilungen UV-1 bis UV-4 geliefert und montiert',quantity:4,unit:'H87',unitPrice:1450,vatCategory:'AE',vatRate:0});
 assert.equal(parseFixed(fixture('c-abschlag-13b-ohne-ustid.fixed.txt')).buyerVatId,null);
 assert.equal(parseFixed(fixture('d-reparatur-ohne-bt10.fixed.txt')).buyerReference,null);
 assert.throws(()=>parseFixed('Rechnung 123'),/ABNAHME-FIXED\/1/);
 assert.throws(()=>parseFixed('ABNAHME-FIXED/1\ninvoiceNumber: 1\nfoo: bar'),/Unknown key foo/);
});

test('build leaves CustomizationID to the library: XRechnung 3.0, never plain EN16931',async()=>{
 const xml=await buildXml(parseFixed(fixture('a-reparatur-hv-giesing.fixed.txt')));
 assert.match(xml,/<cbc:CustomizationID>urn:cen\.eu:en16931:2017#compliant#urn:xeinkauf\.de:kosit:xrechnung_3\.0<\/cbc:CustomizationID>/);
 assert.match(xml,/<cbc:PayableAmount currencyID="EUR">527\.17<\/cbc:PayableAmount>/);
 const b=await buildXml(parseFixed(fixture('b-abschlag-13b-bau-isar.fixed.txt')));
 assert.match(b,/<cbc:InvoiceTypeCode>875<\/cbc:InvoiceTypeCode>/);
 assert.match(b,/<cbc:TaxExemptionReasonCode>VATEX-EU-AE<\/cbc:TaxExemptionReasonCode>/);
});

for(const c of CASES){
 test(`round trip ${c.name} -> ${c.recipient}: ${c.passed?'abgenommen':c.codes.join(' + ')}`,{skip},async()=>{
  const {acceptance,recipient}=loadProfile(c.recipient);
  const fields=parseFixed(fixture(`${c.name}.fixed.txt`));
  const xml=await buildXml(fields);
  const kosit=await validate(xml,{scenario:acceptance.scenario});
  assert.equal(kosit.httpStatus,c.httpStatus,JSON.stringify(kosit.messages));
  assert.equal(kosit.scenario,XRECHNUNG_UBL_SCENARIO);
  assert.equal(kosit.accepted,c.httpStatus===200);
  const checks=runChecks({xml,kosit,acceptance,recipient,expectedTotal:fields.grossTotal});
  assert.equal(checks.passed,c.passed,JSON.stringify(checks.failures));
  assert.deepEqual(checks.failures.map(f=>f.code),c.codes);
  for(const f of checks.failures)assert.ok(f.textDe&&!/^BR-|^\[/.test(f.textDe),`German text for ${f.code}: ${f.textDe}`);
 });
}
