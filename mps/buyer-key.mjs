// Runtime API key for the Büro-Agent BUYER side (MPS /purchase, request-refund,
// cancel-refund-request), scoped to the Büro purchasing hot wallet. Same pattern as the
// template's `payment-registration.mjs key`. Run from the repo root:
//   node --env-file=.local/env/mps-admin.env mps/buyer-key.mjs
// Note: a wallet-scoped key cannot read a purchase before FundsLocked, because MPS assigns
// the purchasing wallet to the purchase only when it locks the funds (resolve returns 404).
import fs from 'node:fs';
const statePath='docs/buero-purchasing-state.json';
const runtimePath='.local/buero-buyer-runtime.env';
const state=JSON.parse(fs.readFileSync(statePath));
const save=()=>fs.writeFileSync(statePath,JSON.stringify(state,null,2));
if(state.runtimeKeyId){if(!/^MPS_BUYER_TOKEN=[^*\s]/.test(fs.existsSync(runtimePath)?fs.readFileSync(runtimePath,'utf8'):''))throw Error('Buyer key recovery required: token file missing');console.log('Buyer key already saved',state.runtimeKeyId);process.exit(0);}
if(state.keyWritePending)throw Error('Previous key write uncertain; inspect API key records before retry');
state.keyWritePending=true;save();
const r=await fetch(process.env.MPS_URL+'/api/v1/api-key',{method:'POST',headers:{token:process.env.ADMIN_KEY,'content-type':'application/json'},body:JSON.stringify({usageLimited:'false',UsageCredits:[],NetworkLimit:['Preprod'],ChainIdLimit:[],canRead:true,canPay:true,canAdmin:false,walletScopeEnabled:true,WalletScopeHotWalletIds:[state.walletId],x402WalletScopeEnabled:true,X402WalletScopeEvmWalletIds:[]})});
const j=await r.json();if(!r.ok||j.status!=='success')throw Error(`${r.status}: ${JSON.stringify(j.error??j.message??{})}`);
const key=j.data;state.runtimeKeyId=key.id;state.keyWritePending=false;save();
if(typeof key.token!=='string'||key.token.startsWith('*****'))throw Error('Created key token was not revealed; key ID preserved');
fs.writeFileSync(runtimePath,`MPS_BUYER_TOKEN=${key.token}\n`,{mode:0o600});fs.chmodSync(runtimePath,0o600);
state.keyEvidence={canRead:key.canRead,canPay:key.canPay,canAdmin:key.canAdmin,NetworkLimit:key.NetworkLimit,walletScopeEnabled:key.walletScopeEnabled};save();
console.log('Buyer key created',key.id,JSON.stringify(state.keyEvidence));
