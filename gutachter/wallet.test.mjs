// wallet.mjs on a copy in a temporary repo tree (its paths are relative to the script), so the real .env is never read
// or written: new wallets go to .local/secrets.env (mode 600), never to .env, and existing ones are reused from either file.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,copyFileSync,symlinkSync,writeFileSync,readFileSync,statSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';

const here=fileURLToPath(new URL('.',import.meta.url));
const NAMES=['GUTACHTER_BUYER_MNEMONIC','GUTACHTER_BUYER_ADDRESS','GUTACHTER_SELLER_MNEMONIC','GUTACHTER_SELLER_ADDRESS'];
function repo(dotEnv){
 const root=mkdtempSync(join(tmpdir(),'gutachter-wallet-'));mkdirSync(join(root,'gutachter'));
 copyFileSync(join(here,'wallet.mjs'),join(root,'gutachter/wallet.mjs'));symlinkSync(join(here,'node_modules'),join(root,'gutachter/node_modules'));
 if(dotEnv!==undefined)writeFileSync(join(root,'.env'),dotEnv,{mode:0o600});
 return root;
}
const run=root=>spawnSync(process.execPath,[join(root,'gutachter/wallet.mjs')],{cwd:join(root,'gutachter'),encoding:'utf8',timeout:60000});
const mode=path=>statSync(path).mode&0o777;

test('new wallets go to .local/secrets.env (600), .env stays untouched, the output shows addresses only, a rerun writes nothing',()=>{
 const root=repo('MPS_URL="http://127.0.0.1:38127"\n'),dotEnv=readFileSync(join(root,'.env'),'utf8');
 const first=run(root);
 assert.equal(first.status,0,first.stderr);
 assert.equal(readFileSync(join(root,'.env'),'utf8'),dotEnv,'.env is not written');
 const secrets=join(root,'.local/secrets.env'),wallets=parseEnv(readFileSync(secrets,'utf8'));
 assert.deepEqual(NAMES.filter(name=>wallets[name]),NAMES);
 assert.equal(mode(secrets),0o600);assert.equal(mode(join(root,'.local')),0o700);
 assert.match(first.stdout,new RegExp(wallets.GUTACHTER_BUYER_ADDRESS));
 for(const name of ['GUTACHTER_BUYER_MNEMONIC','GUTACHTER_SELLER_MNEMONIC'])assert.equal(first.stdout.includes(wallets[name]),false,`${name} is not printed`);
 const before=readFileSync(secrets,'utf8'),again=run(root);
 assert.equal(again.status,0,again.stderr);assert.equal(readFileSync(secrets,'utf8'),before);assert.match(again.stdout,/nothing written/);
});

test('the live layout (addresses in .env, mnemonics in .local/secrets.env) is reused: nothing is generated or written',()=>{
 const made=repo('');assert.equal(run(made).status,0);
 const w=parseEnv(readFileSync(join(made,'.local/secrets.env'),'utf8'));
 const root=repo(`GUTACHTER_BUYER_ADDRESS="${w.GUTACHTER_BUYER_ADDRESS}"\nGUTACHTER_SELLER_ADDRESS="${w.GUTACHTER_SELLER_ADDRESS}"\n`);
 mkdirSync(join(root,'.local'),{mode:0o700});
 const secrets=join(root,'.local/secrets.env'),text=`GUTACHTER_BUYER_MNEMONIC="${w.GUTACHTER_BUYER_MNEMONIC}"\nGUTACHTER_SELLER_MNEMONIC="${w.GUTACHTER_SELLER_MNEMONIC}"\n`;
 writeFileSync(secrets,text,{mode:0o600});
 const dotEnv=readFileSync(join(root,'.env'),'utf8'),r=run(root);
 assert.equal(r.status,0,r.stderr);
 assert.equal(readFileSync(secrets,'utf8'),text);assert.equal(readFileSync(join(root,'.env'),'utf8'),dotEnv);
 assert.match(r.stdout,new RegExp(w.GUTACHTER_SELLER_ADDRESS));
});

test('an existing .local/secrets.env keeps its lines and is set back to 600; without a .env the script still works',()=>{
 const root=repo(undefined);mkdirSync(join(root,'.local'),{mode:0o700});
 const secrets=join(root,'.local/secrets.env');writeFileSync(secrets,'ANTHROPIC_API_KEY="sentinel"\n',{mode:0o644});
 const r=run(root);
 assert.equal(r.status,0,r.stderr);
 assert.equal(existsSync(join(root,'.env')),false);
 const wallets=parseEnv(readFileSync(secrets,'utf8'));
 assert.equal(wallets.ANTHROPIC_API_KEY,'sentinel');assert.deepEqual(NAMES.filter(name=>wallets[name]),NAMES);
 assert.equal(mode(secrets),0o600);
});
