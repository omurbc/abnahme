// Per-process env files, so no process loads the whole .env (audit SECRETS-1). Each .local/env/<profile>.env holds
// every known setting of .env (CONFIG) plus only the secrets that process uses, taken from .env, .local/secrets.env and
// the profile's key files. A name in neither list goes nowhere and is reported (DELTA-SECRETS-6).
// Rerun after any change to .env or to a key file (npm run wallet in gutachter/ reruns it). It prints names only, never values:
//   node scripts/env-split.mjs
// Long-running processes start with their generated file alone, plus the guard:
//   node --env-file=.local/env/buero.env --import=./scripts/env-guard.mjs worker.mjs
import {readFileSync,writeFileSync,renameSync,mkdirSync,chmodSync,existsSync,realpathSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseEnv} from 'node:util';

// Every secret this project keeps in .env or .local/*.env. The guard refuses each one a profile does not list.
export const SECRETS=['ANTHROPIC_API_KEY','ZAI_API_KEY','BLOCKFROST_API_KEY_PREPROD','GUTACHTER_BUYER_MNEMONIC','GUTACHTER_SELLER_MNEMONIC',
 'ADMIN_KEY','ENCRYPTION_KEY','PURCHASE_WALLET_PREPROD_MNEMONIC','SELLING_WALLET_PREPROD_MNEMONIC','RM_SELLING_WALLET_PREPROD_MNEMONIC',
 'MPS_RUNTIME_TOKEN','MPS_BUYER_TOKEN','MPS_READ_TOKEN','RM_BUYER_KEY'];
// The settings (ports, URLs, ids, addresses, flags) every profile gets. Anything else in .env goes nowhere.
export const CONFIG=['ABNAHME_IMPL','AGENT_API_PORT','AGENT_AUTHOR','BOARD_PORT','BUERO_API_PORT','CHEAT','COWORKER_ID','DEMO_SEED_DEFECT','EVE_PORT','EVE_URL',
 'EXTRACT_MODE','FACILITATOR_URL','GUTACHTER_BUYER_ADDRESS','GUTACHTER_HOST','GUTACHTER_LEDGER','GUTACHTER_MAX_PAYMENTS_PER_DAY','GUTACHTER_PORT',
 'GUTACHTER_SELLER_ADDRESS','GUTACHTER_STUB','GUTACHTER_URL','INSPECT_MODE','KOSIT_PORT','KOSIT_URL','MAIL_SMTP_PORT','MAILPIT_URL','MPS_PORT','MPS_URL',
 'PAID_TASKS_ENABLED','RM_URL','SOKOSUMI_ORGANIZATION_ID','SOKOSUMI_ORGANIZATION_SLUG','ZAI_BASE_URL','ZAI_CONTEXT_WINDOW_TOKENS','ZAI_MODEL'];
// The guard refuses, outside the profile, every name in SECRETS and every name or value that looks like a credential.
const looksSecret=(name,value='')=>SECRETS.includes(name)||/(^|_)(KEY|TOKEN|MNEMONIC|SECRET|PASSWORD|PASS|PASSPHRASE|SEED|PRIVKEY|APIKEY|CREDENTIALS?)(_|$)/.test(name)
 ||/^BLOCKFROST_/.test(name)||/:\/\/[^/\s:@]+:[^/\s@]+@/.test(value);
// The Büro's key for the RechnungsMeister's window for new jobs (DELTA-SELLER-3), created on the first run.
const BUYER_KEY_FILE='.local/rm-buyer-key.env';

export const PROFILES={
 // gutachter/seller.mjs (npm run seller): payTo is an address, the seller holds no key.
 'gutachter-seller':{secrets:[]},
 // gutachter/buy.mjs and balance.mjs run by hand (npm run buy / balance).
 'gutachter-buyer':{secrets:['GUTACHTER_BUYER_MNEMONIC','BLOCKFROST_API_KEY_PREPROD']},
 // rechnungsmeister/server.mjs: Claude extraction and the key scoped to its own selling wallet.
 rechnungsmeister:{secrets:['ANTHROPIC_API_KEY','MPS_RUNTIME_TOKEN','RM_BUYER_KEY'],files:['.local/rechnungsmeister-runtime.env',BUYER_KEY_FILE]},
 // worker.mjs and buero/run.mjs: escrow writes (buyer key scoped to the purchasing wallet), reads before FundsLocked
 // (read-only key), datum and settlement checks (Blockfrost), x402 inspections (Gutachter buyer wallet), its key for
 // RechnungsMeister's /start_job. paid-task.mjs reads the Büro selling key from .local/mps-runtime.env itself.
 buero:{secrets:['MPS_BUYER_TOKEN','MPS_READ_TOKEN','BLOCKFROST_API_KEY_PREPROD','GUTACHTER_BUYER_MNEMONIC','RM_BUYER_KEY'],files:['.local/buero-buyer-runtime.env','.local/buero-read-runtime.env',BUYER_KEY_FILE]},
 // worker.mjs with ABNAHME_IMPL=local: extraction runs in the worker, no escrow and no x402.
 'buero-local':{secrets:['ANTHROPIC_API_KEY','BLOCKFROST_API_KEY_PREPROD']},
 // One-shot operator scripts: mps/*.mjs and payment-registration.mjs.
 'mps-admin':{secrets:['ADMIN_KEY','BLOCKFROST_API_KEY_PREPROD'],files:['.local/mps.env']},
 // Template MIP-003 API agent-api.mjs (npm run api): the key scoped to the Büro selling wallet.
 'buero-api':{secrets:['MPS_RUNTIME_TOKEN'],files:['.local/mps-runtime.env']},
 // Template Eve agent start.mjs (npm start): its OpenAI-compatible model key. Its dev server loads the repo-root .env
 // files itself, after the guard, so the guard checks those files too (DELTA-SECRETS-2).
 eve:{secrets:['ZAI_API_KEY'],loadsDotEnv:['.env.development.local','.env.local','.env.development','.env']},
 // einvoice/cli.mjs run by hand with EXTRACT_MODE=llm: Claude extraction only.
 einvoice:{secrets:['ANTHROPIC_API_KEY']},
 // board/server.mjs, the read-only demo board: Blockfrost for confirmations, the read-only MPS key for live tx history.
 board:{secrets:['BLOCKFROST_API_KEY_PREPROD','MPS_READ_TOKEN'],files:['.local/buero-read-runtime.env']},
};

// The secrets in env that the profile does not use: project secrets and anything else that looks like one.
export function checkEnv(env,profile){
 const allowed=Object.hasOwn(PROFILES,profile)?PROFILES[profile].secrets:null;
 if(!allowed) throw new Error(`Unknown env profile ${profile}`);
 return Object.keys(env).filter(name=>env[name]&&looksSecret(name,env[name])&&!allowed.includes(name));
}

const read=path=>existsSync(path)?parseEnv(readFileSync(path,'utf8')):{};
const ROOT=fileURLToPath(new URL('..',import.meta.url));
// Secrets in the files the profile's process loads by itself from the repo root (Eve's dev server), named with the file.
export function checkDotEnv(profile,root=ROOT){
 return (PROFILES[profile]?.loadsDotEnv??[]).flatMap(file=>checkEnv(read(join(root,file)),profile).map(name=>`${name} (${file})`));
}
// An entry point's own check, whatever its command line loaded: its env must come from its profile's file and hold no
// other secret (DELTA-SECRETS-5). Throws naming the variables, never their values.
export function requireProfile(profile,env=process.env){
 const unneeded=checkEnv(env,profile);
 if(env.ABNAHME_ENV_PROFILE!==profile||unneeded.length)throw new Error(`${env.ABNAHME_ENV_PROFILE===profile?'':`env profile ${env.ABNAHME_ENV_PROFILE??'missing'}, expected ${profile}. `}${unneeded.length?`It must not hold ${unneeded.join(', ')}. `:''}Start with --env-file=.local/env/${profile}.env only (node scripts/env-split.mjs writes it).`);
}
const line=([name,value])=>{ if(/["\\\n]/.test(value)) throw new Error(`${name}: the value has a quote, backslash or newline`); return `${name}="${value}"`; };

export function splitEnv(root=ROOT){ // the repo this script lives in, from any cwd
 const env={...read(join(root,'.env')),...read(join(root,'.local/secrets.env'))};
 const config=Object.entries(env).filter(([name,value])=>CONFIG.includes(name)&&!looksSecret(name,value));
 const dir=join(root,'.local/env');
 mkdirSync(dir,{recursive:true,mode:0o700}); chmodSync(dir,0o700);
 if(!existsSync(join(root,BUYER_KEY_FILE))) writeFileSync(join(root,BUYER_KEY_FILE),`RM_BUYER_KEY="${randomBytes(32).toString('hex')}"\n`,{mode:0o600,flag:'wx'});
 const missing={};
 for(const [profile,{secrets,files=[]}] of Object.entries(PROFILES)){
  const source=Object.assign({},env,...files.map(f=>read(join(root,f))));
  missing[profile]=secrets.filter(name=>!source[name]);
  const own=secrets.filter(name=>source[name]).map(name=>[name,source[name]]);
  const text=[`# generated by scripts/env-split.mjs from .env${files.map(f=>`, ${f}`).join('')}; do not edit`,
   line(['ABNAHME_ENV_PROFILE',profile]),...config.map(line),...own.map(line)].join('\n')+'\n';
  const path=join(dir,`${profile}.env`);
  writeFileSync(path+'.tmp',text,{mode:0o600}); chmodSync(path+'.tmp',0o600); renameSync(path+'.tmp',path);
 }
 return {missing,dropped:Object.keys(env).filter(name=>!SECRETS.includes(name)&&!config.some(([c])=>c===name))};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){ // import.meta.main needs Node 24.2
 const {missing,dropped}=splitEnv();
 for(const [profile,{secrets}] of Object.entries(PROFILES)){
  const have=secrets.filter(name=>!missing[profile].includes(name));
  console.log(`.local/env/${profile}.env: ${have.join(', ')||'no secrets'}${missing[profile].length?`; MISSING ${missing[profile].join(', ')}`:''}`);
 }
 if(dropped.length) console.log(`copied nowhere (not in CONFIG or SECRETS, or a value with credentials): ${dropped.join(', ')}`);
}
