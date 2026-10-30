// Persistent replay ledger: one inspection per payment, keyed by the payment's tx hash (the nonce may name any of its inputs).
// First use binds tx -> sha256(body) -> answer. Same tx + same body: the stored answer, KoSIT is not called again.
// Same tx + other body: 409. The settle receipt is stored too, so a resend of a settled payment is not settled again;
// without a receipt yet, a resend asks the facilitator to settle the stored payment (it resumes, never re-broadcasts).
import {readFileSync,writeFileSync,renameSync,mkdirSync,existsSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';

export const sha256=text=>createHash('sha256').update(text).digest('hex');

export function openLedger(path){
 const entries=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
 const busy=new Set();
 const save=()=>{ mkdirSync(dirname(path),{recursive:true}); writeFileSync(path+'.tmp',JSON.stringify(entries,null,1),{mode:0o600}); renameSync(path+'.tmp',path); };
 return {
  async inspectOnce(tx,bodySha256,run){
   const hit=entries[tx];
   if(hit) return hit.bodySha256===bodySha256?{...hit.answer,cached:true}:{status:409,body:{error:'This payment was already used for a different invoice'}};
   if(busy.has(tx)) return {status:409,body:{error:'This payment is being used by another request'}};
   busy.add(tx);
   try{
    const answer=await run();
    if(answer.status===200){ entries[tx]={time:new Date().toISOString(),bodySha256,answer}; save(); }
    return answer;
   }finally{ busy.delete(tx); }
  },
  knows:tx=>!!entries[tx],
  async resend(tx,bodySha256,settle){
   const entry=entries[tx];
   if(entry.bodySha256!==bodySha256) return {status:409,body:{error:'This payment was already used for a different invoice'}};
   if(!entry.receipt){
    const receipt=await settle(entry.payment);
    if(!receipt.success) return {status:402,body:{},receipt};
    entry.receipt=receipt; save();
   }
   return {...entry.answer,receipt:entry.receipt,cached:true};
  },
  remember(tx,payment){ if(entries[tx]&&!entries[tx].receipt){ entries[tx].payment=payment; save(); } },
  settled(tx,receipt){ if(entries[tx]&&receipt?.success){ entries[tx].receipt=receipt; save(); } },
 };
}
