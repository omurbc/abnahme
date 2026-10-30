// MIP-004 hashes and the RechnungsMeister result format, shared by seller (rechnungsmeister/server.mjs)
// and buyer (buero/abnahme.mjs).
// input hash  = sha256(identifierFromPurchaser + ";" + JCS(input_data))   (the whole input_data, so the
//               acceptance profile hash is pinned in the escrow input_hash)
// result hash = sha256(identifierFromPurchaser + ";" + result)            (template standard-hash.mjs)
// result      = JCS({manifest:{attempt,kositVerdict,profileHash,scenario,xmlSha256}, xmlBase64})
import {createHash} from 'node:crypto';
import {canonicalJson} from '../verifier/profile.mjs';
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
 let parsed;
 try{parsed=JSON.parse(result);}catch{return {failures:[...failures,{code:'ABN-MANIFEST',textDe:'Das gelieferte Ergebnis ist kein gültiges JSON.'}],xml:null,manifest:null};}
 const {manifest,xmlBase64}=parsed??{};
 if(!manifest||typeof xmlBase64!=='string')return {failures:[...failures,{code:'ABN-MANIFEST',textDe:'Dem Ergebnis fehlen Manifest oder XML.'}],xml:null,manifest:null};
 const bytes=Buffer.from(xmlBase64,'base64');
 if(bytesSha256(bytes)!==manifest.xmlSha256)failures.push({code:'ABN-MANIFEST',textDe:'Der SHA-256 der gelieferten XML stimmt nicht mit dem Manifest überein.'});
 if(manifest.profileHash!==profileHash)failures.push({code:'ABN-PROFIL',textDe:`Das Ergebnis wurde gegen Prüfprofil ${manifest.profileHash} erstellt, vereinbart war ${profileHash}.`});
 return {failures,xml:bytes.toString('utf8'),manifest};
}
