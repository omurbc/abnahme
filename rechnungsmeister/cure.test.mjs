import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {provenance,planCure} from './cure.mjs';
import {loadRecipient} from '../verifier/profile.mjs';
import {parseFixed} from '../einvoice/parse-fixed.mjs';

const recipient=loadRecipient('bau-isar');
const text=readFileSync(new URL('../fixtures/b-abschlag-13b-bau-isar.txt',import.meta.url),'utf8');
const inputData={invoiceText:text,recipientProfileId:'bau-isar',expectedTotal:'18400.00',acceptanceProfileHash:'0'.repeat(64)};
const fields0=parseFixed(readFileSync(new URL('../fixtures/b-abschlag-13b-bau-isar.fixed.txt',import.meta.url),'utf8'));
const seeded={...fields0,buyerVatId:null};

test('provenance guard: verbatim in input_data or equal to a recipient profile value, nothing else',()=>{
 assert.equal(provenance('DE287654321',{inputData,recipient}),'input_data.invoiceText');
 assert.equal(provenance('DE287654321',{inputData:{invoiceText:'ohne'},recipient}),'recipient.vatId');
 assert.equal(provenance('DE999999999',{inputData,recipient}),null);
 assert.equal(provenance('DE',{inputData,recipient}),null,'too short to prove anything');
 assert.equal(provenance('BV-2026',{inputData:{invoiceText:'x'},recipient}),null,'substring of a profile hint is not a profile value');
});

test('seeded BT-48 defect is cured from the invoice text',()=>{
 const plan=planCure({failures:[{code:'BR-AE-02'},{code:'ABN-BT48'}],current:seeded,fields0,inputData,recipient});
 assert.deepEqual(plan,{ok:true,patch:{buyerVatId:'DE287654321'},sources:{buyerVatId:'input_data.invoiceText'},retransmit:false});
});

test('BT-48 missing from the invoice falls back to the pinned recipient profile',()=>{
 const plan=planCure({failures:[{code:'ABN-BT48'}],current:seeded,fields0:seeded,inputData:{...inputData,invoiceText:text.replace('Ihre USt-IdNr.: DE287654321','')},recipient});
 assert.equal(plan.ok,true);
 assert.deepEqual(plan.sources,{buyerVatId:'recipient.vatId'});
});

test('cure is rejected when no verbatim source exists or the defect is not curable',()=>{
 const stranger={...recipient,vatId:undefined};
 const noSource=planCure({failures:[{code:'ABN-BT48'}],current:seeded,fields0:seeded,inputData:{...inputData,invoiceText:'Rechnung ohne IDs'},recipient:stranger});
 assert.equal(noSource.ok,false);
 assert.equal(planCure({failures:[{code:'ABN-BETRAG'}],current:fields0,fields0,inputData,recipient}).ok,false);
 assert.equal(planCure({failures:[],current:fields0,fields0,inputData,recipient}).ok,false);
});

test('BT-10 is cured only with a reference that is in the text and matches the recipient pattern',()=>{
 const noRef={...fields0,buyerReference:null};
 assert.deepEqual(planCure({failures:[{code:'BR-DE-15'}],current:noRef,fields0:noRef,inputData,recipient}).patch,{buyerReference:'BV-2026-014'});
 const withoutRef={...inputData,invoiceText:text.replace('Ihr Zeichen: BV-2026-014','')};
 assert.equal(planCure({failures:[{code:'ABN-BT10'}],current:noRef,fields0:noRef,inputData:withoutRef,recipient}).ok,false,'the profile hint example must not be used');
});

test('hash mismatch is cured by retransmission only',()=>{
 assert.deepEqual(planCure({failures:[{code:'ABN-HASH'}],current:fields0,fields0,inputData,recipient}),{ok:true,patch:{},sources:{},retransmit:true});
});
