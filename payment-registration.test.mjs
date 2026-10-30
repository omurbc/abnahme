// payment-registration.mjs key against a fake MPS in a temp cwd: the token file ends up 0600 even when a 0644 file
// already existed (writeFileSync's mode applies only when it creates the file). Same check as mps/key-files.test.mjs.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,statSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const mps=createServer((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'success',data:{id:'key-1',token:'masumi-payment-testtoken',canRead:true,canPay:true,canAdmin:false}}));});});
await new Promise(r=>mps.listen(0,'127.0.0.1',r));
after(()=>mps.close());

test('payment-registration.mjs key tightens an existing 0644 token file to 0600',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'payment-registration-'));
 mkdirSync(join(cwd,'docs'));mkdirSync(join(cwd,'.local'));
 writeFileSync(join(cwd,'docs/payment-state.json'),JSON.stringify({sourceId:'s',walletId:'w'}));
 writeFileSync(join(cwd,'.local/mps-runtime.env'),'MPS_RUNTIME_TOKEN=old\n');chmodSync(join(cwd,'.local/mps-runtime.env'),0o644);
 const child=spawn(process.execPath,[fileURLToPath(new URL('./payment-registration.mjs',import.meta.url)),'key'],{cwd,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,MPS_URL:`http://127.0.0.1:${mps.address().port}`,ADMIN_KEY:'test-admin-key'}});
 let out='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>out+=c);
 assert.equal(await new Promise(r=>child.once('exit',r)),0,out);
 assert.doesNotMatch(out,/masumi-payment-testtoken/);
 assert.equal(statSync(join(cwd,'.local/mps-runtime.env')).mode&0o777,0o600);
 assert.equal(readFileSync(join(cwd,'.local/mps-runtime.env'),'utf8'),'MPS_RUNTIME_TOKEN=masumi-payment-testtoken\n');
});
