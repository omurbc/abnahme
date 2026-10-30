import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseFixed} from './parse-fixed.mjs';
import {buildXml,invoiceData} from './build.mjs';
import {validate,kositAvailable,XRECHNUNG_UBL_SCENARIO} from '../verifier/kosit.mjs';
import {runChecks} from '../verifier/checks.mjs';
import {loadProfile} from '../verifier/profile.mjs';
import {parseXml} from '../verifier/xml.mjs';

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

test('line nets and VAT are rounded half-up like a paper invoice, also where binary floats fall below the half cent',()=>{
 const a=parseFixed(fixture('a-reparatur-hv-giesing.fixed.txt'));
 const invoice=lines=>invoiceData({...a,lines:lines.map(([quantity,unitPrice])=>({...a.lines[0],quantity,unitPrice}))})['ubl:Invoice'];
 const nets=lines=>invoice(lines)['cac:InvoiceLine'].map(l=>l['cbc:LineExtensionAmount']);
 assert.deepEqual(nets([[0.5,2.01],[0.25,0.58]]),['1.01','0.15']);
 // Quarter quantities x cent prices: exact half-up in integers is floor((q*p+2)/4) cents for quantity q/4, price p cents.
 for(let q=1;q<=40;q++){
  const prices=Array.from({length:1000},(_,k)=>k+1);
  assert.deepEqual(nets(prices.map(p=>[q/4,p/100])),prices.map(p=>(Math.floor((q*p+2)/4)/100).toFixed(2)),`quantity ${q/4}`);
 }
 // Negative taxable amount on a half cent: -0,50 x 19 % = -0,095 -> -0,10 (symmetric), not -0,09.
 assert.equal(invoice([[1,-0.5]])['cac:TaxTotal'][0]['cbc:TaxAmount'],'-0.10');
});

// xmlbuilder2 4.0.3 leaves "&name;" and "&#digits;" unescaped (nonEntityAmpersandRegex), so "R&D;" became the
// undeclared entity &D; and KoSIT answered 422 (DELTA-VERIFIER-7).
test('free text with entity-like "&" sequences is carried through literally and stays well-formed',async()=>{
 const text='Zahlbar sofort. R&D; Abteilung, &#65; &lt;b&gt; & <i>mehr</i> &amp;';
 const a=parseFixed(fixture('a-reparatur-hv-giesing.fixed.txt'));
 const xml=await buildXml({...a,paymentTerms:text,lines:a.lines.map(l=>({...l,description:text}))});
 const doc=parseXml(xml),texts=[];
 const walk=e=>{if(e.name==='Note'&&e.text.includes('Zahlbar sofort'))texts.push(e.text);if(e.name==='Name'&&e.text.includes('Zahlbar sofort'))texts.push(e.text);e.children.forEach(walk);};
 walk(doc);
 assert.deepEqual(texts,Array(4).fill(text));
});

test('the § 13b note and the line categories must agree',async()=>{
 await assert.rejects(buildXml({...parseFixed(fixture('a-reparatur-hv-giesing.fixed.txt')),reverseCharge:true}),/§ 13b UStG.*Steuerkategorien/);
 await assert.rejects(buildXml({...parseFixed(fixture('b-abschlag-13b-bau-isar.fixed.txt')),reverseCharge:false}),/§ 13b UStG.*Steuerkategorien/);
});

test('the fixed-layout parser accepts only the invoice types the builder supports',()=>{
 for(const type of ['877','325','389'])
  assert.throws(()=>parseFixed(fixture('a-reparatur-hv-giesing.fixed.txt').replace('invoiceType: 380',`invoiceType: ${type}`)),/invoiceType must be 380 or 875/);
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

test('an invoice without Leistungsdatum passes KoSIT (information only) but is ABGELEHNT',{skip},async()=>{
 const {acceptance,recipient}=loadProfile('hv-giesing');
 const fields={...parseFixed(fixture('a-reparatur-hv-giesing.fixed.txt')),serviceDate:null};
 const xml=await buildXml(fields);
 const kosit=await validate(xml,{scenario:acceptance.scenario});
 assert.equal(kosit.accepted,true);
 assert.deepEqual(kosit.messages.map(m=>`${m.level}:${m.code}`),['information:BR-DE-TMP-32']);
 const checks=runChecks({xml,kosit,acceptance,recipient,expectedTotal:527.17});
 assert.equal(checks.passed,false);
 assert.deepEqual(checks.failures.map(f=>f.code),['BR-DE-TMP-32']);
 assert.match(checks.failures[0].textDe,/§ 14 Abs\. 4 Satz 1 Nr\. 6 UStG/);
});
