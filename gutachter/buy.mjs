// Buyer: pays the Gutachter 1 tADA over x402 (Cardano preprod) for one KoSIT inspection.
// node buy.mjs <file.xml>   prints the verdict and the settlement tx, appends to payments.log.json.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {x402Client,wrapFetchWithPayment,x402HTTPClient} from '@x402/fetch';
import {toClientCardanoSigner} from '@x402/cardano';
import {ExactCardanoScheme} from '@x402/cardano/exact/client';

const NETWORK='cardano:preprod';
const BLOCKFROST='https://cardano-preprod.blockfrost.io/api/v0';
const MAX_LOVELACE_PER_PAYMENT='1500000';
const logPath=fileURLToPath(new URL('./payments.log.json',import.meta.url));
const sellerUrl=process.env.GUTACHTER_URL??`http://localhost:${process.env.GUTACHTER_PORT??4021}`;

function buyer(){
 const mnemonic=process.env.GUTACHTER_BUYER_MNEMONIC,projectId=process.env.BLOCKFROST_API_KEY_PREPROD;
 if(!mnemonic||!projectId) throw new Error('Set GUTACHTER_BUYER_MNEMONIC (npm run wallet) and BLOCKFROST_API_KEY_PREPROD in .env');
 // lovelace is not USD-pegged, so the default spend controls reject it: allow it, capped at 1.5 tADA per payment.
 const client=new x402Client().setSpendControls({allowedAssets:[{network:'cardano:*',asset:'lovelace',maxAmountPerPayment:MAX_LOVELACE_PER_PAYMENT}]});
 const signer=toClientCardanoSigner({mnemonic,network:NETWORK,provider:{blockfrost:{baseUrl:BLOCKFROST,projectId}}});
 client.register('cardano:*',new ExactCardanoScheme(signer));
 return {client,address:signer.getAddress()};
}

function appendLog(entry){
 const log=existsSync(logPath)?JSON.parse(readFileSync(logPath,'utf8')):[];
 log.push(entry);
 writeFileSync(logPath,JSON.stringify(log,null,1)+'\n');
}

// Returns {httpStatus, txHash, verdict, result}. Throws only if no payment could be attempted.
export async function buyInspection(xml){
 const {client,address}=buyer();
 const res=await wrapFetchWithPayment(fetch,client)(`${sellerUrl}/inspect`,{method:'POST',headers:{'content-type':'application/xml'},body:xml});
 let receipt;
 try{ receipt=new x402HTTPClient(client).getPaymentSettleResponse(name=>res.headers.get(name)); }catch{}
 const result=await res.json().catch(()=>null);
 const txHash=receipt?.transaction||null;
 const verdict=res.ok?result?.verdict??null:null;
 if(txHash) appendLog({time:new Date().toISOString(),txHash,verdict,...(res.ok?{}:{httpStatus:res.status,error:receipt?.errorReason??result?.error??null})});
 return {httpStatus:res.status,payer:address,txHash,verdict,receipt,result};
}

if(import.meta.main){
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
  console.error('A 402 after about a minute can mean settlement_pending: check the payer on preprod.cardanoscan.io before retrying, or it pays twice.');
  process.exit(1);
 }
 console.log(`verdict ${r.verdict} (KoSIT HTTP ${r.result.httpStatus})`);
}
