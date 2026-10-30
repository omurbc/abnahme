// LOCAL STAND-IN for stream D's buero/abnahme.mjs, same runAbnahme() interface. Selected with ABNAHME_IMPL=local.
// Runs the real acceptance test (extraction per EXTRACT_MODE, XRechnung build, KoSIT, semantic checks against the
// user's expected total) but hires nobody and buys nothing: no escrow, txs is empty, purchaseId is null.
import {extract} from '../einvoice/extract.mjs';
import {buildXml} from '../einvoice/build.mjs';
import {summaryDe} from '../einvoice/cli.mjs';
import {validate} from '../verifier/kosit.mjs';
import {runChecks} from '../verifier/checks.mjs';
import {loadProfile} from '../verifier/profile.mjs';

export async function runAbnahme({invoiceText,recipientProfileId,expectedTotal,onProgress=async()=>{}}){
 try{
  const {acceptance,recipient,profileHash}=loadProfile(recipientProfileId);
  await onProgress(`Lokale Prüfung ohne Escrow-Kauf. Prüfprofil ${acceptance.id} + ${recipient.id}, Hash ${profileHash}.`);
  const fields=await extract(invoiceText);
  const xml=await buildXml(fields);
  const kosit=await validate(xml,{scenario:acceptance.scenario});
  await onProgress(`KoSIT ${acceptance.validator.version}: HTTP ${kosit.httpStatus}, Szenario „${kosit.scenario??'keins'}“.`);
  const checks=runChecks({xml,kosit,acceptance,recipient,expectedTotal});
  const protocolDe=`Modus: LOKALE Prüfung ohne Escrow-Kauf bei RechnungsMeister (ABNAHME_IMPL=local).\n${summaryDe({acceptance,recipient,profileHash,fields:{...fields,grossTotal:expectedTotal},xml,kosit,checks})}`;
  return {status:checks.passed?'ACCEPTED':'REFUSED',protocolDe,xml,kositReport:kosit.reportXml??null,txs:[],purchaseId:null};
 }catch(error){
  return {status:'FAILED',protocolDe:`Prüfung nicht durchführbar: ${error.message}`,xml:null,kositReport:null,txs:[],purchaseId:null};
 }
}
