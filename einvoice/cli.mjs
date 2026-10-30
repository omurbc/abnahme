// Usage: node --env-file-if-exists=.env einvoice/cli.mjs <invoice.txt> <empfaenger-id>
// extract (EXTRACT_MODE=llm|fixed) -> build XRechnung-UBL -> KoSIT validate -> semantic checks -> German summary.
// Exit code 0 = abgenommen, 1 = abgelehnt, 2 = Fehler. Other agents can import abnahme() instead.
import {readFileSync} from 'node:fs';
import {extract} from './extract.mjs';
import {buildXml} from './build.mjs';
import {validate} from '../verifier/kosit.mjs';
import {runChecks,invoiceFacts} from '../verifier/checks.mjs';
import {loadProfile} from '../verifier/profile.mjs';

export async function abnahme(text,recipientId,{mode}={}){
 const {acceptance,recipient,profileHash}=loadProfile(recipientId);
 const fields=await extract(text,mode);
 const xml=await buildXml(fields);
 const kosit=await validate(xml,{scenario:acceptance.scenario});
 const checks=runChecks({xml,kosit,acceptance,recipient,expectedTotal:fields.grossTotal});
 return {acceptance,recipient,profileHash,fields,xml,kosit,checks};
}

const euro=n=>n==null?'unbekannt':Number(n).toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2})+' €';
export function summaryDe({acceptance,recipient,profileHash,fields,xml,kosit,checks}){
 const out=[
  `Abnahme: ${checks.passed?'ABGENOMMEN':'ABGELEHNT'}`,
  `Rechnung ${fields.invoiceNumber} vom ${fields.invoiceDate} – ${fields.sellerName} an ${fields.buyerName}`,
  `Zahlbetrag laut XRechnung: ${euro(invoiceFacts(xml).payableAmount)} (erwartet: ${euro(fields.grossTotal)})`,
  `KoSIT ${acceptance.validator.version} / Konfiguration ${acceptance.configuration.release}: HTTP ${kosit.httpStatus}, Szenario „${kosit.scenario??'keins'}“`,
  `Prüfprofil: ${acceptance.id} + ${recipient.id}, Hash ${profileHash}`,
 ];
 if(checks.failures.length)out.push('Mängel:',...checks.failures.map(f=>` - [${f.code}] ${f.textDe}`));
 if(checks.minor.length)out.push('Hinweise (kein Ablehnungsgrund):',...checks.minor.map(f=>` - [${f.code}] ${f.textDe}`));
 return out.join('\n');
}

if(import.meta.main){
 const [file,recipientId]=process.argv.slice(2);
 if(!file||!recipientId){console.error('Aufruf: node einvoice/cli.mjs <rechnung.txt> <empfaenger-id>');process.exit(2);}
 try{
  const result=await abnahme(readFileSync(file,'utf8'),recipientId);
  console.log(summaryDe(result));
  process.exit(result.checks.passed?0:1);
 }catch(error){
  console.error(`Fehler: ${error.message}`);
  process.exit(2);
 }
}
