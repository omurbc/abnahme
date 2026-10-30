// Thin buyer-side client for the local Masumi Payment Service (0.29.0, Web3CardanoV2, Preprod).
// Writes use the Büro purchasing runtime key (MPS_BUYER_TOKEN, .local/buero-buyer-runtime.env).
// Reads fall back to a read-only key without wallet scope (MPS_READ_TOKEN, .local/buero-read-runtime.env, mps/read-key.mjs):
// MPS binds the purchasing wallet to a purchase only at funds lock, so the wallet-scoped key gets 404 before
// FundsLocked. The buyer never holds ADMIN_KEY, which would bypass every wallet scope. Request shapes follow the MPS e2e
// helpers (tests/e2e/helperFunctions.ts @0.29.0: createPurchase, requestRefund, cancelRefundRequest).
const NETWORK='Preprod';
const BLOCKFROST='https://cardano-preprod.blockfrost.io/api/v0';

export class MpsError extends Error{constructor(path,status,detail){super(`MPS ${path} HTTP ${status}: ${detail}`);this.status=status;}}

export function createEscrow({url=process.env.MPS_URL,buyerToken=process.env.MPS_BUYER_TOKEN,readToken=process.env.MPS_READ_TOKEN,blockfrostKey=process.env.BLOCKFROST_API_KEY_PREPROD,fetchImpl=fetch}={}){
 async function call(path,body,token){
  if(!token)throw new Error(`No MPS key for ${path}`);
  const response=await fetchImpl(`${url}/api/v1${path}`,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(30000),headers:{token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||data.status!=='success')throw new MpsError(path,response.status,JSON.stringify(data.error??data.message??''));
  return data.data;
 }
 const resolve=(path,blockchainIdentifier,token)=>call(path,{network:NETWORK,blockchainIdentifier,includeHistory:'true'},token);
 // null when MPS does not know the purchase (yet).
 async function getPurchase(blockchainIdentifier){
  try{return await resolve('/purchase/resolve-blockchain-identifier',blockchainIdentifier,buyerToken);}
  catch(e){if(e.status!==404&&e.status!==403||!readToken)throw e;}
  try{return await resolve('/purchase/resolve-blockchain-identifier',blockchainIdentifier,readToken);}
  catch(e){if(e.status===404)return null;throw e;}
 }
 return {
  // MPS 0.29.0 answers a second POST /purchase for the same blockchainIdentifier with 409 (Purchase exists): read that one.
  async purchase(job,{inputHash,nonce,metadata}){
   try{
    return await call('/purchase',{blockchainIdentifier:job.blockchainIdentifier,network:NETWORK,paymentSourceType:'Web3CardanoV2',smartContractAddress:job.smartContractAddress,
     supportedPaymentSourceIndex:job.supportedPaymentSourceIndex,inputHash,sellerVkey:job.sellerVKey,agentIdentifier:job.agentIdentifier,Amounts:job.amounts,
     unlockTime:String(job.unlockTime),externalDisputeUnlockTime:String(job.externalDisputeUnlockTime),submitResultTime:String(job.submitResultTime),payByTime:String(job.payByTime),
     identifierFromPurchaser:nonce,metadata},buyerToken);
   }catch(e){if(e.status!==409)throw e;const existing=await getPurchase(job.blockchainIdentifier);if(!existing)throw e;return existing;}
  },
  getPurchase,
  // Seller-side record on the same MPS, read with the read-only key for the transaction history only.
  async getPayment(blockchainIdentifier){
   if(!readToken)return null;
   try{return await resolve('/payment/resolve-blockchain-identifier',blockchainIdentifier,readToken);}catch(e){if(e.status===404)return null;throw e;}
  },
  requestRefund:blockchainIdentifier=>call('/purchase/request-refund',{blockchainIdentifier,network:NETWORK},buyerToken),
  // On V2 this queues AuthorizeWithdrawal (only from Disputed).
  cancelRefundRequest:blockchainIdentifier=>call('/purchase/cancel-refund-request',{blockchainIdentifier,network:NETWORK},buyerToken),
  // result_hash read from the escrow UTxO datum on chain (Blockfrost), independent of the MPS database. MPS batches up to
  // 7 escrows into one tx (payments/submit-result/service.ts:80), so it is the output whose datum input_hash (field 10)
  // is this purchase's. None or several such outputs throw: unknown, never a mismatch.
  async chainResultHash(txHash,contractAddress,{inputHash}={}){
   if(!blockfrostKey||!txHash)return null;
   const get=async path=>{const r=await fetchImpl(BLOCKFROST+path,{headers:{project_id:blockfrostKey},signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error(`Blockfrost ${path} ${r.status}`);return r.json();};
   const utxos=await get(`/txs/${txHash}/utxos`);
   const datums=await Promise.all(utxos.outputs.filter(o=>o.address===contractAddress&&o.data_hash).map(o=>get(`/scripts/datum/${o.data_hash}`)));
   const own=datums.filter(d=>!inputHash||decodeHash(d.json_value,10)===inputHash);
   if(own.length!==1)throw new Error(`Blockfrost ${txHash.slice(0,12)}…: ${own.length} Escrow-Ausgaben mit input_hash ${String(inputHash).slice(0,12)}…`);
   return decodeHash(own[0].json_value,11);
  },
 };
}

// V2 datum fields 10 and 11 are input_hash and result_hash (smart-contracts/payment-v2/README.md, Datum). They may hold
// the hex digest as raw bytes or as the UTF-8 bytes of the hex string; return the 64-char hex digest either way.
export const decodeResultHash=jsonValue=>decodeHash(jsonValue,11);
export function decodeHash(jsonValue,field){
 const bytes=jsonValue?.fields?.[field]?.bytes;
 if(typeof bytes!=='string'||!bytes)return null;
 if(bytes.length===64)return bytes.toLowerCase();
 const text=Buffer.from(bytes,'hex').toString('utf8');
 return /^[0-9a-f]{64}$/i.test(text)?text.toLowerCase():bytes;
}

// The template's confirmedState plus the "result changed" condition needed for a cure (Disputed -> Disputed).
export function confirmed(record,state){
 return (record?.CurrentTransaction?.status==='Confirmed'&&record.CurrentTransaction.newOnChainState===state)||record?.TransactionHistory?.some(tx=>tx.status==='Confirmed'&&tx.newOnChainState===state)||false;
}

const LABELS={
 'FundsLocked':'FundsLocked','FundsLocked>ResultSubmitted':'ResultSubmitted','ResultSubmitted>Disputed':'Disputed','FundsLocked>RefundRequested':'RefundRequested',
 'RefundRequested>Disputed':'ResultSubmitted (cure)','Disputed>Disputed':'ResultSubmitted (cure)','Disputed>WithdrawAuthorized':'AuthorizeWithdrawal',
 'WithdrawAuthorized>Withdrawn':'Withdrawn','ResultSubmitted>Withdrawn':'Withdrawn (deemed acceptance)','Disputed>RefundAuthorized':'AuthorizeRefund',
 'ResultSubmitted>RefundAuthorized':'AuthorizeRefund','RefundAuthorized>RefundWithdrawn':'RefundWithdrawn','RefundRequested>RefundWithdrawn':'RefundWithdrawn',
 'FundsLocked>RefundWithdrawn':'RefundWithdrawn','Disputed>DisputedWithdrawn':'DisputedWithdrawn',
};
export const explorerUrl=txHash=>`https://preprod.cardanoscan.io/transaction/${txHash}`;
// Labelled escrow txs from purchase and payment records, oldest first, deduplicated by hash.
export function escrowTxs(...records){
 const seen=new Map();
 for(const r of records.filter(Boolean))for(const tx of [...(r.TransactionHistory??[]),r.CurrentTransaction].filter(Boolean)){
  if(!tx.txHash||!tx.newOnChainState)continue;
  const key=tx.previousOnChainState?`${tx.previousOnChainState}>${tx.newOnChainState}`:tx.newOnChainState;
  const label=LABELS[key]??LABELS[tx.newOnChainState]??key;
  const prior=seen.get(tx.txHash);
  if(!prior||tx.status==='Confirmed')seen.set(tx.txHash,{label,txHash:tx.txHash,status:tx.status,at:tx.blockTime?new Date(Number(tx.blockTime)*1000).toISOString():tx.createdAt??null,explorerUrl:explorerUrl(tx.txHash)});
 }
 return [...seen.values()].sort((a,b)=>String(a.at).localeCompare(String(b.at)));
}
