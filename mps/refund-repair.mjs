// Operator workaround for masumi-payment-service #1327 (MPS 0.29.0; our fix PR #1328 is open). After the seller's
// AuthorizeRefund, tx-sync keeps the purchase's old resultHash (decodedNewContract?.resultHash ?? decodedOldContract
// .resultHash) although the datum's result_hash is now empty, and the V2 auto-refund job selects only resultHash null:
// the Büro's 1 tUSDM stays in RefundAuthorized. For each such purchase this checks on chain (Blockfrost) that its own
// unspent escrow output has state RefundAuthorized and an empty result_hash, then lets MPS re-read that tx:
// POST /request-repair/preview, and only if MPS derives RefundAuthorized with resultHash null, the non-forced
// POST /request-repair with the preview's requestVersion. MPS then sends WithdrawRefund by itself (45 s to 3:23 live).
// Idempotent: a repaired purchase has resultHash null and is skipped. One log line per action, no keys. From the repo root:
//   node --env-file=.local/env/mps-admin.env mps/refund-repair.mjs          # one pass; exit 1 if a purchase failed
//   node --env-file=.local/env/mps-admin.env mps/refund-repair.mjs --loop   # a pass every 60 s
import {realpathSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {decodeHash} from '../buero/escrow.mjs';

const NETWORK='Preprod',PAGE=100,LOOP_MS=60000;
const BLOCKFROST='https://cardano-preprod.blockfrost.io/api/v0';
// V2 datum (utils/converter/string-datum-convert decodeV2ContractDatum @0.29.0): 10 input_hash, 11 result_hash,
// 18 state; constructor 5 is RefundAuthorized.
const INPUT_HASH=10,RESULT_HASH=11,STATE=18,REFUND_AUTHORIZED=5;

export async function repairStuckRefunds({url=process.env.MPS_URL,adminKey=process.env.ADMIN_KEY,blockfrostKey=process.env.BLOCKFROST_API_KEY_PREPROD,fetchImpl=fetch,log=console.log}={}){
 if(!url||!adminKey||!blockfrostKey)throw new Error('Set MPS_URL, ADMIN_KEY and BLOCKFROST_API_KEY_PREPROD: node --env-file=.local/env/mps-admin.env mps/refund-repair.mjs');
 async function mps(path,body){
  const r=await fetchImpl(`${url}/api/v1${path}`,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(60000),headers:{token:adminKey,'content-type':'application/json'},body:body&&JSON.stringify(body)});
  const j=await r.json().catch(()=>({}));
  if(!r.ok||j.status!=='success')throw new Error(`MPS ${path.split('?')[0]} HTTP ${r.status}: ${JSON.stringify(j.error??j.message??'')}`);
  return j.data;
 }
 async function bf(path){const r=await fetchImpl(BLOCKFROST+path,{headers:{project_id:blockfrostKey},signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error(`Blockfrost ${path.slice(0,40)}… HTTP ${r.status}`);return r.json();}

 // Without a source type or contract filter, GET /purchase lists Web3CardanoV1 only (purchases/queries.ts), which is why
 // a plain GET /purchase?network=Preprod was empty. A cursor page starts with the cursor row itself (Prisma cursor).
 const seen=new Map();
 for(let cursor;;){
  const {Purchases}=await mps(`/purchase?network=${NETWORK}&filterPaymentSourceType=Web3CardanoV2&filterOnChainState=RefundAuthorized&limit=${PAGE}${cursor?`&cursorId=${cursor}`:''}`);
  const fresh=Purchases.filter(p=>!seen.has(p.id));
  for(const p of fresh)seen.set(p.id,p);
  if(Purchases.length<PAGE||!fresh.length)break;
  cursor=Purchases.at(-1).id;
 }
 const done={checked:seen.size,repaired:[],skipped:[],failed:[]};
 for(const p of [...seen.values()].filter(p=>p.resultHash)){
  const txHash=p.CurrentTransaction?.txHash,who=`${p.id} (AuthorizeRefund ${String(txHash).slice(0,12)}…)`;
  try{
   const why=await notStuck(p);
   if(why){log(`skip ${who}: ${why}`);done.skipped.push(p.id);continue;}
   const request={kind:'Purchase',network:NETWORK,blockchainIdentifier:p.blockchainIdentifier,txHash};
   const preview=await mps('/request-repair/preview',request);
   if(preview.derivedOnChainState!=='RefundAuthorized'||preview.resultHash!==null){log(`skip ${who}: MPS preview derives ${preview.derivedOnChainState} with resultHash ${preview.resultHash}`);done.skipped.push(p.id);continue;}
   const r=await mps('/request-repair',{...request,requestVersion:preview.requestVersion});
   log(`repaired ${who}: resultHash ${p.resultHash.slice(0,12)}… -> null (${r.newOnChainState}, forced ${r.forced}); MPS sends WithdrawRefund by itself`);
   done.repaired.push(p.id);
  }catch(e){log(`error ${who}: ${e.message}`);done.failed.push(p.id);}
 }
 return done;

 // Null for the #1327 shape only: MPS waits (no action, no error) on a confirmed AuthorizeRefund, and that tx's own
 // escrow output (datum input_hash = this purchase's) is unspent, RefundAuthorized and has an empty result_hash.
 async function notStuck(p){
  const next=p.NextAction,current=p.CurrentTransaction;
  if(next?.requestedAction!=='WaitingForExternalAction'||next.errorType)return `MPS next action ${next?.requestedAction}${next?.errorType?` (${next.errorType})`:''}`;
  if(current?.status!=='Confirmed'||current.newOnChainState!=='RefundAuthorized')return `current tx is ${current?.status} ${current?.newOnChainState}, not a confirmed AuthorizeRefund`;
  const {outputs}=await bf(`/txs/${current.txHash}/utxos`);
  const own=[];
  for(const o of outputs.filter(o=>o.address===p.PaymentSource?.smartContractAddress&&o.data_hash)){
   const {json_value}=await bf(`/scripts/datum/${o.data_hash}`);
   if(decodeHash(json_value,INPUT_HASH)===p.inputHash)own.push({o,fields:json_value.fields});
  }
  if(own.length!==1)return `${own.length} escrow outputs with this input_hash on chain`;
  const [{o,fields}]=own;
  if(o.consumed_by_tx!==null)return `escrow output #${o.output_index} is ${o.consumed_by_tx?`spent by ${o.consumed_by_tx.slice(0,12)}…`:'of unknown spent state'}`;
  if(fields[STATE]?.constructor!==REFUND_AUTHORIZED)return `datum state is ${JSON.stringify(fields[STATE])}, not RefundAuthorized`;
  if(fields[RESULT_HASH]?.bytes!=='')return `datum result_hash is not empty (${String(decodeHash({fields},RESULT_HASH)).slice(0,12)}…)`;
  return null;
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){
 const loop=process.argv.includes('--loop');
 const log=line=>console.log(`${new Date().toISOString()} ${line}`);
 for(let first=true;;first=false){
  const r=await repairStuckRefunds({log}).catch(e=>{log(`error: ${e.message}`);return null;});
  if(r&&(!loop||first||r.repaired.length||r.skipped.length||r.failed.length))log(`pass: ${r.checked} RefundAuthorized purchase(s), ${r.repaired.length} repaired, ${r.skipped.length} skipped, ${r.failed.length} failed`);
  if(!loop)process.exit(r&&!r.failed.length?0:1);
  await new Promise(resolve=>setTimeout(resolve,LOOP_MS));
 }
}
