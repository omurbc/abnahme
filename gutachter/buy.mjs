// Buyer: pays the Gutachter 1 tADA over x402 (Cardano preprod) for one KoSIT inspection.
// node buy.mjs <file.xml>   prints the verdict and the settlement tx, appends to payments.log.json.
// It signs ONE payment. While the answer says that payment may still settle, it resends the same signed header
// (backoff, up to 3 min); it never signs a second payment. The tx hash is logged before the first paid send.
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
const MAX_PAYMENTS_PER_DAY=Number(process.env.GUTACHTER_MAX_PAYMENTS_PER_DAY||20);
const RETRY_DELAY_MS=5000,RESEND_BUDGET_MS=180_000,MAX_DELAY_MS=30_000;
const LOG=fileURLToPath(new URL('./payments.log.json',import.meta.url));
const sellerUrl=process.env.GUTACHTER_URL??`http://localhost:${process.env.GUTACHTER_PORT??4021}`;

function buyer(){
 const mnemonic=process.env.GUTACHTER_BUYER_MNEMONIC,projectId=process.env.BLOCKFROST_API_KEY_PREPROD;
 if(!mnemonic||!projectId) throw new Error('Set GUTACHTER_BUYER_MNEMONIC (npm run wallet) and BLOCKFROST_API_KEY_PREPROD in .env');
 const client=new x402Client().setSpendControls(SPEND_CONTROLS);
 const signer=toClientCardanoSigner({mnemonic,network:NETWORK,provider:{blockfrost:{baseUrl:BLOCKFROST,projectId}}});
 client.register('cardano:*',new ExactCardanoScheme(signer));
 return {client,address:signer.getAddress()};
}

const readLog=logPath=>existsSync(logPath)?JSON.parse(readFileSync(logPath,'utf8')):[];
function writeLog(logPath,txHash,fields){
 const log=readLog(logPath);
 const entry=log.findLast(e=>e.txHash===txHash);
 if(entry) Object.assign(entry,fields); else log.push({time:new Date().toISOString(),txHash,...fields});
 writeFileSync(logPath,JSON.stringify(log,null,1)+'\n');
}

// True while the same signed payment may still settle: the facilitator is still confirming (settlement_pending,
// duplicate_settlement), the seller lost the facilitator's answer (receipt without tx, e.g. a 504 on /settle),
// a settled receipt came with a failed response, or the connection or a gateway failed.
function mayStillSettle({status,receipt,error}){
 if(error) return true;
 if(receipt?.success) return status!==200;
 if(receipt) return !receipt.transaction||['settlement_pending','duplicate_settlement'].includes(receipt.errorReason)||(receipt.errorReason==='exact_cardano_settlement_failed'&&receipt.extra?.status!=='expired');
 return status===502||status===504;
}

// Returns {httpStatus, payer, txHash, verdict, receipt, result}. txHash is null only when nothing was charged.
export async function buyInspection(xml,{client,logPath=LOG,retryDelayMs=RETRY_DELAY_MS,budgetMs=RESEND_BUDGET_MS}={}){
 let address=null;
 if(!client) ({client,address}=buyer());
 const http=new x402HTTPClient(client);
 const url=`${sellerUrl}/inspect`,init={method:'POST',headers:{'content-type':'application/xml'},body:xml};
 const offer=await fetch(url,init);
 if(offer.status!==402) return {httpStatus:offer.status,payer:address,txHash:null,verdict:null,result:await offer.json().catch(()=>null)};
 const charged=readLog(logPath).filter(e=>e.status!=='not-charged'&&Date.now()-Date.parse(e.time)<86_400_000).length; // sent and unknown may have been paid
 if(charged>=MAX_PAYMENTS_PER_DAY) throw new Error(`x402 budget reached: ${charged} payments in the last 24 h (max ${MAX_PAYMENTS_PER_DAY}, GUTACHTER_MAX_PAYMENTS_PER_DAY), see ${logPath}`);
 const payload=await client.createPaymentPayload(http.getPaymentRequiredResponse(name=>offer.headers.get(name),await offer.json().catch(()=>undefined)));
 const txHash=decodeCardanoTransaction(String(payload.payload.transaction)).txHash;
 const headers={...init.headers,...http.encodePaymentSignatureHeader(payload)};
 writeLog(logPath,txHash,{verdict:null,status:'sent'});
 const deadline=Date.now()+budgetMs;
 let last,sends=0,delay=retryDelayMs;
 for(;;){
  sends++;
  try{
   const res=await fetch(url,{...init,headers,signal:AbortSignal.timeout(240_000)});
   let receipt; try{ receipt=http.getPaymentSettleResponse(name=>res.headers.get(name)); }catch{}
   last={status:res.status,receipt,result:await res.json().catch(()=>null)};
  }catch(error){ last={status:null,error}; }
  if(!mayStillSettle(last)||Date.now()+delay>deadline) break;
  await new Promise(r=>setTimeout(r,delay));
  delay=Math.min(delay*1.5,MAX_DELAY_MS);
 }
 const {status,receipt,result,error}=last;
 const outcome=status===200&&receipt?.success?'settled':mayStillSettle(last)||sends>1?'unknown':'not-charged'; // after a resend only cardanoscan can say
 const verdict=outcome==='settled'?result?.verdict??null:null;
 writeLog(logPath,txHash,{verdict,status:outcome,...outcome==='settled'?{}:{httpStatus:status,sends,error:receipt?.errorReason??result?.error??error?.message??null}});
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
 if(r.httpStatus!==200){
  console.error(`FAILED: ${JSON.stringify(r.result)} receipt=${JSON.stringify(r.receipt??null)}`);
  if(r.txHash) console.error('The payment may still settle: check the tx on preprod.cardanoscan.io before paying again.');
  process.exit(1);
 }
 console.log(`verdict ${r.verdict} (KoSIT HTTP ${r.result.httpStatus})`);
}
