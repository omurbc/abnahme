import {readFileSync,readdirSync} from 'node:fs';
import {sha256} from '../standard-hash.mjs';

const DIR=new URL('./profiles/',import.meta.url);
const readJson=url=>parseJson(readFileSync(url,'utf8'));

// JSON.parse keeps the last of duplicate keys silently; RFC 8785 §3.1 forbids them. Scan the (valid) text for them.
export function parseJson(text){
 const value=JSON.parse(text),stack=[];
 let last=null;
 for(const [t] of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]:]/g)){
  if(t==='{')stack.push(new Set());
  else if(t==='[')stack.push(null);
  else if(t==='}'||t===']')stack.pop();
  else if(t===':'){
   const key=JSON.parse(last),keys=stack.at(-1);
   if(keys.has(key))throw new Error(`JSON: duplicate key ${JSON.stringify(key)}`);
   keys.add(key);
  }
  last=t;
 }
 return value;
}

// RFC 8785 (JCS) for plain JSON data: object keys sorted by UTF-16 code units, no whitespace,
// numbers and strings serialized as ECMAScript JSON.stringify does (which is what JCS specifies).
// Lone surrogates are an error (RFC 8785 §3.2.2.2), not escaped.
const string=s=>{if(!s.isWellFormed())throw new Error('JCS: lone surrogate in string');return JSON.stringify(s);};
export function canonicalJson(value){
 if(value===null||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='string')return string(value);
 if(typeof value==='number'){
  if(!Number.isFinite(value))throw new Error('JCS: non-finite number');
  return JSON.stringify(value);
 }
 if(Array.isArray(value))return `[${value.map(canonicalJson).join(',')}]`;
 if(typeof value==='object')return `{${Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>`${string(k)}:${canonicalJson(value[k])}`).join(',')}}`;
 throw new Error(`JCS: unsupported type ${typeof value}`);
}

export const loadAcceptance=()=>readJson(new URL('acceptance-v1.json',DIR));
export const recipientIds=()=>readdirSync(new URL('empfaenger/',DIR)).filter(f=>f.endsWith('.json')).map(f=>f.slice(0,-5)).sort();
export function loadRecipient(id){
 if(!recipientIds().includes(id))throw new Error(`Unknown Empfängerprofil ${JSON.stringify(id)}; known: ${recipientIds().join(', ')}`);
 return readJson(new URL(`empfaenger/${id}.json`,DIR));
}
// profileHash commits to the acceptance profile AND the recipient profile of one job.
export const profileHash=(acceptance,recipient)=>sha256(canonicalJson({acceptance,recipient}));
export function loadProfile(recipientId){
 const acceptance=loadAcceptance(),recipient=loadRecipient(recipientId);
 return {acceptance,recipient,profileHash:profileHash(acceptance,recipient)};
}
