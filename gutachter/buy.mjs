// Buyer: pays the Gutachter 1 tADA over x402 (Cardano preprod) for one KoSIT inspection.
// node buy.mjs <file.xml>   prints the verdict and the settlement tx, appends to payments.log.json.
// It sends ONE signed payment. While the answer says that payment may still settle, it resends the same signed header
// (backoff, up to 3 min); it never signs a second payment once one was sent. The tx hash is logged before the first paid send.
// It pays only GUTACHTER_SELLER_ADDRESS, and one call at a time per process (one buyer wallet).
import {randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync,realpathSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {x402Client,x402HTTPClient} from '@x402/fetch';
import {toClientCardanoSigner,decodeCardanoTransaction} from '@x402/cardano';
import {ExactCardanoScheme} from '@x402/cardano/exact/client';

const NETWORK='cardano:preprod';
const BLOCKFROST='https://cardano-preprod.blockfrost.io/api/v0';
// lovelace is not USD-pegged, so the default spend controls reject it: allow it, capped at the 1 tADA price, so an
// inflated offer is refused. Across runs, at most MAX_PAYMENTS_PER_DAY charged payments per rolling 24 h (payments.log.json).
export const SPEND_CONTROLS={allowedAssets:[{network:'cardano:*',asset:'lovelace',maxAmountPerPayment:'1000000'}]};
const cap=process.env.GUTACHTER_MAX_PAYMENTS_PER_DAY||'20';
if(!/^\d+$/.test(cap)) throw new Error(`GUTACHTER_MAX_PAYMENTS_PER_DAY must be a whole number of payments, got ${JSON.stringify(cap)}: refusing to pay without a daily budget`);
const MAX_PAYMENTS_PER_DAY=Number(cap);
const RETRY_DELAY_MS=5000,RESEND_BUDGET_MS=180_000,MAX_DELAY_MS=30_000,OFFER_TIMEOUT_MS=30_000,CONFIRM_WAIT_MS=90_000,CONFIRM_POLL_MS=5000,SPENT_WINDOW_MS=15*60_000;
// KoSIT reports for our invoices are about 30 KiB; whoever answers on the port could otherwise send any amount.
const MAX_ANSWER_BYTES=32*1024*1024;
const LOG=fileURLToPath(new URL('./payments.log.json',import.meta.url));
// 127.0.0.1, not localhost: Node tries ::1 first, and any local process can bind [::1]:4021 next to the seller.
const sellerUrl=process.env.GUTACHTER_URL??`http://127.0.0.1:${process.env.GUTACHTER_PORT??4021}`;
const PAY_TO=process.env.GUTACHTER_SELLER_ADDRESS;

function buyer(){
 const mnemonic=process.env.GUTACHTER_BUYER_MNEMONIC,projectId=process.env.BLOCKFROST_API_KEY_PREPROD;
 if(!mnemonic||!projectId) throw new Error('Set GUTACHTER_BUYER_MNEMONIC (npm run wallet) and BLOCKFROST_API_KEY_PREPROD in .env');
 const client=new x402Client().setSpendControls(SPEND_CONTROLS);
 const signer=toClientCardanoSigner({mnemonic,network:NETWORK,provider:{blockfrost:{baseUrl:BLOCKFROST,projectId}}});
 client.register('cardano:*',new ExactCardanoScheme(signer));
 // 'unspent' only for an output in a block that no tx has spent; Blockfrost does not know a tx still in the mempool.
 const inputState=async ref=>{
  const [hash,index]=ref.split('#');
  const r=await fetch(`${BLOCKFROST}/txs/${hash}/utxos`,{headers:{project_id:projectId},signal:AbortSignal.timeout(20_000)});
  if(r.status===404) return 'unconfirmed';
  if(!r.ok) throw new Error(`Blockfrost /txs/${hash.slice(0,12)}…/utxos HTTP ${r.status}`);
  const o=(await r.json()).outputs.find(o=>o.output_index===Number(index)&&!o.collateral);
  return o?.consumed_by_tx===null?'unspent':o?.consumed_by_tx?'spent':'unknown';
 };
 // true once the tx is in a block with outputs of at least `amount` lovelace to `payTo`; false while Blockfrost does not list it.
 const paysOnChain=async(txHash,payTo,amount)=>{
  const r=await fetch(`${BLOCKFROST}/txs/${txHash}/utxos`,{headers:{project_id:projectId},signal:AbortSignal.timeout(20_000)});
  if(r.status===404) return false;
  if(!r.ok) throw new Error(`Blockfrost /txs/${txHash.slice(0,12)}…/utxos HTTP ${r.status}`);
  const paid=(await r.json()).outputs.filter(o=>o.address===payTo&&!o.collateral).flatMap(o=>o.amount).filter(a=>a.unit==='lovelace').reduce((sum,a)=>sum+BigInt(a.quantity),0n);
  return paid>=BigInt(amount);
 };
 return {client,address:signer.getAddress(),inputState,paysOnChain};
}

// The answer as JSON, read up to maxBytes; larger, or not JSON: null.
async function readJson(res,maxBytes){
 const chunks=[];let size=0;
 try{
  for await (const chunk of res.body??[]){ size+=chunk.length; if(size>maxBytes) return null; chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
 }catch{ return null; }
}

const readLog=logPath=>existsSync(logPath)?JSON.parse(readFileSync(logPath,'utf8')):[];
// One entry per call (id), not per tx: two calls can sign the same tx when the first one was not charged.
function writeLog(logPath,id,fields){
 const log=readLog(logPath);
 const entry=log.findLast(e=>e.id===id);
 if(entry) Object.assign(entry,fields); else log.push({time:new Date().toISOString(),id,...fields});
 writeFileSync(logPath,JSON.stringify(log,null,1)+'\n');
}

// True while the same signed payment may still settle: the facilitator is still confirming (settlement_pending,
// duplicate_settlement), the seller lost the facilitator's answer (receipt without tx, e.g. a 504 on /settle),
// a settled receipt came with a failed response, or the connection or a gateway failed.
// The Gutachter's own "no inspection" answers say charged:false: the middleware never settles a status >= 400, and a
// payment the Gutachter already charged is answered from its ledger, never with that marker. So such an answer is final.
const notCharged=({status,receipt,result})=>!receipt&&status>=400&&result?.charged===false;
function mayStillSettle(last){
 const {status,receipt,error}=last;
 if(error) return true;
 if(receipt?.success) return status!==200;
 if(receipt) return !receipt.transaction||['settlement_pending','duplicate_settlement'].includes(receipt.errorReason)||(receipt.errorReason==='exact_cardano_settlement_failed'&&receipt.extra?.status!=='expired');
 return (status===502||status===504)&&!notCharged(last);
}

// A success receipt is the answering party's statement (anyone holding the port can write one). The payment counts only
// once the chain shows the signed tx paying the Gutachter, within a bounded wait (DELTA-X402-4).
async function seenOnChain(paysOnChain,txHash,payTo,amount,{confirmWaitMs,confirmPollMs}){
 const deadline=Date.now()+confirmWaitMs;
 for(;;){
  if(await paysOnChain(txHash,payTo,amount).catch(()=>false)) return true;
  if(Date.now()+confirmPollMs>deadline) return false;
  await new Promise(r=>setTimeout(r,confirmPollMs));
 }
}

// Returns {httpStatus, payer, txHash, verdict, receipt, result}. txHash is null only when nothing was charged. A success
// receipt the chain does not confirm comes back as receipt null plus `unconfirmed` (the reason).
// Calls run one after the other: a concurrent call would count the budget before this call's entry exists, and could
// spend the same UTxO into the same tx before this payment's change output is visible.
let queue=Promise.resolve();
export function buyInspection(xml,options){
 const call=queue.then(()=>buyOnce(xml,options));
 queue=call.catch(()=>{});
 return call;
}

// The wallet view (Blockfrost) can lag the previous payment by a block: a tx built on its spent inputs, or on its change
// before that is in a block, gets HTTP 402 at /verify (LANE-A-3). So a tx is sent only when every input is an unspent
// output in a block; otherwise the unsent tx is dropped and built again, for at most confirmWaitMs. Nothing was sent, so
// nothing can be paid twice.
// Blockfrost can also still list an input as unspent 20 s after the block that spent it (LANE-A2-1), and the client
// cannot exclude UTxOs from its selection. So the inputs of our own payments sent in the last 15 min (kept in the
// payment log, so across processes and restarts) count as spent whatever Blockfrost says. A not-charged payment was
// never settled; its inputs are free.
const recentInputs=logPath=>new Set(readLog(logPath).filter(e=>e.status!=='not-charged'&&Date.now()-Date.parse(e.time)<SPENT_WINDOW_MS).flatMap(e=>e.inputs??[]));
async function signOnConfirmedInputs(client,required,{inputState,confirmWaitMs,confirmPollMs,logPath}){
 const deadline=Date.now()+confirmWaitMs;
 for(;;){
  const payload=await client.createPaymentPayload(required);
  const {txHash,inputs}=decodeCardanoTransaction(String(payload.payload.transaction));
  const spent=recentInputs(logPath);
  const states=await Promise.all(inputs.map(ref=>spent.has(ref)?'spent by an earlier payment':inputState?.(ref)??'unspent'));
  if(states.every(s=>s==='unspent')) return {payload,txHash,inputs};
  if(Date.now()+confirmPollMs>deadline) throw new Error(`x402 payment not sent: the wallet's inputs are not confirmed after ${confirmWaitMs/1000} s (${inputs.map((ref,i)=>`${ref.slice(0,12)}…#${ref.split('#')[1]} ${states[i]}`).join(', ')})`);
  await new Promise(r=>setTimeout(r,confirmPollMs));
 }
}

async function buyOnce(xml,{client,inputState,paysOnChain,logPath=LOG,retryDelayMs=RETRY_DELAY_MS,budgetMs=RESEND_BUDGET_MS,offerTimeoutMs=OFFER_TIMEOUT_MS,confirmWaitMs=CONFIRM_WAIT_MS,confirmPollMs=CONFIRM_POLL_MS,maxAnswerBytes=MAX_ANSWER_BYTES}={}){
 let address=null;
 if(!client) ({client,address,inputState,paysOnChain}=buyer());
 const http=new x402HTTPClient(client);
 const url=`${sellerUrl}/inspect`,init={method:'POST',headers:{'content-type':'application/xml'},body:xml};
 const offer=await fetch(url,{...init,signal:AbortSignal.timeout(offerTimeoutMs)}); // bounded: later calls wait for this one
 if(offer.ok) throw new Error(`The Gutachter answered HTTP ${offer.status} without asking for payment: that is no inspection`);
 if(offer.status!==402) return {httpStatus:offer.status,payer:address,txHash:null,verdict:null,result:await readJson(offer,maxAnswerBytes)};
 if(!PAY_TO) throw new Error('Set GUTACHTER_SELLER_ADDRESS: the buyer pays only the Gutachter\'s own address');
 const required=http.getPaymentRequiredResponse(name=>offer.headers.get(name),(await readJson(offer,maxAnswerBytes))??undefined);
 const accepts=required.accepts.filter(a=>a.payTo===PAY_TO);
 if(!accepts.length) throw new Error(`The offer pays ${[...new Set(required.accepts.map(a=>a.payTo))].join(', ')}, not GUTACHTER_SELLER_ADDRESS: nothing signed`);
 const charged=readLog(logPath).filter(e=>e.status!=='not-charged'&&Date.now()-Date.parse(e.time)<86_400_000).length; // sent and unknown may have been paid
 if(charged>=MAX_PAYMENTS_PER_DAY) throw new Error(`x402 budget reached: ${charged} payments in the last 24 h (max ${MAX_PAYMENTS_PER_DAY}, GUTACHTER_MAX_PAYMENTS_PER_DAY), see the Gutachter payment log`);
 const {payload,txHash,inputs}=await signOnConfirmedInputs(client,{...required,accepts},{inputState,confirmWaitMs,confirmPollMs,logPath});
 const headers={...init.headers,...http.encodePaymentSignatureHeader(payload)};
 const id=randomBytes(6).toString('hex');
 writeLog(logPath,id,{txHash,inputs,verdict:null,status:'sent'});
 const deadline=Date.now()+budgetMs;
 let last,sends=0,delay=retryDelayMs;
 for(;;){
  sends++;
  try{
   const res=await fetch(url,{...init,headers,signal:AbortSignal.timeout(240_000)});
   let receipt; try{ receipt=http.getPaymentSettleResponse(name=>res.headers.get(name)); }catch{}
   last={status:res.status,receipt,result:await readJson(res,maxAnswerBytes)};
  }catch(error){ last={status:null,error}; }
  if(!mayStillSettle(last)||Date.now()+delay>deadline) break;
  await new Promise(r=>setTimeout(r,delay));
  delay=Math.min(delay*1.5,MAX_DELAY_MS);
 }
 const {status,receipt,result,error}=last;
 let outcome=status===200&&receipt?.success?'settled':notCharged(last)?'not-charged':mayStillSettle(last)||sends>1?'unknown':'not-charged'; // after a resend only cardanoscan can say
 let unconfirmed=null;
 if(outcome==='settled'&&paysOnChain){
  if(receipt.transaction!==txHash) unconfirmed=`the receipt names tx ${String(receipt.transaction).slice(0,12)}…, not the signed tx ${txHash.slice(0,12)}…`;
  else if(!await seenOnChain(paysOnChain,txHash,PAY_TO,payload.accepted.amount,{confirmWaitMs,confirmPollMs})) unconfirmed=`tx ${txHash.slice(0,12)}… is not on chain with ${payload.accepted.amount} lovelace to the Gutachter after ${confirmWaitMs/1000} s`;
  if(unconfirmed) outcome='unconfirmed'; // may still have been paid: it counts for the budget and its inputs stay blocked
 }
 const verdict=outcome==='settled'?result?.verdict??null:null;
 writeLog(logPath,id,{verdict,status:outcome,...outcome==='settled'?{}:{httpStatus:status,sends,error:unconfirmed??receipt?.errorReason??result?.error??error?.message??null}});
 // Not counted, but the tx is kept: receipt null means no receipt the chain confirms, so a caller does not use the answer.
 if(unconfirmed) return {httpStatus:status,payer:address,txHash,verdict:null,receipt:null,result,unconfirmed:`x402 payment not confirmed: ${unconfirmed}`};
 return {httpStatus:status,payer:address,txHash:outcome==='not-charged'?null:txHash,verdict,receipt,result};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){ // import.meta.main needs Node 24.2
 const file=process.argv[2];
 if(!file) { console.error('usage: node buy.mjs <file.xml>'); process.exit(2); }
 const started=Date.now();
 console.log(`POST ${sellerUrl}/inspect with ${file} (pays 1 tADA on 402, expect 20-60 s)`);
 const r=await buyInspection(readFileSync(file,'utf8')).catch(e=>{ console.error(`FAILED: ${e.message}`); process.exit(1); });
 console.log(`payer ${r.payer}`);
 console.log(`HTTP ${r.httpStatus} after ${((Date.now()-started)/1000).toFixed(1)} s`);
 if(r.txHash) console.log(`tx ${r.txHash}\nhttps://preprod.cardanoscan.io/transaction/${r.txHash}`);
 if(r.unconfirmed){ console.error(`FAILED: ${r.unconfirmed}; the answer is not used. Check the tx on preprod.cardanoscan.io before paying again.`); process.exit(1); }
 if(r.httpStatus!==200){
  console.error(`FAILED: ${JSON.stringify(r.result)} receipt=${JSON.stringify(r.receipt??null)}`);
  if(r.txHash) console.error('The payment may still settle: check the tx on preprod.cardanoscan.io before paying again.');
  process.exit(1);
 }
 console.log(`verdict ${r.verdict} (KoSIT HTTP ${r.result.httpStatus})`);
}
