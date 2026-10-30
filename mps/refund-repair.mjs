// Operator workaround for masumi-payment-service #1327 (MPS 0.29.0; our fix PR #1328 is open). After the seller's
// AuthorizeRefund, tx-sync keeps the purchase's old resultHash (decodedNewContract?.resultHash ?? decodedOldContract
// .resultHash) although the datum's result_hash is now empty, and the V2 auto-refund job selects only resultHash null:
// the Büro's 1 tUSDM stays in RefundAuthorized. For each such purchase this checks on chain (Blockfrost) that its own
// unspent escrow output has state RefundAuthorized and an empty result_hash, then lets MPS re-read that tx:
// POST /request-repair/preview, and only if MPS derives RefundAuthorized with resultHash null, the non-forced
// POST /request-repair with the preview's requestVersion. MPS then sends WithdrawRefund by itself (45 s to 3:23 live).
// Idempotent: a repaired purchase has resultHash null and is skipped. One log line per action, no keys.
// The same pass also runs repairStuckWithdrawals (LB2-1, below) for the seller side and repairHeldRefunds (DELTA-SELLER-2, below)
// for refunds RechnungsMeister decided. It refuses any profile but mps-admin (DELTA-SECRETS-5). From the repo root:
//   node --env-file=.local/env/mps-admin.env --import=./scripts/env-guard.mjs mps/refund-repair.mjs          # one pass; exit 1 if a request failed
//   node --env-file=.local/env/mps-admin.env --import=./scripts/env-guard.mjs mps/refund-repair.mjs --loop   # a pass every 60 s
// Exactly one at a time: both take the lock .local/refund-repair.lock (DELTA-OPERATOR-3).
import {realpathSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {decodeHash} from '../buero/escrow.mjs';
import {acquireWorkerLock} from '../worker-lock.mjs';
import {requireProfile} from '../scripts/env-split.mjs';

const NETWORK='Preprod',PAGE=100,LOOP_MS=60000,STALE_MS=15*60000;
// A payment MPS parks again after a repair (for example a collection failure, DELTA-OPERATOR-1) is repaired at most once
// per RETRY_MS and MAX_REPAIRS times per loop process, then reported once as an alarm.
const RETRY_MS=60*60000,MAX_REPAIRS=3;
// The fields a repair decides on. A re-read after the preview that differs means another actor moved the record since the
// listing; the write is then skipped (DELTA-OPERATOR-3). A change after the re-read fails with the preview's requestVersion.
const shape=r=>[r.onChainState,r.NextAction?.requestedAction,!!r.NextAction?.errorType,!!r.resultHash,r.CurrentTransaction?.txHash,r.CurrentTransaction?.status,r.CurrentTransaction?.newOnChainState].join('|');
const movedTo=r=>`changed after the listing (now ${r.NextAction?.requestedAction} on ${r.CurrentTransaction?.status} ${String(r.CurrentTransaction?.txHash).slice(0,12)}…); not repaired`;
const BLOCKFROST='https://cardano-preprod.blockfrost.io/api/v0';
// V2 datum (utils/converter/string-datum-convert decodeV2ContractDatum @0.29.0): 10 input_hash, 11 result_hash,
// 18 state; constructor 4 is WithdrawAuthorized, 5 is RefundAuthorized.
const INPUT_HASH=10,RESULT_HASH=11,STATE=18,WITHDRAW_AUTHORIZED=4,REFUND_AUTHORIZED=5;

function clients({url,adminKey,blockfrostKey,fetchImpl}){
 if(!url||!adminKey||!blockfrostKey)throw new Error('Set MPS_URL, ADMIN_KEY and BLOCKFROST_API_KEY_PREPROD: node --env-file=.local/env/mps-admin.env mps/refund-repair.mjs');
 async function mps(path,body){
  const r=await fetchImpl(`${url}/api/v1${path}`,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(60000),headers:{token:adminKey,'content-type':'application/json'},body:body&&JSON.stringify(body)});
  const j=await r.json().catch(()=>({}));
  if(!r.ok||j.status!=='success')throw new Error(`MPS ${path.split('?')[0]} HTTP ${r.status}: ${JSON.stringify(j.error??j.message??'')}`);
  return j.data;
 }
 async function bf(path){const r=await fetchImpl(BLOCKFROST+path,{headers:{project_id:blockfrostKey},signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error(`Blockfrost ${path.slice(0,40)}… HTTP ${r.status}`);return r.json();}
 // Without a source type or contract filter, GET /purchase and GET /payment list Web3CardanoV1 only (purchases/queries.ts),
 // which is why a plain GET /purchase?network=Preprod was empty. A cursor page starts with the cursor row itself (Prisma cursor).
 async function list(path,key){
  const seen=new Map();
  for(let cursor;;){
   const rows=(await mps(`${path}&limit=${PAGE}${cursor?`&cursorId=${cursor}`:''}`))[key];
   const fresh=rows.filter(x=>!seen.has(x.id));
   for(const x of fresh)seen.set(x.id,x);
   if(rows.length<PAGE||!fresh.length)break;
   cursor=rows.at(-1).id;
  }
  return [...seen.values()];
 }
 // The escrow outputs of txHash at the contract whose datum input_hash is this request's.
 async function ownOutputs(txHash,address,inputHash){
  const {outputs}=await bf(`/txs/${txHash}/utxos`);
  const own=[];
  for(const o of outputs.filter(o=>o.address===address&&o.data_hash)){
   const {json_value}=await bf(`/scripts/datum/${o.data_hash}`);
   if(decodeHash(json_value,INPUT_HASH)===inputHash)own.push({o,fields:json_value.fields});
  }
  return own;
 }
 return {mps,list,ownOutputs};
}
const spent=o=>o.consumed_by_tx!==null&&`escrow output #${o.output_index} is ${o.consumed_by_tx?`spent by ${o.consumed_by_tx.slice(0,12)}…`:'of unknown spent state'}`;

export async function repairStuckRefunds({url=process.env.MPS_URL,adminKey=process.env.ADMIN_KEY,blockfrostKey=process.env.BLOCKFROST_API_KEY_PREPROD,fetchImpl=fetch,log=console.log}={}){
 const {mps,list,ownOutputs}=clients({url,adminKey,blockfrostKey,fetchImpl});
 const purchases=await list(`/purchase?network=${NETWORK}&filterPaymentSourceType=Web3CardanoV2&filterOnChainState=RefundAuthorized`,'Purchases');
 const done={checked:purchases.length,repaired:[],skipped:[],failed:[]};
 for(const p of purchases.filter(p=>p.resultHash)){
  const txHash=p.CurrentTransaction?.txHash,who=`${p.id} (AuthorizeRefund ${String(txHash).slice(0,12)}…)`;
  try{
   const why=await notStuck(p);
   if(why){log(`skip ${who}: ${why}`);done.skipped.push(p.id);continue;}
   const request={kind:'Purchase',network:NETWORK,blockchainIdentifier:p.blockchainIdentifier,txHash};
   const preview=await mps('/request-repair/preview',request);
   if(preview.derivedOnChainState!=='RefundAuthorized'||preview.resultHash!==null){log(`skip ${who}: MPS preview derives ${preview.derivedOnChainState} with resultHash ${preview.resultHash}`);done.skipped.push(p.id);continue;}
   const fresh=await mps('/purchase/resolve-blockchain-identifier',{blockchainIdentifier:p.blockchainIdentifier,network:NETWORK,includeHistory:'false'});
   if(shape(fresh)!==shape(p)){log(`skip ${who}: MPS record ${movedTo(fresh)}`);done.skipped.push(p.id);continue;}
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
  const own=await ownOutputs(current.txHash,p.PaymentSource?.smartContractAddress,p.inputHash);
  if(own.length!==1)return `${own.length} escrow outputs with this input_hash on chain`;
  const [{o,fields}]=own;
  if(spent(o))return spent(o);
  if(fields[STATE]?.constructor!==REFUND_AUTHORIZED)return `datum state is ${JSON.stringify(fields[STATE])}, not RefundAuthorized`;
  if(fields[RESULT_HASH]?.bytes!=='')return `datum result_hash is not empty (${String(decodeHash({fields},RESULT_HASH)).slice(0,12)}…)`;
  return null;
 }
}

// LB2-1 (MPS 0.29.0, also on main and dev; upstream issue masumi-payment-service#1331). In a batched V2 SubmitResult
// all escrows share one Transaction row. tx-sync's first entry marks it Confirmed, and for every later escrow that stays
// Disputed (a cure) the handler's idempotency guard (same txHash, Confirmed, onChainState already Disputed) returns early. The
// payment keeps SubmitResultInitiated, the buyer's AuthorizeWithdrawal then maps to WaitingForManualAction ("Possible a action
// was executed externally"), and MPS never sends the seller's Withdraw. For a V2 payment in WithdrawAuthorized that is in
// WaitingForManualAction, or idle in WaitingForExternalAction for more than 15 min, this checks on chain that the current
// AuthorizeWithdrawal's own escrow output is unspent, WithdrawAuthorized and has MPS's result hash, then:
//   1. POST /request-repair/preview (kind Payment); it must derive WithdrawAuthorized at that output with that result hash.
//   2. POST /request-repair with the requestVersion, never forced. It links the AuthorizeWithdrawal into the history (and fills a
//      null resultHash from the datum). error-state-recovery repoints a payment to the newest Confirmed tx of its history; without
//      the link that is the spent cure tx.
//   3. Re-read, check that the newest Confirmed history tx is the AuthorizeWithdrawal, then POST /payment/error-state-recovery with
//      that updatedAt and without retryPreviousAction (a retry would submit the cure again). It clears to WaitingForExternalAction.
// MPS then sends Withdraw by itself (live: on chain 33 s to 58 s after the clear). Other shapes unchanged for more than 15 min
// are only reported.
export async function repairStuckWithdrawals({url=process.env.MPS_URL,adminKey=process.env.ADMIN_KEY,blockfrostKey=process.env.BLOCKFROST_API_KEY_PREPROD,fetchImpl=fetch,log=console.log,now=Date.now,attempts=new Map()}={}){
 const {mps,list,ownOutputs}=clients({url,adminKey,blockfrostKey,fetchImpl});
 const payments=await list(`/payment?network=${NETWORK}&filterPaymentSourceType=Web3CardanoV2&filterOnChainState=WithdrawAuthorized`,'Payments');
 const done={checked:payments.length,repaired:[],skipped:[],failed:[]};
 for(const p of payments){
  const next=p.NextAction,idleMs=now()-Date.parse(p.nextActionOrOnChainStateOrResultLastChangedAt??p.updatedAt);
  const manual=next?.requestedAction==='WaitingForManualAction'&&!!next.errorType;
  if(!manual&&!(idleMs>STALE_MS))continue;
  const txHash=p.CurrentTransaction?.txHash,who=`${p.id} (AuthorizeWithdrawal ${String(txHash).slice(0,12)}…)`,idleFor=`${Math.floor(idleMs/60000)} min`;
  const skip=why=>{log(`skip ${who}: ${why}`);done.skipped.push(p.id);};
  const mpsError=next?.errorType?` (${next.errorType}: ${String(next.errorNote??'no error note').slice(0,200)})`:'';
  const tried=attempts.get(p.id);
  if(tried?.count>=MAX_REPAIRS){if(!tried.alarmed){tried.alarmed=true;log(`alarm ${who}: MPS left this payment stuck again after ${tried.count} automatic repairs${mpsError}; no further automatic repair, an operator must look at it`);done.skipped.push(p.id);}continue;}
  if(tried&&now()-tried.at<RETRY_MS)continue;
  try{
   if(!manual&&(next?.requestedAction!=='WaitingForExternalAction'||next.errorType)){skip(`MPS next action ${next?.requestedAction}${next?.errorType?` (${next.errorType})`:''} unchanged for ${idleFor}; no automatic repair for this`);continue;}
   const chain=await onChain(p);
   if(chain.why){skip(chain.why);continue;}
   if(!manual&&p.resultHash){skip(`MPS waits in WaitingForExternalAction for ${idleFor} with resultHash set; nothing to repair, check AUTO_WITHDRAW_PAYMENTS and the MPS log`);continue;}
   const request={kind:'Payment',network:NETWORK,blockchainIdentifier:p.blockchainIdentifier,txHash};
   const preview=await mps('/request-repair/preview',request);
   if(preview.derivedOnChainState!=='WithdrawAuthorized'||preview.outputIndex!==chain.outputIndex||preview.resultHash!==chain.resultHash){skip(`MPS preview derives ${preview.derivedOnChainState} at #${preview.outputIndex} with resultHash ${String(preview.resultHash).slice(0,12)}…`);continue;}
   const before=await mps('/payment/resolve-blockchain-identifier',{blockchainIdentifier:p.blockchainIdentifier,network:NETWORK,includeHistory:'false'});
   if(shape(before)!==shape(p)){skip(`MPS record ${movedTo(before)}`);continue;}
   attempts.set(p.id,{count:(tried?.count??0)+1,at:now()});
   await mps('/request-repair',{...request,requestVersion:preview.requestVersion});
   if(!manual){log(`repaired ${who}: resultHash null -> ${chain.resultHash.slice(0,12)}… from the datum; MPS sends Withdraw by itself`);done.repaired.push(p.id);continue;}
   const fresh=await mps('/payment/resolve-blockchain-identifier',{blockchainIdentifier:p.blockchainIdentifier,network:NETWORK,includeHistory:'true'});
   const newest=(fresh.TransactionHistory??[]).filter(t=>t.status==='Confirmed'&&t.txHash).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))[0];
   if(fresh.CurrentTransaction?.txHash!==txHash||newest?.txHash!==txHash)throw new Error(`after request-repair, error-state-recovery would repoint the payment to ${String(newest?.txHash).slice(0,12)}…, not this AuthorizeWithdrawal; not cleared`);
   if(fresh.NextAction?.requestedAction!=='WaitingForManualAction'||!fresh.NextAction.errorType){skip(`MPS next action changed to ${fresh.NextAction?.requestedAction} meanwhile; not cleared`);continue;}
   const cleared=await mps('/payment/error-state-recovery',{blockchainIdentifier:p.blockchainIdentifier,network:NETWORK,updatedAt:fresh.updatedAt});
   if(cleared.NextAction?.requestedAction!=='WaitingForExternalAction'||cleared.CurrentTransaction?.txHash!==txHash)throw new Error(`error-state-recovery left ${cleared.NextAction?.requestedAction} on ${String(cleared.CurrentTransaction?.txHash).slice(0,12)}…`);
   log(`repaired ${who}: WaitingForManualAction${mpsError} cleared to WaitingForExternalAction on this AuthorizeWithdrawal; MPS sends Withdraw by itself`);
   done.repaired.push(p.id);
  }catch(e){log(`error ${who}: ${e.message}`);done.failed.push(p.id);}
 }
 return done;

 // The own escrow output of the payment's confirmed AuthorizeWithdrawal: unspent, WithdrawAuthorized, with a result_hash
 // that equals MPS's (when MPS has one). Otherwise {why}.
 async function onChain(p){
  const current=p.CurrentTransaction;
  if(current?.status!=='Confirmed'||current.newOnChainState!=='WithdrawAuthorized')return {why:`current tx is ${current?.status} ${current?.newOnChainState}, not a confirmed AuthorizeWithdrawal`};
  const own=await ownOutputs(current.txHash,p.PaymentSource?.smartContractAddress,p.inputHash);
  if(own.length!==1)return {why:`${own.length} escrow outputs with this input_hash on chain`};
  const [{o,fields}]=own,resultHash=decodeHash({fields},RESULT_HASH);
  if(spent(o))return {why:spent(o)};
  if(fields[STATE]?.constructor!==WITHDRAW_AUTHORIZED)return {why:`datum state is ${JSON.stringify(fields[STATE])}, not WithdrawAuthorized`};
  if(!resultHash)return {why:'datum result_hash is empty'};
  if(p.resultHash&&p.resultHash!==resultHash)return {why:`datum result_hash ${resultHash.slice(0,12)}… is not MPS's ${p.resultHash.slice(0,12)}…`};
  return {outputIndex:o.output_index,resultHash};
 }
}

// DELTA-SELLER-2 (MPS 0.29.0). RechnungsMeister decides the refund of a refused cure (its job file has phase refund-pending)
// while MPS holds the Disputed payment outside WaitingForExternalAction, the only state authorize-refund takes:
//   - WaitingForManualAction with an error (a failed cure tx, request-failure.ts): the LB2-1 repair. The confirmed current
//     tx's own escrow output (datum input_hash = the payment's) must be unique, unspent and Disputed (field 18, constructor 3)
//     with MPS's result hash. Preview, request-repair (never forced), re-read, then error-state-recovery without
//     retryPreviousAction. RechnungsMeister then sends the refund on its next tick.
//   - SubmitResultInitiated without an error (a cure in a batched SubmitResult, LB2-1), or any other action, unchanged for
//     more than 15 min: no supported endpoint leaves it (error-state-recovery takes WaitingForManualAction with an error only,
//     request-repair leaves NextAction as it is). One alarm line; an operator must act (plan/MPS.md).
// Payments without a decided refund are never touched. The backoff of DELTA-OPERATOR-1 applies (the loop shares attempts).
const DISPUTED=3;
// RechnungsMeister jobs whose refund is decided and not yet sent, by blockchainIdentifier. Unreadable files are skipped.
function refundDecided(dir){
 const decided=new Map();
 let files=[];try{files=readdirSync(dir).filter(f=>/^[0-9a-f-]{36}\.json$/.test(f));}catch{}
 for(const f of files){
  try{const job=JSON.parse(readFileSync(join(dir,f),'utf8'));if(job.phase==='refund-pending'&&!job.closed&&job.payment?.blockchainIdentifier)decided.set(job.payment.blockchainIdentifier,job.id);}catch{}
 }
 return decided;
}
export async function repairHeldRefunds({url=process.env.MPS_URL,adminKey=process.env.ADMIN_KEY,blockfrostKey=process.env.BLOCKFROST_API_KEY_PREPROD,fetchImpl=fetch,log=console.log,now=Date.now,attempts=new Map(),alarms=new Set(),jobsDir='.local/rechnungsmeister-jobs'}={}){
 const {mps,list,ownOutputs}=clients({url,adminKey,blockfrostKey,fetchImpl});
 const decided=refundDecided(jobsDir),done={checked:0,repaired:[],skipped:[],failed:[]};
 if(!decided.size)return done;
 const payments=await list(`/payment?network=${NETWORK}&filterPaymentSourceType=Web3CardanoV2&filterOnChainState=Disputed`,'Payments');
 done.checked=payments.length;
 for(const p of payments){
  const next=p.NextAction,idleMs=now()-Date.parse(p.nextActionOrOnChainStateOrResultLastChangedAt??p.updatedAt);
  if(!decided.has(p.blockchainIdentifier)||next?.requestedAction==='WaitingForExternalAction')continue;  // idle: RechnungsMeister sends it
  const txHash=p.CurrentTransaction?.txHash,who=`${p.id} (Disputed ${String(txHash).slice(0,12)}…, refund decided by RechnungsMeister ${decided.get(p.blockchainIdentifier)})`;
  const mpsError=next?.errorType?` (${next.errorType}: ${String(next.errorNote??'no error note').slice(0,200)})`:'';
  const alarm=(key,why)=>{if(alarms.has(key))return;alarms.add(key);log(`alarm ${who}: ${why}`);done.skipped.push(p.id);};
  const skip=why=>{log(`skip ${who}: ${why}`);done.skipped.push(p.id);};
  if(!(next?.requestedAction==='WaitingForManualAction'&&next.errorType)){
   if(idleMs>STALE_MS)alarm(`${p.id} ${next?.requestedAction}`,`MPS holds it at ${next?.requestedAction}${mpsError}, unchanged for ${Math.floor(idleMs/60000)} min; no supported MPS endpoint returns it to WaitingForExternalAction, so the refund cannot be sent; an operator must act (plan/MPS.md)`);
   continue;
  }
  const tried=attempts.get(p.id);
  if(tried?.count>=MAX_REPAIRS){if(!tried.alarmed){tried.alarmed=true;log(`alarm ${who}: MPS left this payment stuck again after ${tried.count} automatic repairs${mpsError}; no further automatic repair, an operator must look at it`);done.skipped.push(p.id);}continue;}
  if(tried&&now()-tried.at<RETRY_MS)continue;
  try{
   const chain=await onChain(p);
   if(chain.why){alarm(`${p.id} ${chain.why}`,`${chain.why}; not repaired automatically, an operator must look at it (plan/MPS.md)`);continue;}
   const request={kind:'Payment',network:NETWORK,blockchainIdentifier:p.blockchainIdentifier,txHash};
   const preview=await mps('/request-repair/preview',request);
   if(preview.derivedOnChainState!=='Disputed'||preview.outputIndex!==chain.outputIndex||preview.resultHash!==chain.resultHash){skip(`MPS preview derives ${preview.derivedOnChainState} at #${preview.outputIndex} with resultHash ${String(preview.resultHash).slice(0,12)}…`);continue;}
   const before=await mps('/payment/resolve-blockchain-identifier',{blockchainIdentifier:p.blockchainIdentifier,network:NETWORK,includeHistory:'false'});
   if(shape(before)!==shape(p)){skip(`MPS record ${movedTo(before)}`);continue;}
   attempts.set(p.id,{count:(tried?.count??0)+1,at:now()});
   await mps('/request-repair',{...request,requestVersion:preview.requestVersion});
   const fresh=await mps('/payment/resolve-blockchain-identifier',{blockchainIdentifier:p.blockchainIdentifier,network:NETWORK,includeHistory:'true'});
   const newest=(fresh.TransactionHistory??[]).filter(t=>t.status==='Confirmed'&&t.txHash).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))[0];
   if(fresh.CurrentTransaction?.txHash!==txHash||newest?.txHash!==txHash)throw new Error(`after request-repair, error-state-recovery would repoint the payment to ${String(newest?.txHash).slice(0,12)}…, not this Disputed tx; not cleared`);
   if(fresh.NextAction?.requestedAction!=='WaitingForManualAction'||!fresh.NextAction.errorType){skip(`MPS next action changed to ${fresh.NextAction?.requestedAction} meanwhile; not cleared`);continue;}
   const cleared=await mps('/payment/error-state-recovery',{blockchainIdentifier:p.blockchainIdentifier,network:NETWORK,updatedAt:fresh.updatedAt});
   if(cleared.NextAction?.requestedAction!=='WaitingForExternalAction'||cleared.CurrentTransaction?.txHash!==txHash)throw new Error(`error-state-recovery left ${cleared.NextAction?.requestedAction} on ${String(cleared.CurrentTransaction?.txHash).slice(0,12)}…`);
   log(`repaired ${who}: WaitingForManualAction${mpsError} cleared to WaitingForExternalAction on the unspent Disputed escrow; RechnungsMeister sends the decided refund on its next tick`);
   done.repaired.push(p.id);
  }catch(e){log(`error ${who}: ${e.message}`);done.failed.push(p.id);}
 }
 return done;

 // The own escrow output of the payment's confirmed current tx: unspent, Disputed, with MPS's result hash. Otherwise {why}.
 async function onChain(p){
  const current=p.CurrentTransaction;
  if(current?.status!=='Confirmed'||!current.txHash)return {why:`current tx is ${current?.status} ${String(current?.txHash).slice(0,12)}…, not a confirmed tx`};
  const own=await ownOutputs(current.txHash,p.PaymentSource?.smartContractAddress,p.inputHash);
  if(own.length!==1)return {why:`${own.length} escrow outputs with this input_hash on chain`};
  const [{o,fields}]=own,resultHash=decodeHash({fields},RESULT_HASH);
  if(spent(o))return {why:spent(o)};
  if(fields[STATE]?.constructor!==DISPUTED)return {why:`datum state is ${JSON.stringify(fields[STATE])}, not Disputed`};
  if(p.resultHash&&p.resultHash!==resultHash)return {why:`datum result_hash ${String(resultHash).slice(0,12)}… is not MPS's ${p.resultHash.slice(0,12)}…`};
  return {outputIndex:o.output_index,resultHash};
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){
 try{requireProfile('mps-admin');}catch(e){console.error(`refund-repair: ${e.message}`);process.exit(1);}  // DELTA-SECRETS-5
 let releaseLock;
 try{releaseLock=acquireWorkerLock('.local/refund-repair.lock');}
 catch(e){console.error(`refund-repair is already running or its lock is unclear (.local/refund-repair.lock: ${e.message.replace(/^Worker /,'')}). Run exactly one: the --loop, or a one-off pass while the loop is stopped.`);process.exit(1);}
 process.once('exit',releaseLock);
 const loop=process.argv.includes('--loop'),attempts=new Map(),alarms=new Set();
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>process.exit(loop?0:1));  // through 'exit', so the lock is released
 const log=line=>console.log(`${new Date().toISOString()} ${line}`);
 const shown=(r,first)=>r&&(!loop||first||r.repaired.length||r.skipped.length||r.failed.length);
 for(let first=true;;first=false){
  const r=await repairStuckRefunds({log}).catch(e=>{log(`error: ${e.message}`);return null;});
  if(shown(r,first))log(`pass: ${r.checked} RefundAuthorized purchase(s), ${r.repaired.length} repaired, ${r.skipped.length} skipped, ${r.failed.length} failed`);
  const w=await repairStuckWithdrawals({log,attempts}).catch(e=>{log(`error: ${e.message}`);return null;});
  if(shown(w,first))log(`pass: ${w.checked} WithdrawAuthorized payment(s), ${w.repaired.length} repaired, ${w.skipped.length} skipped, ${w.failed.length} failed`);
  const h=await repairHeldRefunds({log,attempts,alarms}).catch(e=>{log(`error: ${e.message}`);return null;});
  if(shown(h,first))log(`pass: ${h.checked} Disputed payment(s) checked for a refund RechnungsMeister decided, ${h.repaired.length} repaired, ${h.skipped.length} skipped, ${h.failed.length} failed`);
  if(!loop)process.exit(r&&!r.failed.length&&w&&!w.failed.length&&h&&!h.failed.length?0:1);
  await new Promise(resolve=>setTimeout(resolve,LOOP_MS));
 }
}
