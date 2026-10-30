// Read-only MPS key for the Büro-Agent buyer loop: canRead only, Preprod, no wallet scope. The buyer polls its
// purchase with it before FundsLocked, where the wallet-scoped MPS_BUYER_TOKEN gets 404, so the buyer process never
// holds ADMIN_KEY. MPS 0.29.0 serves GET /wallet (mnemonics), /wallet/transfer-funds and /api-key to admin keys only,
// and /purchase, refunds and /payment to canPay keys only. Same pattern as buyer-key.mjs. Run from the repo root:
//   node --env-file=.local/env/mps-admin.env mps/read-key.mjs
import fs from 'node:fs';
const statePath='docs/buero-read-key-state.json';
const runtimePath='.local/buero-read-runtime.env';
const state=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath)):{};
const save=()=>fs.writeFileSync(statePath,JSON.stringify(state,null,2));
if(state.runtimeKeyId){if(!/^MPS_READ_TOKEN=[^*\s]/.test(fs.existsSync(runtimePath)?fs.readFileSync(runtimePath,'utf8'):''))throw Error('Read key recovery required: token file missing');console.log('Read key already saved',state.runtimeKeyId);process.exit(0);}
if(state.keyWritePending)throw Error('Previous key write uncertain; inspect API key records before retry');
state.keyWritePending=true;save();
const r=await fetch(process.env.MPS_URL+'/api/v1/api-key',{method:'POST',headers:{token:process.env.ADMIN_KEY,'content-type':'application/json'},body:JSON.stringify({usageLimited:'false',UsageCredits:[],NetworkLimit:['Preprod'],ChainIdLimit:[],canRead:true,canPay:false,canAdmin:false,walletScopeEnabled:false,WalletScopeHotWalletIds:[],x402WalletScopeEnabled:true,X402WalletScopeEvmWalletIds:[]})});
const j=await r.json();if(!r.ok||j.status!=='success')throw Error(`${r.status}: ${JSON.stringify(j.error??j.message??{})}`);
const key=j.data;state.runtimeKeyId=key.id;state.keyWritePending=false;save();
if(typeof key.token!=='string'||key.token.startsWith('*****'))throw Error('Created key token was not revealed; key ID preserved');
fs.writeFileSync(runtimePath,`MPS_READ_TOKEN=${key.token}\n`,{mode:0o600});fs.chmodSync(runtimePath,0o600);
state.keyEvidence={canRead:key.canRead,canPay:key.canPay,canAdmin:key.canAdmin,NetworkLimit:key.NetworkLimit,walletScopeEnabled:key.walletScopeEnabled};save();
console.log('Read key created',key.id,JSON.stringify(state.keyEvidence));
