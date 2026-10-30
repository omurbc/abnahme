import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canonicalJson,loadProfile,profileHash,recipientIds,loadAcceptance} from './profile.mjs';
import {XRECHNUNG_UBL_SCENARIO} from './kosit.mjs';

test('canonical JSON sorts keys recursively and has no whitespace',()=>{
 assert.equal(canonicalJson({b:1,a:[true,null,'x'],c:{z:1.5,y:'ü',u:undefined}}),'{"a":[true,null,"x"],"b":1,"c":{"y":"ü","z":1.5}}');
 assert.equal(canonicalJson({'€':1,'\r':2,'1':3}),'{"\\r":2,"1":3,"€":1}');
 assert.equal(canonicalJson([1e21,1e-7,-0,0.1]),'[1e+21,1e-7,0,0.1]');
 assert.throws(()=>canonicalJson({x:NaN}),/non-finite/);
});

test('profile hash ignores key order and changes with content',()=>{
 const {acceptance,recipient}=loadProfile('bau-isar');
 const reordered=Object.fromEntries(Object.entries(recipient).reverse());
 assert.equal(profileHash(acceptance,reordered),profileHash(acceptance,recipient));
 assert.notEqual(profileHash(acceptance,{...recipient,vatId:'DE111111111'}),profileHash(acceptance,recipient));
});

// Changing a profile file changes the escrow input hash. Update these values only on purpose.
test('profile hashes are stable',()=>{
 assert.deepEqual(recipientIds(),['bau-isar','hv-giesing']);
 assert.equal(loadProfile('bau-isar').profileHash,'0d799b1362b6e476f1d1f1b52dacc7458abdca0f4e8b99bf91d0a11034eacd74');
 assert.equal(loadProfile('hv-giesing').profileHash,'ec6c8f6765e37e8fbc97416d6fc4e5198dcc15ab91167e1303560a88fe8984c0');
});

test('acceptance profile pins the KoSIT scenario the client enforces',()=>{
 assert.equal(loadAcceptance().scenario,XRECHNUNG_UBL_SCENARIO);
 assert.throws(()=>loadProfile('../acceptance-v1'),/Unknown Empfängerprofil/);
});
