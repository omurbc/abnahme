// createEscrow against a recording fetch: the buyer process never sends ADMIN_KEY, the wallet-scoped buyer key
// does every write, and the read-only key is only used to read (the pre-FundsLocked 404 of the scoped key).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createEscrow} from './escrow.mjs';

const ADMIN='sentinel-admin-key',BUYER='buyer-token',READ='read-token';
const WRITES=['/purchase','/purchase/request-refund','/purchase/cancel-refund-request'];

function recordingMps({lockedForBuyer=false}={}){
 const calls=[];
 const fetchImpl=async(url,init)=>{
  const path=new URL(url).pathname.replace('/api/v1',''),token=init.headers.token;
  calls.push({path,token,headers:JSON.stringify(init.headers)});
  // The scoped key sees a purchase only once MPS has bound its wallet to it at FundsLocked.
  if(path==='/purchase/resolve-blockchain-identifier'&&token===BUYER&&!lockedForBuyer) return Response.json({status:'error',error:{message:'Purchase not found'}},{status:404});
  return Response.json({status:'success',data:{id:'p1',onChainState:'FundsLocked'}});
 };
 return {calls,fetchImpl};
}
const job={blockchainIdentifier:'bcid-1',smartContractAddress:'addr_test1contract',supportedPaymentSourceIndex:0,sellerVKey:'vk',agentIdentifier:'agent',amounts:[],unlockTime:1,externalDisputeUnlockTime:2,submitResultTime:3,payByTime:4};

test('ADMIN_KEY in the environment is never sent; the read key reads before FundsLocked and never writes',async()=>{
 const saved=process.env.ADMIN_KEY; process.env.ADMIN_KEY=ADMIN;
 try{
  const {calls,fetchImpl}=recordingMps();
  const escrow=createEscrow({url:'http://mps.test',buyerToken:BUYER,readToken:READ,fetchImpl});
  await escrow.purchase(job,{inputHash:'h',nonce:'n',metadata:'{}'});
  assert.equal((await escrow.getPurchase('bcid-1')).id,'p1');
  assert.equal((await escrow.getPayment('bcid-1')).id,'p1');
  await escrow.requestRefund('bcid-1');
  await escrow.cancelRefundRequest('bcid-1');
  assert.ok(calls.length>=6);
  for(const c of calls) assert.doesNotMatch(c.headers,new RegExp(ADMIN),`${c.path} sent ADMIN_KEY`);
  for(const c of calls.filter(c=>WRITES.includes(c.path))) assert.equal(c.token,BUYER,`${c.path} must use the buyer key`);
  assert.deepEqual(calls.filter(c=>c.token===READ).map(c=>c.path),['/purchase/resolve-blockchain-identifier','/payment/resolve-blockchain-identifier']);
 }finally{ if(saved===undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY=saved; }
});

test('after FundsLocked the scoped buyer key alone resolves the purchase',async()=>{
 const {calls,fetchImpl}=recordingMps({lockedForBuyer:true});
 const escrow=createEscrow({url:'http://mps.test',buyerToken:BUYER,readToken:READ,fetchImpl});
 assert.equal((await escrow.getPurchase('bcid-1')).id,'p1');
 assert.deepEqual(calls.map(c=>c.token),[BUYER]);
});

test('without a read key a purchase MPS does not show the buyer yet is an error, not "no purchase"',async()=>{
 const {fetchImpl}=recordingMps();
 const escrow=createEscrow({url:'http://mps.test',buyerToken:BUYER,readToken:'',fetchImpl});
 await assert.rejects(escrow.getPurchase('bcid-1'),/HTTP 404/);
});
