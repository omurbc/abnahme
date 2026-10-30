// env-split.mjs against a fake repo with sentinel secrets, and env-guard.mjs as a preload on a tiny entry script.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,statSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseEnv} from 'node:util';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {PROFILES,SECRETS,splitEnv,checkEnv,requireProfile} from './env-split.mjs';

// The guard resolves the repo from its own location (for the eve profile it reads the repo-root .env files), so guard
// runs use a copy of scripts/ inside a fake repo, never the operator's .env.
const fakeScripts=root=>{mkdirSync(join(root,'scripts'),{recursive:true});for(const f of ['env-guard.mjs','env-split.mjs'])writeFileSync(join(root,'scripts',f),readFileSync(fileURLToPath(new URL(`./${f}`,import.meta.url))));return join(root,'scripts/env-guard.mjs');};
const guard=fakeScripts(mkdtempSync(join(tmpdir(),'env-guard-')));
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

test('DELTA-SELLER-3: env-split creates the Büro key for the RechnungsMeister once (0600) and gives it to buero and rechnungsmeister only',()=>{
 const root=fakeRepo();
 splitEnv(root);
 const keyFile=join(root,'.local/rm-buyer-key.env');
 assert.equal(statSync(keyFile).mode&0o777,0o600);
 const key=parseEnv(readFileSync(keyFile,'utf8')).RM_BUYER_KEY;
 assert.match(key,/^[0-9a-f]{64}$/);
 splitEnv(root);
 assert.equal(parseEnv(readFileSync(keyFile,'utf8')).RM_BUYER_KEY,key,'a rerun keeps the key');
 for(const name of Object.keys(PROFILES)){
  const vars=parseEnv(readFileSync(join(root,'.local/env',`${name}.env`),'utf8'));
  assert.equal(vars.RM_BUYER_KEY,['buero','rechnungsmeister'].includes(name)?key:undefined,name);
 }
});

test('DELTA-SECRETS-6: env-split copies only known settings; the guard refuses every name or value that looks secret outside the profile',()=>{
 const root=fakeRepo();
 const odd={GUTACHTER_SELLER_SEED:'sentinel-seed',DATABASE_URL:'postgres://u:sentinel-pw@db/x',BLOCKFROST_PROJECT_ID:'sentinel-bf',MPS_APIKEY:'sentinel-apikey',
  X402_PRIVKEY:'sentinel-priv',WALLET_SEED_PHRASE:'sentinel-phrase',SOKOSUMI_CREDENTIALS:'sentinel-cred',SOME_NEW_SETTING:'sentinel-unknown'};
 writeFileSync(join(root,'.env'),readFileSync(join(root,'.env'),'utf8')+Object.entries(odd).map(([k,v])=>`${k}="${v}"`).join('\n')+'\n');
 const {dropped}=splitEnv(root);
 for(const name of Object.keys(odd))assert.ok(dropped.includes(name),`${name} is reported`);
 for(const name of Object.keys(PROFILES)){
  const text=readFileSync(join(root,'.local/env',`${name}.env`),'utf8');
  assert.doesNotMatch(text,/sentinel-(seed|pw|bf|apikey|priv|phrase|cred|unknown)/,name);
  for(const [k,v] of Object.entries(CONFIG))assert.equal(parseEnv(text)[k],v,`${name} ${k}: known settings still go everywhere`);
 }
 const stray={OPENAI_API_KEY:'sentinel-a',GITHUB_TOKEN:'sentinel-b',AWS_SECRET_ACCESS_KEY:'sentinel-c',SOKOSUMI_API_KEY:'sentinel-d',X402_PRIVKEY:'sentinel-e',
  WALLET_SEED_PHRASE:'sentinel-f',BLOCKFROST_PROJECT_ID:'sentinel-g',DATABASE_URL:'postgres://u:sentinel-h@db/x',SMTP_PASS:'sentinel-i'};
 for(const [k,v] of Object.entries(stray)){
  const r=run({ABNAHME_ENV_PROFILE:'gutachter-seller',[k]:v});
  assert.notEqual(r.status,0,k);assert.match(r.stderr,new RegExp(`\\b${k}\\b`));assert.doesNotMatch(r.stderr,/sentinel-/);
 }
 assert.deepEqual(checkEnv({ABNAHME_ENV_PROFILE:'board',MPS_URL:'http://127.0.0.1:38127',ZAI_CONTEXT_WINDOW_TOKENS:'200000',SSH_AUTH_SOCK:'/tmp/x',PWD:'/x'},'board'),[],'ordinary settings pass');
});


test('DELTA-SECRETS-2: npm start (profile eve) refuses while the repo-root .env files hold secrets Eve does not need, since its dev server loads them itself',()=>{
 const root=fakeRepo(),fakeGuard=fakeScripts(root);
 const start=()=>spawnSync(process.execPath,['--import',fakeGuard,'-e','console.log("started")'],{cwd:root,env:{PATH:process.env.PATH,ABNAHME_ENV_PROFILE:'eve',ZAI_API_KEY:'sentinel-zai'},encoding:'utf8'});
 const r=start();
 assert.notEqual(r.status,0);assert.doesNotMatch(r.stdout,/started/);
 assert.match(r.stderr,/ANTHROPIC_API_KEY/);assert.match(r.stderr,/\.env/);assert.doesNotMatch(r.stderr,/sentinel-/);
 for(const f of ['.env.local','.env.development','.env.development.local']){
  write(join(root,'.env'),{...CONFIG,ZAI_API_KEY:'sentinel-zai'});write(join(root,f),{GUTACHTER_BUYER_MNEMONIC:'sentinel-m'});
  assert.notEqual(start().status,0,f);
  writeFileSync(join(root,f),'');
 }
 const ok=start();
 assert.equal(ok.status,0,ok.stderr);assert.match(ok.stdout,/started/);
});

test('DELTA-SECRETS-2: env-split also reads secrets moved out of .env into .local/secrets.env',()=>{
 const root=fakeRepo();
 write(join(root,'.env'),CONFIG);
 write(join(root,'.local/secrets.env'),{ANTHROPIC_API_KEY:sentinel('ANTHROPIC_API_KEY'),BLOCKFROST_API_KEY_PREPROD:sentinel('BLOCKFROST_API_KEY_PREPROD'),GUTACHTER_BUYER_MNEMONIC:'abandon ability able about above absent'});
 splitEnv(root);
 const profile=name=>parseEnv(readFileSync(join(root,'.local/env',`${name}.env`),'utf8'));
 assert.equal(profile('rechnungsmeister').ANTHROPIC_API_KEY,sentinel('ANTHROPIC_API_KEY'));
 assert.equal(profile('buero').GUTACHTER_BUYER_MNEMONIC,'abandon ability able about above absent');
 assert.equal(profile('board').ANTHROPIC_API_KEY,undefined);
});

test('DELTA-SECRETS-5: rechnungsmeister/server.mjs and buero/run.mjs check their own profile, whatever the command line loaded',()=>{
 const repo=fileURLToPath(new URL('..',import.meta.url)),cwd=mkdtempSync(join(tmpdir(),'entry-'));
 for(const [entry,profile] of [['rechnungsmeister/server.mjs','rechnungsmeister'],['buero/run.mjs','buero']]){
  const own=Object.fromEntries(PROFILES[profile].secrets.map(s=>[s,sentinel(s)]));
  for(const env of [{ABNAHME_ENV_PROFILE:profile,...own,GUTACHTER_SELLER_MNEMONIC:sentinel('GUTACHTER_SELLER_MNEMONIC')},{...own},{ABNAHME_ENV_PROFILE:'mps-admin',...own}]){
   const r=spawnSync(process.execPath,[join(repo,entry)],{cwd,env:{PATH:process.env.PATH,AGENT_API_PORT:'1',...env},encoding:'utf8',timeout:10000});
   assert.equal(r.status,1,`${entry} ${JSON.stringify(Object.keys(env))}: ${r.stderr}`);
   assert.match(r.stderr,new RegExp(`env/${profile}\\.env`));assert.doesNotMatch(r.stderr+r.stdout,/sentinel-|running/);
  }
 }
 assert.throws(()=>requireProfile('board',{ABNAHME_ENV_PROFILE:'board',ADMIN_KEY:'x'}),/ADMIN_KEY/);
 assert.doesNotThrow(()=>requireProfile('board',{ABNAHME_ENV_PROFILE:'board',MPS_READ_TOKEN:'x'}));
});
