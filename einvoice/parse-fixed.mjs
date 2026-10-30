// Deterministic parser for our own fixed-layout fixture format (demo fallback when EXTRACT_MODE=fixed).
// Format: first line "ABNAHME-FIXED/1", then "key: value" lines using the flat field names,
// one "line: quantity | unit | unitPrice | vatCategory | vatRate | description" per invoice line.
// Empty values and missing optional keys become null. Lines starting with # are comments.
export const FIXED_HEADER='ABNAHME-FIXED/1';
export const INVOICE_TYPES=['380','875'];
const TEXT=['invoiceNumber','invoiceDate','invoiceType','serviceDate','sellerName','sellerStreet','sellerPostcode','sellerCity','sellerCountry','sellerVatId','sellerIban','sellerContactName','sellerPhone','sellerEmail','buyerName','buyerStreet','buyerPostcode','buyerCity','buyerCountry','buyerVatId','buyerEmail','buyerReference','dueDate','paymentTerms'];
const NUMBERS=['netTotal','vatTotal','grossTotal'];
const REQUIRED=['invoiceNumber','invoiceDate','invoiceType','sellerName','sellerStreet','sellerPostcode','sellerCity','sellerCountry','buyerName','buyerStreet','buyerPostcode','buyerCity','buyerCountry','reverseCharge'];

const toNumber=(value,key)=>{
 const n=Number(value);
 if(value===''||!Number.isFinite(n))throw new Error(`${key}: not a number: ${JSON.stringify(value)}`);
 return n;
};

export function parseFixed(text){
 const rows=text.split(/\r?\n/).map(r=>r.trim()).filter(r=>r&&!r.startsWith('#'));
 if(rows[0]!==FIXED_HEADER)throw new Error(`Fixed-layout invoice must start with ${FIXED_HEADER}`);
 const fields=Object.fromEntries([...TEXT,...NUMBERS].map(k=>[k,null]));
 fields.lines=[];
 const seen=new Set();
 for(const row of rows.slice(1)){
  const i=row.indexOf(':');
  if(i<0)throw new Error(`Expected "key: value", got ${JSON.stringify(row)}`);
  const key=row.slice(0,i).trim(),value=row.slice(i+1).trim();
  if(key==='line'){
   const parts=value.split('|').map(p=>p.trim());
   if(parts.length!==6)throw new Error(`line needs 6 parts, got ${JSON.stringify(value)}`);
   const [quantity,unit,unitPrice,vatCategory,vatRate,description]=parts;
   fields.lines.push({description,quantity:toNumber(quantity,'quantity'),unit,unitPrice:toNumber(unitPrice,'unitPrice'),vatCategory,vatRate:toNumber(vatRate,'vatRate')});
   continue;
  }
  if(seen.has(key))throw new Error(`Duplicate key ${key}`);
  seen.add(key);
  if(TEXT.includes(key))fields[key]=value||null;
  else if(NUMBERS.includes(key))fields[key]=value?toNumber(value,key):null;
  else if(key==='reverseCharge'){
   if(!['true','false'].includes(value))throw new Error('reverseCharge must be true or false');
   fields.reverseCharge=value==='true';
  }
  else throw new Error(`Unknown key ${key}`);
 }
 const missing=REQUIRED.filter(k=>fields[k]==null);
 if(missing.length)throw new Error(`Missing required keys: ${missing.join(', ')}`);
 if(!INVOICE_TYPES.includes(fields.invoiceType))throw new Error(`invoiceType must be ${INVOICE_TYPES.join(' or ')}, got ${JSON.stringify(fields.invoiceType)}`);
 if(!fields.lines.length)throw new Error('At least one line is required');
 return fields;
}
