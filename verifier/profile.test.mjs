import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canonicalJson,parseJson,loadProfile,profileHash,recipientIds,loadAcceptance} from './profile.mjs';
import {XRECHNUNG_UBL_SCENARIO} from './kosit.mjs';

test('canonical JSON sorts keys recursively and has no whitespace',()=>{
 assert.equal(canonicalJson({b:1,a:[true,null,'x'],c:{z:1.5,y:'ü',u:undefined}}),'{"a":[true,null,"x"],"b":1,"c":{"y":"ü","z":1.5}}');
 assert.equal(canonicalJson({'€':1,'\r':2,'1':3}),'{"\\r":2,"1":3,"€":1}');
 assert.equal(canonicalJson([1e21,1e-7,-0,0.1]),'[1e+21,1e-7,0,0.1]');
 assert.throws(()=>canonicalJson({x:NaN}),/non-finite/);
});

test('JCS refuses what RFC 8785 refuses: lone surrogates and duplicate property names',()=>{
 assert.throws(()=>canonicalJson('\ud800'),/lone surrogate/);
 assert.throws(()=>canonicalJson({['a\udc00']:1}),/lone surrogate/);
 assert.equal(canonicalJson('\ud83d\ude00'),'"\ud83d\ude00"');
 assert.throws(()=>parseJson('{"vatId":"DE1","vatId":"DE2"}'),/duplicate key "vatId"/);
 assert.throws(()=>parseJson('{"x":{"a":1,"b":{"a":2},"\\u0061":3}}'),/duplicate key "a"/);
 assert.deepEqual(parseJson('{"a":{"a":1},"b":[{"a":1},{"a":2}],"s":"\\"a\\":"}'),{a:{a:1},b:[{a:1},{a:2}],s:'"a":'});
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
 assert.equal(loadProfile('bau-isar').profileHash,'e9a2831b3eb0944265c5d55c0fd1dc81481505b883d7710e96efacfe73759bf0');
 assert.equal(loadProfile('hv-giesing').profileHash,'e7f7ba8e0d831dcfc4072fea4ffef0515404e64609c4faec79c3ad95386133ec');
});

test('acceptance profile pins the KoSIT scenario the client enforces',()=>{
 assert.equal(loadAcceptance().scenario,XRECHNUNG_UBL_SCENARIO);
 assert.throws(()=>loadProfile('../acceptance-v1'),/Unknown Empfängerprofil/);
});
