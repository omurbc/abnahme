// Cure planning for a dispute. A cure may only fill a value that appears verbatim in the job's input_data
// (substring of a string field, e.g. the invoice text) or equals a string value of the pinned recipient
// profile (Empfängerprofil). Anything else is rejected: the seller cannot invent a value to get paid. Provenance alone
// does not make a value right (the invoice text may print a wrong one): the cure is only submitted after the rebuilt
// invoice passes KoSIT and the semantic checks again (server.mjs produceAttempt selfCheck). Keep both guards.

// Failure code -> invoice field the cure may set.
export const CURABLE={
 'BR-AE-02':'buyerVatId','ABN-BT48':'buyerVatId',
 'BR-DE-15':'buyerReference','ABN-BT10':'buyerReference',
};
// The delivered bytes did not match the on-chain hash or the manifest: the cure is a clean retransmission.
export const RETRANSMIT=new Set(['ABN-HASH','ABN-MANIFEST','ABN-LIEFERUNG']);
const MIN_LENGTH=4;

const leaves=(value,path)=>{
 if(typeof value==='string')return [[path,value]];
 if(Array.isArray(value))return value.flatMap((v,i)=>leaves(v,`${path}[${i}]`));
 if(value&&typeof value==='object')return Object.entries(value).flatMap(([k,v])=>leaves(v,`${path}.${k}`));
 return [];
};

// Returns where the value comes from ('input_data.invoiceText', 'recipient.vatId', ...) or null.
export function provenance(value,{inputData,recipient}){
 if(typeof value!=='string'||value.trim().length<MIN_LENGTH)return null;
 const fromInput=leaves(inputData,'input_data').find(([,text])=>text.includes(value));
 if(fromInput)return fromInput[0];
 const fromRecipient=leaves(recipient,'recipient').find(([,text])=>text===value);
 return fromRecipient?fromRecipient[0]:null;
}

function candidates(field,{fields0,inputData,recipient}){
 if(field==='buyerVatId')return [fields0?.buyerVatId,recipient.vatId];
 if(field==='buyerReference'){
  const pattern=recipient.buyerReferencePattern;
  const inText=pattern?[...String(inputData.invoiceText??'').matchAll(new RegExp(pattern.replace(/^\^/,'').replace(/\$$/,''),'g'))].map(m=>m[0]):[];
  return [fields0?.buyerReference,...inText].filter(v=>!pattern||new RegExp(pattern).test(v??''));
 }
 return [];
}

// failures: [{code,textDe}] from the buyer. current: fields of the rejected attempt. fields0: original extraction.
// -> {ok:true, patch, sources, retransmit} | {ok:false, reasons}
export function planCure({failures,current,fields0,inputData,recipient}){
 const reasons=[],patch={},sources={};let retransmit=false;
 if(!Array.isArray(failures)||!failures.length)return {ok:false,reasons:['Die Mängelrüge nennt keine Mängel.']};
 for(const field of new Set(failures.map(f=>CURABLE[f.code]).filter(Boolean))){
  const pick=candidates(field,{fields0,inputData,recipient}).find(v=>v!=null&&v!==current?.[field]&&provenance(v,{inputData,recipient}));
  if(pick==null){reasons.push(`Für ${field} gibt es keinen Wert, der wörtlich in den Auftragsdaten oder im Empfängerprofil steht.`);continue;}
  patch[field]=pick;sources[field]=provenance(pick,{inputData,recipient});
 }
 for(const f of failures){
  if(CURABLE[f.code])continue;
  if(RETRANSMIT.has(f.code)){retransmit=true;continue;}
  reasons.push(`Mangel ${f.code} ist nicht heilbar.`);
 }
 return reasons.length?{ok:false,reasons}:{ok:true,patch,sources,retransmit};
}
