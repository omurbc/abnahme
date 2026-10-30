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
