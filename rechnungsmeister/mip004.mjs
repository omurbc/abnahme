// MIP-004 hashes and the RechnungsMeister result format, shared by seller (rechnungsmeister/server.mjs)
// and buyer (buero/abnahme.mjs).
// input hash  = sha256(identifierFromPurchaser + ";" + JCS(input_data))   (the whole input_data, so the
//               acceptance profile hash is pinned in the escrow input_hash)
// result hash = sha256(identifierFromPurchaser + ";" + result)            (template standard-hash.mjs)
// result      = JCS({manifest:{attempt,kositVerdict,profileHash,scenario,xmlSha256}, xmlBase64})
import {createHash} from 'node:crypto';
import {canonicalJson,parseJson} from '../verifier/profile.mjs';
import {sha256,resultHash} from '../standard-hash.mjs';

export {resultHash};
export const inputHashFor=(inputData,nonce)=>sha256(`${nonce};${canonicalJson(inputData)}`);
export const bytesSha256=buffer=>createHash('sha256').update(buffer).digest('hex');

export function buildResult({xml,kosit,profileHash,attempt}){
 const bytes=Buffer.from(xml,'utf8');
 const manifest={attempt,kositVerdict:kosit.accepted?'ACCEPTABLE':'REJECT',profileHash,scenario:kosit.scenario??null,xmlSha256:bytesSha256(bytes)};
 return {manifest,result:canonicalJson({manifest,xmlBase64:bytes.toString('base64')})};
}

// Buyer side: everything that can be checked without a validator. Returns failures in the checks.mjs shape.
export function verifyDelivery({result,nonce,onChainHash,profileHash}){
 const failures=[];
 if(typeof result!=='string'||!result)return {failures:[{code:'ABN-LIEFERUNG',textDe:'Der RechnungsMeister hat kein Ergebnis geliefert.'}],xml:null,manifest:null};
 const computed=resultHash(result,nonce);
 if(computed!==onChainHash)failures.push({code:'ABN-HASH',textDe:`Der Hash der gelieferten Daten (${computed.slice(0,12)}…) stimmt nicht mit dem Hash in der Escrow auf Cardano (${String(onChainHash).slice(0,12)}…) überein.`});
 // One on-chain hash must commit to one reading: no duplicate keys, the JCS spelling only, strict base64.
 let parsed,canonical;
 try{parsed=parseJson(result);canonical=canonicalJson(parsed)===result;}catch{return {failures:[...failures,{code:'ABN-MANIFEST',textDe:'Das gelieferte Ergebnis ist kein gültiges JSON.'}],xml:null,manifest:null};}
 const {manifest,xmlBase64}=parsed??{};
 if(!manifest||typeof xmlBase64!=='string')return {failures:[...failures,{code:'ABN-MANIFEST',textDe:'Dem Ergebnis fehlen Manifest oder XML.'}],xml:null,manifest:null};
 if(!canonical||Buffer.from(xmlBase64,'base64').toString('base64')!==xmlBase64)return {failures:[...failures,{code:'ABN-MANIFEST',textDe:'Das gelieferte Ergebnis ist nicht in kanonischer Form (JCS, Base64) und damit nicht eindeutig.'}],xml:null,manifest:null};
 const bytes=Buffer.from(xmlBase64,'base64');
 if(bytesSha256(bytes)!==manifest.xmlSha256)failures.push({code:'ABN-MANIFEST',textDe:'Der SHA-256 der gelieferten XML stimmt nicht mit dem Manifest überein.'});
 if(manifest.profileHash!==profileHash)failures.push({code:'ABN-PROFIL',textDe:`Das Ergebnis wurde gegen Prüfprofil ${manifest.profileHash} erstellt, vereinbart war ${profileHash}.`});
 // The buyer inspects, stores and mails exactly the committed bytes: valid UTF-8 (BOM kept) that declares no other
 // encoding, so the string is one reading of them (DELTA-SELLER-4).
 let xml=null;try{xml=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{}
 const declared=xml&&/^\uFEFF?<\?xml[^>]*?\sencoding\s*=\s*["']([^"']*)["']/.exec(xml)?.[1];
 if(xml==null||declared&&!/^utf-8$/i.test(declared))return {failures:[...failures,{code:'ABN-MANIFEST',textDe:'Die gelieferte XML ist nicht als UTF-8 kodiert oder erklärt eine andere Kodierung und ist damit nicht eindeutig lesbar.'}],xml:null,manifest};
 return {failures,xml,manifest};
}
