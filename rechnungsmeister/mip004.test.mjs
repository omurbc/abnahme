import {createHash} from 'node:crypto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inputHashFor,resultHash,buildResult,verifyDelivery} from './mip004.mjs';
import {sha256} from '../standard-hash.mjs';

const nonce='a1b2c3d4e5f60718293a';
const input={invoiceText:'Rechnung …',recipientProfileId:'bau-isar',expectedTotal:'18400.00',acceptanceProfileHash:'0d79'.padEnd(64,'0')};

test('input hash covers the whole input_data in JCS order, so the profile hash is pinned',()=>{
 const reordered={expectedTotal:input.expectedTotal,acceptanceProfileHash:input.acceptanceProfileHash,recipientProfileId:'bau-isar',invoiceText:input.invoiceText};
 assert.equal(inputHashFor(reordered,nonce),inputHashFor(input,nonce));
 assert.equal(inputHashFor(input,nonce),sha256(`${nonce};{"acceptanceProfileHash":"${input.acceptanceProfileHash}","expectedTotal":"18400.00","invoiceText":"Rechnung …","recipientProfileId":"bau-isar"}`));
 assert.notEqual(inputHashFor({...input,acceptanceProfileHash:'f'.repeat(64)},nonce),inputHashFor(input,nonce));
 assert.notEqual(inputHashFor(input,'ffffffffffffffffffff'),inputHashFor(input,nonce));
});

const xml='<Invoice>ä</Invoice>';
const kosit={accepted:true,scenario:'EN16931 XRechnung (UBL Invoice)'};
const profileHash='ab'.repeat(32);

test('buyer accepts an honest delivery and recomputes the on-chain hash',()=>{
 const {result,manifest}=buildResult({xml,kosit,profileHash,attempt:1});
 assert.deepEqual(Object.keys(manifest).sort(),['attempt','kositVerdict','profileHash','scenario','xmlSha256']);
 const v=verifyDelivery({result,nonce,onChainHash:resultHash(result,nonce),profileHash});
 assert.deepEqual(v.failures,[]);
 assert.equal(v.xml,xml);
});

test('buyer flags a hash that does not match the delivered bytes (CHEAT)',()=>{
 const {result}=buildResult({xml,kosit,profileHash,attempt:1});
 const v=verifyDelivery({result,nonce,onChainHash:sha256(`CHEAT;${resultHash(result,nonce)}`),profileHash});
 assert.deepEqual(v.failures.map(f=>f.code),['ABN-HASH']);
});

test('buyer flags swapped XML bytes and a foreign profile',()=>{
 const {result}=buildResult({xml,kosit,profileHash,attempt:1});
 const parsed=JSON.parse(result);parsed.xmlBase64=Buffer.from('<Invoice>x</Invoice>').toString('base64');
 const tampered=JSON.stringify(parsed);
 assert.deepEqual(verifyDelivery({result:tampered,nonce,onChainHash:resultHash(tampered,nonce),profileHash}).failures.map(f=>f.code),['ABN-MANIFEST']);
 assert.deepEqual(verifyDelivery({result,nonce,onChainHash:resultHash(result,nonce),profileHash:'cd'.repeat(32)}).failures.map(f=>f.code),['ABN-PROFIL']);
 assert.deepEqual(verifyDelivery({result:undefined,nonce,onChainHash:'x',profileHash}).failures.map(f=>f.code),['ABN-LIEFERUNG']);
});

test('ESCROW-7: the committed result must be canonical JCS, so one on-chain hash commits to one readable invoice',()=>{
 const good=buildResult({xml,kosit,profileHash,attempt:1});
 const bad=buildResult({xml:'<Invoice>ohne BT-48</Invoice>',kosit,profileHash,attempt:1});
 const m=r=>JSON.stringify(JSON.parse(r.result).manifest),x=r=>JSON.stringify(JSON.parse(r.result).xmlBase64);
 const variants={
  duplicateKeys:`{"manifest":${m(bad)},"manifest":${m(good)},"xmlBase64":${x(bad)},"xmlBase64":${x(good)}}`,
  whitespace:good.result.replace('{"manifest":','{ "manifest": '),
  reordered:`{"xmlBase64":${x(good)},"manifest":${m(good)}}`,
  looseBase64:good.result.replace(/"xmlBase64":"(.{8})/,(_,b)=>`"xmlBase64":"${b}\\n`),
 };
 for(const [name,result] of Object.entries(variants)){
  const v=verifyDelivery({result,nonce,onChainHash:resultHash(result,nonce),profileHash});
  assert.ok(v.failures.some(f=>f.code==='ABN-MANIFEST'),name);
  assert.equal(v.xml,null,`${name}: nothing is inspected from an ambiguous delivery`);
 }
});

// A delivery built from raw bytes: canonical JCS, manifest hash of exactly those bytes (DELTA-SELLER-4).
const fromBytes=bytes=>{
 const manifest={attempt:1,kositVerdict:'ACCEPTABLE',profileHash,scenario:kosit.scenario,xmlSha256:createHash('sha256').update(bytes).digest('hex')};
 return `{"manifest":{"attempt":1,"kositVerdict":"ACCEPTABLE","profileHash":"${profileHash}","scenario":"${kosit.scenario}","xmlSha256":"${manifest.xmlSha256}"},"xmlBase64":"${bytes.toString('base64')}"}`;
};

test('DELTA-SELLER-4: XML bytes that are not UTF-8 are a defect; the buyer never inspects a lossy reading of the committed bytes',()=>{
 const latin1=Buffer.concat([Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><Invoice>M'),Buffer.from([0xe4]),Buffer.from('ller</Invoice>')]);
 const result=fromBytes(latin1);
 const v=verifyDelivery({result,nonce,onChainHash:resultHash(result,nonce),profileHash});
 assert.deepEqual(v.failures.map(f=>f.code),['ABN-MANIFEST']);
 assert.equal(v.xml,null);
});

test('DELTA-SELLER-4: a valid UTF-8 body that declares another encoding is a defect (two readings of one hash)',()=>{
 for(const text of ['<?xml version="1.0" encoding="ISO-8859-1"?><Invoice>Müller</Invoice>','\uFEFF<?xml version="1.0" encoding="windows-1252"?><Invoice>Müller</Invoice>']){
  const result=fromBytes(Buffer.from(text,'utf8'));
  const v=verifyDelivery({result,nonce,onChainHash:resultHash(result,nonce),profileHash});
  assert.deepEqual(v.failures.map(f=>f.code),['ABN-MANIFEST'],text);
  assert.equal(v.xml,null);
 }
});

test('DELTA-SELLER-4: the XML the buyer inspects is exactly the committed bytes (a UTF-8 declaration and a BOM are kept)',()=>{
 for(const text of ['\uFEFF<?xml version="1.0" encoding="UTF-8"?><Invoice>Müller</Invoice>','<?xml version="1.0" encoding=\'utf-8\'?><Invoice>ä</Invoice>','<Invoice>ä</Invoice>']){
  const bytes=Buffer.from(text,'utf8'),result=fromBytes(bytes);
  const v=verifyDelivery({result,nonce,onChainHash:resultHash(result,nonce),profileHash});
  assert.deepEqual(v.failures,[],text);
  assert.ok(Buffer.from(v.xml,'utf8').equals(bytes),text);
 }
});
