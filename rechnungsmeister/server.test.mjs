import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deadlines,validateInput} from './server.mjs';
import {loadProfile} from '../verifier/profile.mjs';

const MIN=60000;

test('payment deadlines pass the MPS 0.29.0 POST /payment rules and leave room for dispute and cure',()=>{
 const now=Date.now();const d=Object.fromEntries(Object.entries(deadlines(now)).map(([k,v])=>[k,Date.parse(v)]));
 // src/routes/api/payments/index.ts @0.29.0
 assert.ok(d.payByTime<=d.submitResultTime-5*MIN,'payBy at least 5 min before submitResult');
 assert.ok(d.submitResultTime>=now+15*MIN,'submitResult at least 15 min ahead');
 assert.ok(d.submitResultTime<=d.unlockTime-15*MIN,'unlock at least 15 min after submitResult');
 assert.ok(d.externalDisputeUnlockTime>=d.unlockTime+15*MIN,'external dispute at least 15 min after unlock');
 // request-refund is only picked up while unlockTime > now+3min and its tx must end before unlockTime
 assert.ok(d.unlockTime-now>=40*MIN);
 // a cure (Disputed SubmitResult) is accepted until externalDisputeUnlockTime-5min
 assert.ok(d.externalDisputeUnlockTime-now>=60*MIN);
});

test('start_job input must carry the published profile hash',()=>{
 const {profileHash}=loadProfile('bau-isar');
 const ok={invoiceText:'Rechnung',recipientProfileId:'bau-isar',expectedTotal:'18400.00',acceptanceProfileHash:profileHash};
 assert.equal(validateInput(ok),null);
 assert.match(validateInput({...ok,acceptanceProfileHash:'0'.repeat(64)}),/does not match/);
 assert.match(validateInput({...ok,expectedTotal:18400}),/expectedTotal/);
 assert.match(validateInput({...ok,recipientProfileId:'nobody'}),/recipientProfileId/);
 assert.match(validateInput({...ok,prompt:'x'}),/exactly/);
});
