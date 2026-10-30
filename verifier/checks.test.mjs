import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseFixed} from '../einvoice/parse-fixed.mjs';
import {buildXml} from '../einvoice/build.mjs';
import {runChecks,invoiceFacts} from './checks.mjs';
import {loadProfile} from './profile.mjs';
import {validate,kositAvailable} from './kosit.mjs';

const fields=name=>parseFixed(readFileSync(new URL(`../fixtures/${name}.fixed.txt`,import.meta.url),'utf8'));
const ok={accepted:true,httpStatus:200,scenario:'EN16931 XRechnung (UBL Invoice)',messages:[]};
const check=async(fixtureName,recipientId,{change={},kosit=ok,expectedTotal,today}={})=>{
 const f={...fields(fixtureName),...change};
 const {acceptance,recipient}=loadProfile(recipientId);
 return runChecks({xml:await buildXml(f),kosit,acceptance,recipient,expectedTotal:expectedTotal===undefined?f.grossTotal:expectedTotal,today});
};
const codes=r=>r.failures.map(f=>f.code);

test('facts are read from the delivered XML',async()=>{
 const facts=invoiceFacts(await buildXml(fields('b-abschlag-13b-bau-isar')));
 assert.deepEqual(facts,{invoiceNumber:'AR-2026-0087',payableAmount:'18400.00',sellerVatIds:['DE312456789'],buyerVatIds:['DE287654321'],ibans:['DE20701500000012345678'],lineCategories:['AE','AE'],breakdownCategories:['AE'],buyerReference:'BV-2026-014',
  buyerName:'Bau Isar Generalunternehmer GmbH',buyerPostcode:'81671',issueDate:'2026-10-28',dueDate:null,invoiceType:'875',currency:'EUR',taxCurrency:null,currencyIds:Array(11).fill('EUR'),notes:['Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG)'],
  taxSubtotals:[{category:'AE',percent:'0',taxable:'18400.00',tax:'0.00',reason:'Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG)'}],
  lineTaxCategories:[{category:'AE',percent:'0'},{category:'AE',percent:'0'}],allowanceChargeTaxCategories:[],taxInclusiveAmount:'18400.00',prepaidAmounts:[]});
});

test('clean invoices pass for their recipient',async()=>{
 assert.deepEqual(await check('a-reparatur-hv-giesing','hv-giesing'),{passed:true,failures:[],minor:[]});
 assert.deepEqual(await check('b-abschlag-13b-bau-isar','bau-isar'),{passed:true,failures:[],minor:[]});
});

test('payable amount must equal the expected total',async()=>{
 const r=await check('a-reparatur-hv-giesing','hv-giesing',{expectedTotal:500});
 assert.deepEqual(codes(r),['ABN-BETRAG']);
 assert.match(r.failures[0].textDe,/527,17 €.*500,00 €/);
 assert.deepEqual(codes(await check('a-reparatur-hv-giesing','hv-giesing',{expectedTotal:null})),['ABN-BETRAG']);
});

test('seller IBAN and VAT ID must match the master data',async()=>{
 const iban=await check('a-reparatur-hv-giesing','hv-giesing',{change:{sellerIban:'DE13701500000098765432'}});
 assert.deepEqual(codes(iban),['ABN-IBAN']);
 assert.match(iban.failures[0].textDe,/DE13701500000098765432 weicht von der hinterlegten IBAN/);
 assert.deepEqual(codes(await check('a-reparatur-hv-giesing','hv-giesing',{change:{sellerIban:'DE20 7015 0000 0012 3456 78'}})),[]);
 assert.deepEqual(codes(await check('a-reparatur-hv-giesing','hv-giesing',{change:{sellerVatId:'DE999999999'}})),['ABN-USTID','ABN-IBAN']);
});

test('§ 13b recipient requires category AE and its own VAT ID in BT-48',async()=>{
 const regular={reverseCharge:false,lines:fields('b-abschlag-13b-bau-isar').lines.map(l=>({...l,vatCategory:'S',vatRate:19}))};
 const s=await check('b-abschlag-13b-bau-isar','bau-isar',{change:regular,expectedTotal:21896});
 assert.deepEqual(codes(s),['ABN-13B','ABN-STEUERSATZ']);
 assert.deepEqual(codes(await check('b-abschlag-13b-bau-isar','bau-isar',{change:{buyerVatId:'DE111111111'}})),['ABN-BT48']);
 assert.deepEqual(codes(await check('c-abschlag-13b-ohne-ustid','bau-isar')),['ABN-BT48']);
});

test('a non-§ 13b recipient must not receive category AE',async()=>{
 const ae={reverseCharge:true,lines:fields('a-reparatur-hv-giesing').lines.map(l=>({...l,vatCategory:'AE',vatRate:0}))};
 assert.deepEqual(codes(await check('a-reparatur-hv-giesing','hv-giesing',{change:ae,expectedTotal:443})),['ABN-13B','ABN-STEUERSATZ']);
});

test('BT-10 must match the recipient pattern',async()=>{
 const r=await check('a-reparatur-hv-giesing','hv-giesing',{change:{buyerReference:'BV-2026-014'}});
 assert.deepEqual(codes(r),['ABN-BT10']);
 assert.match(r.failures[0].textDe,/passt nicht zum Muster/);
 assert.deepEqual(codes(await check('d-reparatur-ohne-bt10','hv-giesing')),['ABN-BT10']);
});

test('KoSIT information and warning messages are minor, errors are failures in German',async()=>{
 const info={...ok,messages:[{level:'information',code:'BR-DE-27',text:'[BR-DE-27] Telefonnummer hat zu wenige Ziffern.'},{level:'warning',code:'BR-DE-19',text:'[BR-DE-19] IBAN prüfen.'}]};
 const r=await check('a-reparatur-hv-giesing','hv-giesing',{kosit:info});
 assert.equal(r.passed,true);
 assert.deepEqual(r.minor,[{code:'BR-DE-27',level:'information',textDe:'Telefonnummer hat zu wenige Ziffern.'},{code:'BR-DE-19',level:'warning',textDe:'IBAN prüfen.'}]);
 const rejected={accepted:false,httpStatus:406,scenario:ok.scenario,messages:[{level:'error',code:'BR-CO-15',text:'[BR-CO-15]-Invoice total amount with VAT (BT-112) = ...'}]};
 const e=await check('a-reparatur-hv-giesing','hv-giesing',{kosit:rejected});
 assert.equal(e.passed,false);
 assert.deepEqual(e.failures,[{code:'BR-CO-15',textDe:'Der Gesamtbetrag einschließlich Umsatzsteuer (BT-112) muss dem Betrag ohne Umsatzsteuer (BT-109) zuzüglich der Umsatzsteuer (BT-110) entsprechen.'}]);
 const unknown=await check('a-reparatur-hv-giesing','hv-giesing',{kosit:{...ok,messages:[{level:'fatal',code:'X-1',text:'boom'}]}});
 assert.deepEqual(codes(unknown),['X-1']);
 assert.equal(unknown.passed,false);
});

test('the buyer named in the invoice must be the recipient of the profile',async()=>{
 const bauIsar={buyerName:'Bau Isar Generalunternehmer GmbH',buyerStreet:'Rosenheimer Straße 145',buyerPostcode:'81671'};
 const wrong=await check('a-reparatur-hv-giesing','hv-giesing',{change:bauIsar});
 assert.deepEqual(codes(wrong),['ABN-KAEUFER']);
 assert.match(wrong.failures[0].textDe,/Bau Isar Generalunternehmer GmbH, 81671.*Hausverwaltung Giesing GmbH, 81539/);
 assert.deepEqual(codes(await check('a-reparatur-hv-giesing','hv-giesing',{change:{buyerPostcode:'81671'}})),['ABN-KAEUFER']);
 assert.deepEqual(codes(await check('a-reparatur-hv-giesing','hv-giesing',{change:{buyerName:'Hausverwaltung  Giesing GMBH'}})),[],'spacing and case are not another buyer');
});

test('the invoice date is not in the future and the due date not before it',async()=>{
 assert.deepEqual(codes(await check('a-reparatur-hv-giesing','hv-giesing',{today:'2026-10-27'})),['ABN-DATUM']);
 assert.deepEqual(codes(await check('a-reparatur-hv-giesing','hv-giesing',{today:'2026-10-28'})),[]);
 const due=await check('a-reparatur-hv-giesing','hv-giesing',{change:{dueDate:'2026-10-01'},today:'2026-10-30'});
 assert.deepEqual(codes(due),['ABN-DATUM']);
 assert.match(due.failures[0].textDe,/Fälligkeitsdatum \(BT-9\) 2026-10-01 liegt vor dem Rechnungsdatum \(BT-2\) 2026-10-28/);
 assert.deepEqual(codes(await check('a-reparatur-hv-giesing','hv-giesing',{change:{dueDate:'2026-11-11'},today:'2026-10-30'})),[]);
 assert.deepEqual(codes(await check('a-reparatur-hv-giesing','hv-giesing',{change:{invoiceDate:'2099-01-01'}})),['ABN-DATUM'],'default today is the Berlin date now');
});

test('KoSIT notes that make the invoice unusable are failures despite their level',async()=>{
 const notes=[
  ['information','BR-DE-TMP-32',/Leistungsdatum.*§ 14 Abs\. 4 Satz 1 Nr\. 6 UStG/],
  ['warning','BR-DE-17',/Rechnungsart \(BT-3\)/],
  ['warning','BR-DE-26',/vorausgegangene Rechnung \(BG-3\)/],
  ['warning','PEPPOL-EN16931-R120',/Nettobetrag einer Position \(BT-131\)/],
 ];
 for(const [level,code,text] of notes){
  const r=await check('a-reparatur-hv-giesing','hv-giesing',{kosit:{...ok,messages:[{level,code,text:`[${code}] english or german text`}]}});
  assert.equal(r.passed,false,code);
  assert.deepEqual(codes(r),[code]);
  assert.match(r.failures[0].textDe,text);
  assert.deepEqual(r.minor,[]);
 }
});

test('scenario customLevel downgrades are not applied: an error-level message fails although KoSIT accepts',async()=>{
 const r=await check('a-reparatur-hv-giesing','hv-giesing',{kosit:{...ok,messages:[{level:'error',code:'BR-CL-23',text:'[BR-CL-23]-Unit code MUST be coded according to the UN/ECE Recommendation 20'}]}});
 assert.equal(r.passed,false);
 assert.deepEqual(codes(r),['BR-CL-23']);
});

test('free text is carried through escaped and never reaches the checked fields',async()=>{
 const sneaky=`<!--</cbc:ID><cbc:ID>${'DE96000000000000000666'}</cbc:ID>]]>-->& "Rabatt"`;
 const f={...fields('a-reparatur-hv-giesing'),paymentTerms:sneaky};
 f.lines=f.lines.map(l=>({...l,description:sneaky}));
 const xml=await buildXml(f);
 assert.equal(xml.includes('<!--'),false);
 assert.deepEqual(invoiceFacts(xml).ibans,['DE20701500000012345678']);
 assert.deepEqual(codes(checkXml(xml,'hv-giesing',527.17)),[]);
 assert.match(loadProfile('hv-giesing').acceptance.beschreibung,/Freitexte .* werden nicht inhaltlich geprüft/);
});

test('a KoSIT rejection without messages still fails',async()=>{
 const r=await check('a-reparatur-hv-giesing','hv-giesing',{kosit:{accepted:false,httpStatus:406,scenario:null,messages:[]}});
 assert.deepEqual(codes(r),['KOSIT-REJECT']);
});

// A converter's delivery is untrusted: the checks must read the same document KoSIT and the recipient's ERP read.
const MASTER='DE20701500000012345678',ATTACKER='DE96000000000000000666';
const checkXml=(xml,recipientId,expectedTotal)=>{const {acceptance,recipient}=loadProfile(recipientId);return runChecks({xml,kosit:ok,acceptance,recipient,expectedTotal});};
const swap=(xml,from,to)=>{const out=xml.replace(from,to);assert.notEqual(out,xml,`no match for ${from}`);return out;};
const inflate=xml=>xml.replaceAll('12600.00','22600.00').replace('>12600<','>22600<').replaceAll('18400.00','28400.00');
const EXT='xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"';
const decoys={
 ibanComment:b=>swap(b,`<cbc:ID>${MASTER}</cbc:ID>`,`<!--<cbc:ID>${MASTER}</cbc:ID>--><cbc:ID>${ATTACKER}</cbc:ID>`),
 amountComment:b=>swap(inflate(b),'<cbc:PayableAmount currencyID="EUR">28400.00</cbc:PayableAmount>','<!--<cbc:PayableAmount currencyID="EUR">18400.00</cbc:PayableAmount>--><cbc:PayableAmount currencyID="EUR">28400.00</cbc:PayableAmount>'),
 // KoSIT only warns (UBL-CR-001) about extensions; a consistent fake total inside one is otherwise valid.
 amountExtension:b=>swap(swap(inflate(b),'xmlns:cbc=',`${EXT} xmlns:cbc=`),'<cbc:CustomizationID>','<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent><w:W xmlns:w="urn:x"><cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="EUR">28400.00</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="EUR">28400.00</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="EUR">28400.00</cbc:TaxInclusiveAmount><cbc:PrepaidAmount currencyID="EUR">10000.00</cbc:PrepaidAmount><cbc:PayableAmount currencyID="EUR">18400.00</cbc:PayableAmount></cac:LegalMonetaryTotal></w:W></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions><cbc:CustomizationID>'),
};

test('comments cannot show the checks another IBAN, amount or BT-48 than KoSIT reads',async()=>{
 const b=await buildXml(fields('b-abschlag-13b-bau-isar'));
 assert.deepEqual(codes(checkXml(decoys.ibanComment(b),'bau-isar',18400)),['ABN-IBAN']);
 assert.deepEqual(codes(checkXml(decoys.amountComment(b),'bau-isar',18400)),['ABN-BETRAG']);
 const c=await buildXml(fields('c-abschlag-13b-ohne-ustid'));
 const bt47=swap(c,'<cac:PartyLegalEntity>\n\t\t\t\t<cbc:RegistrationName>Bau Isar Generalunternehmer GmbH</cbc:RegistrationName>','<!--<cac:PartyTaxScheme><cbc:CompanyID>DE287654321</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>--><cac:PartyLegalEntity>\n\t\t\t\t<cbc:RegistrationName>Bau Isar Generalunternehmer GmbH</cbc:RegistrationName><cbc:CompanyID>HRB 999999</cbc:CompanyID>');
 assert.deepEqual(codes(checkXml(bt47,'bau-isar',18400)),['ABN-BT48']);
});

test('CDATA and UBL extensions cannot smuggle values past the checks; prefixes are resolved, not matched',async()=>{
 const a=await buildXml(fields('a-reparatur-hv-giesing'));
 const cdata=swap(swap(a,'<cbc:BuyerReference>OBJ-GIE-0417</cbc:BuyerReference>','<cbc:BuyerReference>OBJ-XYZ</cbc:BuyerReference>'),'<cbc:DocumentCurrencyCode>','<cbc:Note><![CDATA[<cbc:BuyerReference>OBJ-GIE-0417</cbc:BuyerReference>]]></cbc:Note><cbc:DocumentCurrencyCode>');
 assert.deepEqual(codes(checkXml(cdata,'hv-giesing',527.17)),['ABN-BT10']);
 const b=await buildXml(fields('b-abschlag-13b-bau-isar'));
 assert.deepEqual(codes(checkXml(decoys.amountExtension(b),'bau-isar',18400)),['ABN-BETRAG']);
 const renamed=swap(a.replaceAll('cbc:','b:'),'xmlns:cbc=','xmlns:b=');
 assert.deepEqual(codes(checkXml(renamed,'hv-giesing',527.17)),[]);
});

test('a delivery that is not plain UBL Invoice XML is refused in German (ABN-XML)',async()=>{
 const a=await buildXml(fields('a-reparatur-hv-giesing'));
 for(const xml of [
  swap(a,'<Invoice ','<!DOCTYPE Invoice><Invoice '),
  swap(a,'encoding="utf-8"','encoding="ISO-8859-1"'),
  a.replace(/<\/Invoice>\s*$/,''),
  a.replaceAll('Invoice-2','CreditNote-2'),
 ]){
  const r=checkXml(xml,'hv-giesing',527.17);
  assert.equal(r.passed,false);
  assert.deepEqual(codes(r),['ABN-XML']);
  assert.match(r.failures[0].textDe,/XML/);
 }
});

const kositSkip=await kositAvailable()?false:'KoSIT not running on 127.0.0.1:8090 (start it with kosit/start.sh)';
test('KoSIT accepts the decoy deliveries, the acceptance test refuses them',{skip:kositSkip},async()=>{
 const {acceptance,recipient}=loadProfile('bau-isar');
 const b=await buildXml(fields('b-abschlag-13b-bau-isar'));
 for(const [name,code] of [['ibanComment','ABN-IBAN'],['amountComment','ABN-BETRAG'],['amountExtension','ABN-BETRAG']]){
  const xml=decoys[name](b);
  const kosit=await validate(xml,{scenario:acceptance.scenario});
  assert.equal(kosit.accepted,true,`${name}: ${JSON.stringify(kosit.messages)}`);
  const r=runChecks({xml,kosit,acceptance,recipient,expectedTotal:18400});
  assert.equal(r.passed,false,name);
  assert.deepEqual(codes(r),[code],name);
 }
});

// Converter deliveries KoSIT accepts without any error: wrong currency, self-billing type, no § 14a Abs. 5 wording,
// VAT overstated within KoSIT's ±0,99 tolerance (BR-CO-17/BR-S-09) with BT-115 unchanged.
const converter={
 usd:b=>swap(b,'<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>','<cbc:DocumentCurrencyCode>USD</cbc:DocumentCurrencyCode>').replaceAll('currencyID="EUR"','currencyID="USD"'),
 type389:a=>swap(a,'<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>','<cbc:InvoiceTypeCode>389</cbc:InvoiceTypeCode>'),
 noWording:b=>swap(swap(b,/<cbc:Note>Steuerschuldnerschaft[^<]*<\/cbc:Note>\s*/,''),/<cbc:TaxExemptionReason>[^<]*<\/cbc:TaxExemptionReason>\s*/,''),
 vatPlus099:a=>swap(swap(a,'<cbc:LineExtensionAmount currencyID="EUR">35.00</cbc:LineExtensionAmount>','<cbc:LineExtensionAmount currencyID="EUR">34.17</cbc:LineExtensionAmount>'),'<cbc:PriceAmount currencyID="EUR">35</cbc:PriceAmount>','<cbc:PriceAmount currencyID="EUR">34.17</cbc:PriceAmount>').replaceAll('443.00','442.17').replaceAll('84.17','85.00'),
};

test('currency, invoice type, § 14a Abs. 5 wording and VAT arithmetic are checked',async()=>{
 const a=await buildXml(fields('a-reparatur-hv-giesing')),b=await buildXml(fields('b-abschlag-13b-bau-isar'));
 const usd=checkXml(converter.usd(b),'bau-isar',18400);
 assert.deepEqual(codes(usd),['ABN-WAEHRUNG']);assert.match(usd.failures[0].textDe,/USD.*EUR/);
 assert.deepEqual(codes(checkXml(swap(b,'<cbc:PayableAmount currencyID="EUR">','<cbc:PayableAmount currencyID="CHF">'),'bau-isar',18400)),['ABN-WAEHRUNG']);
 const t389=checkXml(converter.type389(a),'hv-giesing',527.17);
 assert.deepEqual(codes(t389),['ABN-RECHNUNGSART']);assert.match(t389.failures[0].textDe,/389.*380, 875/);
 assert.deepEqual(codes(checkXml(converter.noWording(b),'bau-isar',18400)),['ABN-13B-HINWEIS']);
 assert.deepEqual(codes(checkXml(swap(b,/<cbc:Note>Steuerschuldnerschaft[^<]*<\/cbc:Note>\s*/,''),'bau-isar',18400)),[],'BT-120 alone carries the wording');
 assert.deepEqual(codes(checkXml(swap(b,/<cbc:TaxExemptionReason>[^<]*<\/cbc:TaxExemptionReason>\s*/,''),'bau-isar',18400)),[],'BT-22 alone carries the wording');
 const vat=checkXml(converter.vatPlus099(a),'hv-giesing',527.17);
 assert.deepEqual(codes(vat),['ABN-UST']);assert.match(vat.failures[0].textDe,/85,00 €.*84,01 €/);
});

test('KoSIT accepts the converter deliveries without an error, the acceptance test refuses them',{skip:kositSkip},async()=>{
 const a=await buildXml(fields('a-reparatur-hv-giesing')),b=await buildXml(fields('b-abschlag-13b-bau-isar'));
 for(const [name,base,recipientId,total,code] of [['usd',b,'bau-isar',18400,'ABN-WAEHRUNG'],['type389',a,'hv-giesing',527.17,'ABN-RECHNUNGSART'],['noWording',b,'bau-isar',18400,'ABN-13B-HINWEIS'],['vatPlus099',a,'hv-giesing',527.17,'ABN-UST']]){
  const {acceptance,recipient}=loadProfile(recipientId);
  const xml=converter[name](base);
  const kosit=await validate(xml,{scenario:acceptance.scenario});
  assert.equal(kosit.accepted,true,name);
  assert.deepEqual(kosit.messages.filter(m=>m.level==='error'),[],name);
  const r=runChecks({xml,kosit,acceptance,recipient,expectedTotal:total});
  assert.deepEqual(codes(r),[code],name);
 }
});

// DELTA-VERIFIER-1: converter deliveries that keep BT-115 at the expected total but change the tax content. KoSIT accepts
// all of them; the recipient profile pins category and rate, and the job declares no prepayment (BT-113).
const prepay=(xml,prepaid,payable)=>swap(xml,/<cbc:PayableAmount currencyID="EUR">[^<]*<\/cbc:PayableAmount>/,`<cbc:PrepaidAmount currencyID="EUR">${prepaid}</cbc:PrepaidAmount><cbc:PayableAmount currencyID="EUR">${payable}</cbc:PayableAmount>`);
const oneLine=(category,rate,unitPrice)=>({reverseCharge:false,lines:[{description:'Reparatur Treppenhausbeleuchtung',quantity:1,unit:'LS',unitPrice,vatCategory:category,vatRate:rate}]});
const tax={
 // (i) lines inflated by 1.000,00 net, VAT 274,17, a fake prepayment of 1.190,00 keeps BT-115 at 527,17
 prepaidA:async()=>prepay(await buildXml({...fields('a-reparatur-hv-giesing'),lines:[...fields('a-reparatur-hv-giesing').lines,{description:'Zusatz',quantity:1,unit:'LS',unitPrice:1000,vatCategory:'S',vatRate:19}]}),'1190.00','527.17'),
 // (ii) the whole amount exempt (E, 0 %, with an exemption reason so that BR-E-10 holds)
 exemptA:async()=>swap(await buildXml({...fields('a-reparatur-hv-giesing'),...oneLine('E',0,527.17)}),/(<cac:TaxSubtotal>[\s\S]*?<cbc:Percent>0<\/cbc:Percent>)/,'$1<cbc:TaxExemptionReason>Steuerfrei nach § 4 Nr. 12 UStG</cbc:TaxExemptionReason>'),
 // (iii) 492,68 net at 7 %, VAT 34,49
 reducedA:async()=>buildXml({...fields('a-reparatur-hv-giesing'),...oneLine('S',7,492.68)}),
 // (iv) Entgelt 28.400,00 to Bau Isar with a fake prepayment of 10.000,00, BT-115 18.400,00
 prepaidB:async()=>prepay(await buildXml({...fields('b-abschlag-13b-bau-isar'),lines:fields('b-abschlag-13b-bau-isar').lines.map((l,i)=>i?l:{...l,unitPrice:22600})}),'10000.00','18400.00'),
};
const TAX_CASES=[['prepaidA','hv-giesing',527.17,'ABN-VORAUSZAHLUNG'],['exemptA','hv-giesing',527.17,'ABN-STEUERSATZ'],['reducedA','hv-giesing',527.17,'ABN-STEUERSATZ'],['prepaidB','bau-isar',18400,'ABN-VORAUSZAHLUNG']];

test('the tax content is bound to the recipient profile: other categories or rates and an undeclared prepayment are refused',async()=>{
 for(const [name,recipientId,total,code] of TAX_CASES){
  const r=checkXml(await tax[name](),recipientId,total);
  assert.deepEqual(codes(r),[code],name);
 }
 const reduced=checkXml(await tax.reducedA(),'hv-giesing',527.17);
 assert.match(reduced.failures[0].textDe,/Kategorie S mit 19 %.*S 7 %/);
 assert.match(checkXml(await tax.prepaidB(),'bau-isar',18400).failures[0].textDe,/Vorauszahlung.*10\.000,00 €.*BT-113/);
 // A rounding amount or another gap between BT-112 and BT-115 is no agreed deduction either.
 const b=await buildXml(fields('b-abschlag-13b-bau-isar'));
 assert.deepEqual(codes(checkXml(swap(b,'<cbc:TaxInclusiveAmount currencyID="EUR">18400.00','<cbc:TaxInclusiveAmount currencyID="EUR">18399.50'),'bau-isar',18400)),['ABN-VORAUSZAHLUNG']);
 assert.deepEqual(codes(checkXml(prepay(b,'0.00','18400.00'),'bau-isar',18400)),[],'a zero prepayment is no deduction');
 assert.deepEqual(loadProfile('hv-giesing').recipient.vat,{category:'S',percent:19});
 assert.deepEqual(loadProfile('bau-isar').recipient.vat,{category:'AE',percent:0});
});

test('KoSIT accepts the tax-content deliveries without an error, the acceptance test refuses them',{skip:kositSkip},async()=>{
 for(const [name,recipientId,total,code] of TAX_CASES){
  const {acceptance,recipient}=loadProfile(recipientId);
  const xml=await tax[name]();
  const kosit=await validate(xml,{scenario:acceptance.scenario});
  assert.equal(kosit.accepted,true,`${name}: ${JSON.stringify(kosit.messages)}`);
  assert.deepEqual(kosit.messages.filter(m=>m.level==='error'),[],name);
  const r=runChecks({xml,kosit,acceptance,recipient,expectedTotal:total});
  assert.equal(r.passed,false,name); assert.deepEqual(codes(r),[code],name);
 }
});

// DELTA-VERIFIER-4: the § 14a Abs. 5 statement must be there word for word; a note that speaks of Steuerschuldnerschaft
// and is not one of the profile's statements (e.g. its negation) is refused.
const NEGATED='Keine Steuerschuldnerschaft des Leistungsempfängers; die Umsatzsteuer schuldet der leistende Unternehmer.';
const NOTE=/<cbc:Note>Steuerschuldnerschaft[^<]*<\/cbc:Note>/,REASON=/<cbc:TaxExemptionReason>[^<]*<\/cbc:TaxExemptionReason>/;
const wording=(b,note,reason)=>{assert.ok(NOTE.test(b)&&REASON.test(b));return b.replace(NOTE,`<cbc:Note>${note}</cbc:Note>`).replace(REASON,`<cbc:TaxExemptionReason>${reason}</cbc:TaxExemptionReason>`);};
test('§ 14a Abs. 5 wording: only the exact statements count, a negating note is refused',async()=>{
 const b=await buildXml(fields('b-abschlag-13b-bau-isar'));
 const negated=checkXml(wording(b,NEGATED,NEGATED),'bau-isar',18400);
 assert.deepEqual(codes(negated),['ABN-13B-HINWEIS']); assert.match(negated.failures[0].textDe,/Keine Steuerschuldnerschaft/);
 assert.deepEqual(codes(checkXml(wording(b,NEGATED,'Steuerschuldnerschaft des Leistungsempfängers'),'bau-isar',18400)),['ABN-13B-HINWEIS'],'an exact BT-120 does not excuse a negating BT-22');
 assert.deepEqual(codes(checkXml(wording(b,'Hinweis: Steuerschuldnerschaft des Leistungsempfängers gilt nicht','Steuerschuldnerschaft des Leistungsempfängers'),'bau-isar',18400)),['ABN-13B-HINWEIS']);
 for(const ok of ['Steuerschuldnerschaft des Leistungsempfängers','Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG)',' Steuerschuldnerschaft  des\n Leistungsempfängers '])
  assert.deepEqual(codes(checkXml(wording(b,ok,ok),'bau-isar',18400)),[],ok);
});

test('KoSIT accepts the negated § 14a Abs. 5 note, the acceptance test refuses it',{skip:kositSkip},async()=>{
 const {acceptance,recipient}=loadProfile('bau-isar');
 const xml=wording(await buildXml(fields('b-abschlag-13b-bau-isar')),NEGATED,NEGATED);
 const kosit=await validate(xml,{scenario:acceptance.scenario});
 assert.equal(kosit.accepted,true,JSON.stringify(kosit.messages));
 assert.deepEqual(codes(runChecks({xml,kosit,acceptance,recipient,expectedTotal:18400})),['ABN-13B-HINWEIS']);
});

test('BT-1 is read like a parser reads it: comments ignored, entities decoded',async()=>{
 const b=await buildXml(fields('b-abschlag-13b-bau-isar'));
 assert.equal(invoiceFacts(swap(b,'<cbc:ID>AR-2026-0087</cbc:ID>','<!--<cbc:ID>AR-2026-0087-B</cbc:ID>--><cbc:ID>AR-2026-0087</cbc:ID>')).invoiceNumber,'AR-2026-0087');
 assert.equal(invoiceFacts(swap(b,'<cbc:ID>AR-2026-0087</cbc:ID>','<cbc:ID>AR&amp;0087</cbc:ID>')).invoiceNumber,'AR&0087');
});
