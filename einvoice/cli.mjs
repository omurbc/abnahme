// Usage: node --env-file-if-exists=.env einvoice/cli.mjs <invoice.txt> <empfaenger-id> <betrag>
// extract (EXTRACT_MODE=llm|fixed) -> build XRechnung-UBL -> KoSIT validate -> semantic checks -> German summary.
// <betrag> is the gross total the buyer agreed to (e.g. 18400.00); BT-115 is checked against it, never against the
// total the invoice prints about itself.
// Exit code 0 = abgenommen, 1 = abgelehnt, 2 = Fehler. Other agents can import abnahme() instead.
import {existsSync,readFileSync,realpathSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {extract} from './extract.mjs';
import {buildXml} from './build.mjs';
import {validate} from '../verifier/kosit.mjs';
import {runChecks,invoiceFacts} from '../verifier/checks.mjs';
import {loadProfile} from '../verifier/profile.mjs';

export async function abnahme(text,recipientId,{mode,expectedTotal}={}){
 if(!(Number(expectedTotal)>0))throw new Error('Der erwartete Bruttobetrag fehlt: der Zahlbetrag wird gegen den vereinbarten Betrag geprüft, nicht gegen die Rechnung selbst.');
 const {acceptance,recipient,profileHash}=loadProfile(recipientId);
 const fields=await extract(text,mode);
 const xml=await buildXml(fields);
 const kosit=await validate(xml,{scenario:acceptance.scenario});
 const checks=runChecks({xml,kosit,acceptance,recipient,expectedTotal:Number(expectedTotal)});
 return {acceptance,recipient,profileHash,fields,xml,kosit,checks,expectedTotal:Number(expectedTotal)};
}

const euro=n=>n==null?'unbekannt':Number(n).toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2})+' €';
export function summaryDe({acceptance,recipient,profileHash,fields,xml,kosit,checks,expectedTotal=fields.grossTotal}){
 const out=[
  `Abnahme: ${checks.passed?'ABGENOMMEN':'ABGELEHNT'}`,
  `Rechnung ${fields.invoiceNumber} vom ${fields.invoiceDate} – ${fields.sellerName} an ${fields.buyerName}`,
  `Zahlbetrag laut XRechnung: ${euro(invoiceFacts(xml).payableAmount)} (erwartet: ${euro(expectedTotal)})`,
  `KoSIT ${acceptance.validator.version} / Konfiguration ${acceptance.configuration.release}: HTTP ${kosit.httpStatus}, Szenario „${kosit.scenario??'keins'}“`,
  `Prüfprofil: ${acceptance.id} + ${recipient.id}, Hash ${profileHash}`,
 ];
 if(checks.failures.length)out.push('Mängel:',...checks.failures.map(f=>` - [${f.code}] ${f.textDe}`));
 if(checks.minor.length)out.push('Hinweise (kein Ablehnungsgrund):',...checks.minor.map(f=>` - [${f.code}] ${f.textDe}`));
 return out.join('\n');
}

// Not import.meta.main: that needs Node >= 24.2, and on older Node the CLI would exit 0 without doing anything.
if(process.argv[1]&&existsSync(process.argv[1])&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){
 const [file,recipientId,expectedTotal]=process.argv.slice(2);
 if(!file||!recipientId||!(Number(expectedTotal)>0)){console.error('Aufruf: node einvoice/cli.mjs <rechnung.txt> <empfaenger-id> <betrag>  (vereinbarter Bruttobetrag, z. B. 18400.00)');process.exit(2);}
 try{
  const result=await abnahme(readFileSync(file,'utf8'),recipientId,{expectedTotal});
  console.log(summaryDe(result));
  process.exit(result.checks.passed?0:1);
 }catch(error){
  console.error(`Fehler: ${error.message}`);
  process.exit(2);
 }
}
