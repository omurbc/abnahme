// env-split.mjs against a fake repo with sentinel secrets, and env-guard.mjs as a preload on a tiny entry script.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,statSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseEnv} from 'node:util';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {PROFILES,SECRETS,splitEnv} from './env-split.mjs';

const guard=fileURLToPath(new URL('./env-guard.mjs',import.meta.url));
const sentinel=name=>`sentinel-${name.toLowerCase()}`;
const CONFIG={MPS_URL:'http://127.0.0.1:38127',AGENT_API_PORT:'21950',GUTACHTER_SELLER_ADDRESS:'addr_test1qzseller',ZAI_CONTEXT_WINDOW_TOKENS:'200000',PAID_TASKS_ENABLED:'true'};
const write=(path,vars)=>writeFileSync(path,Object.entries(vars).map(([k,v])=>`${k}="${v}"`).join('\n')+'\n');

function fakeRepo(){
 const root=mkdtempSync(join(tmpdir(),'env-split-'));
 mkdirSync(join(root,'.local'));
 write(join(root,'.env'),{...CONFIG,ANTHROPIC_API_KEY:sentinel('ANTHROPIC_API_KEY'),BLOCKFROST_API_KEY_PREPROD:sentinel('BLOCKFROST_API_KEY_PREPROD'),ZAI_API_KEY:sentinel('ZAI_API_KEY'),
  GUTACHTER_BUYER_MNEMONIC:'abandon ability able about above absent',GUTACHTER_SELLER_MNEMONIC:sentinel('GUTACHTER_SELLER_MNEMONIC'),NEW_SERVICE_TOKEN:'sentinel-undeclared'});
 write(join(root,'.local/mps.env'),{ADMIN_KEY:sentinel('ADMIN_KEY')});
 write(join(root,'.local/buero-buyer-runtime.env'),{MPS_BUYER_TOKEN:sentinel('MPS_BUYER_TOKEN')});
 write(join(root,'.local/buero-read-runtime.env'),{MPS_READ_TOKEN:sentinel('MPS_READ_TOKEN')});
 write(join(root,'.local/rechnungsmeister-runtime.env'),{MPS_RUNTIME_TOKEN:'sentinel-rm-runtime'});
 write(join(root,'.local/mps-runtime.env'),{MPS_RUNTIME_TOKEN:'sentinel-buero-selling'});
 write(join(root,'.local/mps-secrets.env'),{ENCRYPTION_KEY:sentinel('ENCRYPTION_KEY'),PURCHASE_WALLET_PREPROD_MNEMONIC:sentinel('PURCHASE_WALLET_PREPROD_MNEMONIC')});
 return root;
}

test('each profile file holds every setting of .env but only its own secrets, mode 0600 in a 0700 dir',()=>{
 const root=fakeRepo();
 mkdirSync(join(root,'.local/env'),{recursive:true});
 writeFileSync(join(root,'.local/env/buero.env'),'stale\n'); chmodSync(join(root,'.local/env/buero.env'),0o644);
 const result=splitEnv(root);
 assert.deepEqual(result.dropped,['NEW_SERVICE_TOKEN']);
 assert.equal(statSync(join(root,'.local/env')).mode&0o777,0o700);
 for(const [name,{secrets}] of Object.entries(PROFILES)){
  const path=join(root,'.local/env',`${name}.env`);
  assert.equal(statSync(path).mode&0o777,0o600,name);
  const text=readFileSync(path,'utf8'),vars=parseEnv(text);
  assert.equal(vars.ABNAHME_ENV_PROFILE,name);
  for(const [k,v] of Object.entries(CONFIG)) assert.equal(vars[k],v,`${name} ${k}`);
  assert.deepEqual(Object.keys(vars).filter(k=>SECRETS.includes(k)).sort(),[...secrets].sort(),name);
  assert.doesNotMatch(text,/sentinel-undeclared|sentinel-encryption|sentinel-gutachter_seller/,name);
 }
 const profile=name=>parseEnv(readFileSync(join(root,'.local/env',`${name}.env`),'utf8'));
 assert.equal(profile('buero').GUTACHTER_BUYER_MNEMONIC,'abandon ability able about above absent');
 assert.equal(profile('buero').MPS_READ_TOKEN,sentinel('MPS_READ_TOKEN'));
 // Two files hold an MPS_RUNTIME_TOKEN: each profile gets the one of its own wallet.
 assert.equal(profile('rechnungsmeister').MPS_RUNTIME_TOKEN,'sentinel-rm-runtime');
 assert.equal(profile('buero-api').MPS_RUNTIME_TOKEN,'sentinel-buero-selling');
});

test('a missing key file is reported by name, the other profiles are still written',()=>{
 const root=fakeRepo();
 writeFileSync(join(root,'.local/buero-read-runtime.env'),'');
 const result=splitEnv(root);
 assert.deepEqual(result.missing.buero,['MPS_READ_TOKEN']);
 assert.equal(parseEnv(readFileSync(join(root,'.local/env/gutachter-seller.env'),'utf8')).ABNAHME_ENV_PROFILE,'gutachter-seller');
});

const run=(env,args=[])=>spawnSync(process.execPath,[...args,'--import',guard,'-e','console.log("started")'],{env:{PATH:process.env.PATH,...env},encoding:'utf8'});

test('env-guard refuses a process started without a generated profile',()=>{
 const r=run({ANTHROPIC_API_KEY:sentinel('ANTHROPIC_API_KEY')});
 assert.notEqual(r.status,0); assert.doesNotMatch(r.stdout,/started/); assert.match(r.stderr,/env-split/);
});

test('env-guard: every profile starts with its own secrets and refuses every other project secret, naming it without its value',()=>{
 for(const [name,{secrets}] of Object.entries(PROFILES)){
  const own=Object.fromEntries(secrets.map(s=>[s,sentinel(s)]));
  const ok=run({ABNAHME_ENV_PROFILE:name,...own});
  assert.equal(ok.status,0,ok.stderr); assert.match(ok.stdout,/started/);
  const others=SECRETS.filter(s=>!secrets.includes(s));
  const bad=run({ABNAHME_ENV_PROFILE:name,...own,...Object.fromEntries(others.map(s=>[s,sentinel(s)]))});
  assert.notEqual(bad.status,0,name); assert.doesNotMatch(bad.stdout,/started/);
  for(const s of others) assert.match(bad.stderr,new RegExp(`\\b${s}\\b`),`${name} ${s}`);
  assert.doesNotMatch(bad.stderr,/sentinel-/);
 }
});

test('every generated file passes the guard when it is the only env file, and fails when .env is loaded too',()=>{
 const root=fakeRepo();
 splitEnv(root);
 for(const name of Object.keys(PROFILES)){
  const ok=run({},[`--env-file=${join(root,'.local/env',`${name}.env`)}`]);
  assert.equal(ok.status,0,`${name}: ${ok.stderr}`);
  const both=run({},[`--env-file=${join(root,'.env')}`,`--env-file=${join(root,'.local/env',`${name}.env`)}`]);
  assert.notEqual(both.status,0,name);
 }
});

test('the CLI writes the repo the script lives in, from any cwd, and prints names only',()=>{
 const root=fakeRepo();
 mkdirSync(join(root,'scripts'));
 writeFileSync(join(root,'scripts/env-split.mjs'),readFileSync(fileURLToPath(new URL('./env-split.mjs',import.meta.url))));
 const r=spawnSync(process.execPath,[join(root,'scripts/env-split.mjs')],{cwd:tmpdir(),encoding:'utf8',env:{PATH:process.env.PATH}});
 assert.equal(r.status,0,r.stderr);
 assert.match(r.stdout,/\.local\/env\/buero\.env: MPS_BUYER_TOKEN, MPS_READ_TOKEN/);
 assert.doesNotMatch(r.stdout,/sentinel-|abandon/);
 assert.equal(parseEnv(readFileSync(join(root,'.local/env/gutachter-seller.env'),'utf8')).ABNAHME_ENV_PROFILE,'gutachter-seller');
});
