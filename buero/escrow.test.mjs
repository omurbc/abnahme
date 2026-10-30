// createEscrow against a recording fetch: the buyer process never sends ADMIN_KEY, the wallet-scoped buyer key
// does every write, and the read-only key is only used to read (the pre-FundsLocked 404 of the scoped key).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {createEscrow} from './escrow.mjs';
import {rmClient} from './abnahme.mjs';

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

// ESCROW-4 / LIVE-1: preprod tx 72e84fdd… (11:36:01Z, another operator on our V2 contract) carries three SubmitResult
// escrow outputs. Recorded from Blockfrost /txs/{hash}/utxos and /scripts/datum/{hash}.
const batched=JSON.parse(readFileSync(new URL('./fixtures/blockfrost-72e84fdd.json',import.meta.url),'utf8'));
const CONTRACT='addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g';
function recordedBlockfrost(){
 const calls=[];
 const fetchImpl=async url=>{
  const path=new URL(url).pathname.replace('/api/v0','');calls.push(path);
  if(path===`/txs/${batched.tx}/utxos`)return Response.json({outputs:batched.outputs});
  const datum=batched.datums[path.replace('/scripts/datum/','')];
  return datum?Response.json({json_value:datum}):Response.json({error:'Not Found'},{status:404});
 };
 return {calls,fetchImpl};
}

test('ESCROW-4: in a batched SubmitResult tx the result_hash is read from the escrow whose datum input_hash is this purchase\'s',async()=>{
 const {fetchImpl}=recordedBlockfrost();
 const escrow=createEscrow({blockfrostKey:'test',fetchImpl});
 const datum=i=>batched.datums[batched.outputs[i].data_hash].fields;
 for(const i of [0,1,2])
  assert.equal(await escrow.chainResultHash(batched.tx,CONTRACT,{inputHash:datum(i)[10].bytes}),datum(i)[11].bytes,`escrow output #${i}`);
 assert.equal(await escrow.chainResultHash(batched.tx,CONTRACT,{inputHash:datum(1)[10].bytes}),'e00fd326b197a9bab364200c6bd155ef96f242647d4d2238f3156b152c1d132d');
 // No own escrow in the tx is "unknown", never a mismatch: it throws and the engine does not dispute on it.
 await assert.rejects(escrow.chainResultHash(batched.tx,CONTRACT,{inputHash:'00'.repeat(32)}),/0 Escrow-Ausgaben/);
});

test('STATEMACHINE-12: MPS answers a repeated POST /purchase with 409; the client returns the existing purchase',async()=>{
 const calls=[];
 const fetchImpl=async(url,init)=>{
  const path=new URL(url).pathname.replace('/api/v1','');calls.push(path);
  if(path==='/purchase')return Response.json({status:'error',error:{message:'Purchase exists'}},{status:409});
  return Response.json({status:'success',data:{id:'p1',onChainState:null}});
 };
 const escrow=createEscrow({url:'http://mps.test',buyerToken:BUYER,readToken:READ,fetchImpl});
 assert.equal((await escrow.purchase(job,{inputHash:'h',nonce:'n',metadata:'{}'})).id,'p1');
 assert.deepEqual(calls,['/purchase','/purchase/resolve-blockchain-identifier']);
});

test('rmClient sends the job token as Bearer on /status and /dispute, never on /start_job',async()=>{
 const seen=[];
 const server=createServer((req,res)=>{seen.push([new URL(req.url,'http://x').pathname,req.headers.authorization??null,req.headers['content-type']]);req.resume();req.on('end',()=>{res.writeHead(200,{'content-type':'application/json'});res.end('{}');});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const rm=rmClient(`http://127.0.0.1:${server.address().port}`);
  await rm.startJob({});await rm.status('j1','tok');await rm.dispute({jobId:'j1'},'tok');
  assert.deepEqual(seen,[['/start_job',null,'application/json'],['/status','Bearer tok','application/json'],['/dispute','Bearer tok','application/json']]);
 }finally{server.close();}
});
