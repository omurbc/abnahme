import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseFixed} from '../einvoice/parse-fixed.mjs';
import {buildXml} from '../einvoice/build.mjs';
import {runChecks,invoiceFacts} from './checks.mjs';
import {loadProfile} from './profile.mjs';

const fields=name=>parseFixed(readFileSync(new URL(`../fixtures/${name}.fixed.txt`,import.meta.url),'utf8'));
const ok={accepted:true,httpStatus:200,scenario:'EN16931 XRechnung (UBL Invoice)',messages:[]};
const check=async(fixtureName,recipientId,{change={},kosit=ok,expectedTotal}={})=>{
 const f={...fields(fixtureName),...change};
 const {acceptance,recipient}=loadProfile(recipientId);
 return runChecks({xml:await buildXml(f),kosit,acceptance,recipient,expectedTotal:expectedTotal===undefined?f.grossTotal:expectedTotal});
};
const codes=r=>r.failures.map(f=>f.code);

test('facts are read from the delivered XML',async()=>{
 const facts=invoiceFacts(await buildXml(fields('b-abschlag-13b-bau-isar')));
 assert.deepEqual(facts,{payableAmount:'18400.00',sellerVatIds:['DE312456789'],buyerVatIds:['DE287654321'],ibans:['DE20701500000012345678'],lineCategories:['AE','AE'],breakdownCategories:['AE'],buyerReference:'BV-2026-014'});
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
 assert.deepEqual(codes(s),['ABN-13B']);
 assert.deepEqual(codes(await check('b-abschlag-13b-bau-isar','bau-isar',{change:{buyerVatId:'DE111111111'}})),['ABN-BT48']);
 assert.deepEqual(codes(await check('c-abschlag-13b-ohne-ustid','bau-isar')),['ABN-BT48']);
});

test('a non-§ 13b recipient must not receive category AE',async()=>{
 const ae={reverseCharge:true,lines:fields('a-reparatur-hv-giesing').lines.map(l=>({...l,vatCategory:'AE',vatRate:0}))};
 assert.deepEqual(codes(await check('a-reparatur-hv-giesing','hv-giesing',{change:ae,expectedTotal:443})),['ABN-13B']);
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

test('a KoSIT rejection without messages still fails',async()=>{
 const r=await check('a-reparatur-hv-giesing','hv-giesing',{kosit:{accepted:false,httpStatus:406,scenario:null,messages:[]}});
 assert.deepEqual(codes(r),['KOSIT-REJECT']);
});
