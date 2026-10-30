// The template MIP-003 server (agent-api.mjs) starts itself on import, so it runs as a child process in a scratch
// directory (its job store and registry are relative to the working directory) against a fake MPS.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const payments=[];
const mps=createServer(async(req,res)=>{
 let text='';for await(const chunk of req)text+=chunk;
 const now=Date.now(),send=data=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'success',data}));};
 if(req.url==='/api/v1/payment'){payments.push(text);return send({blockchainIdentifier:`bc-${payments.length}`,payByTime:String(now+600000),submitResultTime:String(now+1200000),unlockTime:String(now+2160000),externalDisputeUnlockTime:String(now+3120000)});}
 send({onChainState:null});
});
const mpsPort=await listen(mps);
const free=createServer();const port=await listen(free);free.close();
const dir=mkdtempSync(join(tmpdir(),'agent-api-'));
mkdirSync(join(dir,'docs'));
writeFileSync(join(dir,'docs/registration-state.json'),JSON.stringify({registrationState:'RegistrationConfirmed',supportedPaymentSourceIndex:0,agentIdentifier:'agent-x'}));
const child=spawn(process.execPath,[fileURLToPath(new URL('./agent-api.mjs',import.meta.url))],{cwd:dir,stdio:['ignore','pipe','pipe'],
 env:{PATH:process.env.PATH,HOME:process.env.HOME,MPS_URL:`http://127.0.0.1:${mpsPort}`,MPS_RUNTIME_TOKEN:'test-only',BUERO_API_PORT:String(port)}});
await new Promise((resolve,reject)=>{child.stdout.on('data',d=>String(d).includes('Agent API running')&&resolve());child.on('exit',code=>reject(new Error(`agent-api exited ${code}`)));});
after(()=>{child.kill();mps.closeAllConnections();mps.close();});

const post=async body=>{const r=await fetch(`http://127.0.0.1:${port}/start_job`,{method:'POST',headers:{'content-type':'application/json'},body});return {status:r.status,body:await r.json().catch(()=>null),headers:r.headers};};
const job=(nonce=randomBytes(10).toString('hex'))=>post(JSON.stringify({identifier_from_purchaser:nonce,input_data:{prompt:'Team brief'}}));

test('PENTEST-6: a malformed JSON body is a 400, not a retryable 500',async()=>{
 assert.equal((await post('{"identifier_from')).status,400);
 assert.equal((await post('null')).status,400);
});

test('PENTEST-4: unauthenticated /start_job is limited to 10 new payment requests per 10 minutes',async()=>{
 const nonce=randomBytes(10).toString('hex');
 assert.equal((await job(nonce)).status,200);
 for(let i=1;i<10;i++)assert.equal((await job()).status,200);
 const limited=await job();
 assert.equal(limited.status,429);
 assert.match(limited.headers.get('retry-after'),/^\d+$/);
 assert.equal(payments.length,10,'the refused request wrote nothing to MPS');
 assert.equal((await job(nonce)).status,200,'a replay of a known nonce still answers');
});

test('the template binds loopback only',()=>{
 assert.match(readFileSync(new URL('./agent-api.mjs',import.meta.url),'utf8'),/\.listen\(port,'127\.0\.0\.1'/);
});
