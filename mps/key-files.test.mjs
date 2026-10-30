// The key-minting scripts against a fake MPS in a temp cwd: the token file ends up 0600 even when a 0644 file
// already existed, and read-key.mjs asks MPS for a read-only key without wallet scope.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,statSync,chmodSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const posts=[];
const mps=createServer((req,res)=>{
 let b=''; req.on('data',c=>b+=c); req.on('end',()=>{
  const body=JSON.parse(b||'{}'); posts.push({path:req.url,token:req.headers.token,body});
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({status:'success',data:{id:`key-${posts.length}`,token:'masumi-payment-testtoken',canRead:body.canRead,canPay:body.canPay,canAdmin:body.canAdmin,NetworkLimit:body.NetworkLimit,walletScopeEnabled:body.walletScopeEnabled,WalletScopeHotWalletIds:body.WalletScopeHotWalletIds}}));
 });
});
await new Promise(r=>mps.listen(0,'127.0.0.1',r));
after(()=>mps.close());

const script=name=>fileURLToPath(new URL(name,import.meta.url));
function cwdWith(files){
 const dir=mkdtempSync(join(tmpdir(),'mps-key-'));
 mkdirSync(join(dir,'docs')); mkdirSync(join(dir,'.local'));
 for(const [path,text] of Object.entries(files)){ writeFileSync(join(dir,path),text); chmodSync(join(dir,path),0o644); }
 return dir;
}
async function run(file,args,cwd){
 const child=spawn(process.execPath,[script(file),...args],{cwd,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,MPS_URL:`http://127.0.0.1:${mps.address().port}`,ADMIN_KEY:'test-admin-key'}});
 let out=''; child.stdout.on('data',c=>out+=c); child.stderr.on('data',c=>out+=c);
 const code=await new Promise(r=>child.once('exit',r));
 assert.equal(code,0,out); assert.doesNotMatch(out,/masumi-payment-testtoken/);
 return out;
}
const mode=path=>statSync(path).mode&0o777;

test('buyer-key.mjs tightens an existing 0644 token file to 0600',async()=>{
 const cwd=cwdWith({'docs/buero-purchasing-state.json':JSON.stringify({walletId:'w-purchasing'}),'.local/buero-buyer-runtime.env':'MPS_BUYER_TOKEN=old\n'});
 await run('buyer-key.mjs',[],cwd);
 assert.equal(mode(join(cwd,'.local/buero-buyer-runtime.env')),0o600);
 assert.equal(readFileSync(join(cwd,'.local/buero-buyer-runtime.env'),'utf8'),'MPS_BUYER_TOKEN=masumi-payment-testtoken\n');
});

test('rechnungsmeister-registration.mjs key tightens an existing 0644 token file to 0600',async()=>{
 const cwd=cwdWith({'docs/rechnungsmeister-payment-state.json':JSON.stringify({sourceId:'s',walletId:'w-rm'}),'.local/rechnungsmeister-runtime.env':'MPS_RUNTIME_TOKEN=old\n'});
 await run('rechnungsmeister-registration.mjs',['key'],cwd);
 assert.equal(mode(join(cwd,'.local/rechnungsmeister-runtime.env')),0o600);
});

test('read-key.mjs mints one read-only, unscoped Preprod key, writes it 0600, and does not mint again',async()=>{
 const cwd=cwdWith({'.local/buero-read-runtime.env':''});
 posts.length=0;
 await run('read-key.mjs',[],cwd);
 assert.equal(posts.length,1);
 const {path,token,body}=posts[0];
 assert.equal(path,'/api/v1/api-key'); assert.equal(token,'test-admin-key');
 assert.deepEqual({canRead:body.canRead,canPay:body.canPay,canAdmin:body.canAdmin,walletScopeEnabled:body.walletScopeEnabled,NetworkLimit:body.NetworkLimit},{canRead:true,canPay:false,canAdmin:false,walletScopeEnabled:false,NetworkLimit:['Preprod']});
 assert.equal(mode(join(cwd,'.local/buero-read-runtime.env')),0o600);
 assert.equal(readFileSync(join(cwd,'.local/buero-read-runtime.env'),'utf8'),'MPS_READ_TOKEN=masumi-payment-testtoken\n');
 assert.ok(existsSync(join(cwd,'docs/buero-read-key-state.json')));
 assert.match(await run('read-key.mjs',[],cwd),/already saved/);
 assert.equal(posts.length,1);
});
