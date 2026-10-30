// Abnahme-Büro escrow engine (buyer). Buys one conversion from RechnungsMeister through the Masumi V2 escrow and
// releases the money only after its own acceptance test passes:
//   /start_job -> /purchase (FundsLocked) -> ResultSubmitted -> hash + KoSIT + semantic checks
//   pass -> ACCEPTED (deemed acceptance at unlockTime)
//   defect -> request-refund (Disputed) -> POST /dispute -> cure ResultSubmitted -> re-inspect
//             pass -> cancel-refund-request (AuthorizeWithdrawal) -> Withdrawn -> ACCEPTED
//             fail / timeout -> REFUSED (escrow stays Disputed or the seller authorizes the refund)
// Every step observes MPS state before it writes, and the journal (.local/abnahme-journal/) is saved after
// every step, so a restart with the same input resumes the same job instead of paying twice.
import {randomBytes} from 'node:crypto';
import {existsSync,mkdirSync,readdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sha256} from '../standard-hash.mjs';
import {USDM} from '../paid-task.mjs';
import {canonicalJson,loadProfile} from '../verifier/profile.mjs';
import {parseReport,validate} from '../verifier/kosit.mjs';
import {runChecks} from '../verifier/checks.mjs';
import {inputHashFor,verifyDelivery} from '../rechnungsmeister/mip004.mjs';
import {createEscrow,confirmed,escrowTxs,explorerUrl} from './escrow.mjs';

const MINUTE=60000;
const MAX_DISPUTES=2;

// ---------- default dependencies (real services) ----------
export function rmClient(base=process.env.RM_URL??`http://127.0.0.1:${process.env.AGENT_API_PORT||21950}`){
 async function call(path,body){
  const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(60000)});
  return {httpStatus:r.status,body:await r.json().catch(()=>({}))};
 }
 return {startJob:body=>call('/start_job',body),status:jobId=>call(`/status?job_id=${encodeURIComponent(jobId)}`),dispute:body=>call('/dispute',body)};
}

export function kositFromReport(httpStatus,reportXml,pinned){
 const {scenario,messages,assessment}=parseReport(reportXml);
 if(scenario!==pinned)messages.push({level:'error',code:'KOSIT-SCENARIO',text:`Matched scenario ${JSON.stringify(scenario)} instead of ${JSON.stringify(pinned)}`});
 return {accepted:httpStatus===200&&assessment==='accept'&&scenario===pinned,httpStatus,scenario,messages,reportXml};
}

// x402 Gutachter (1 tADA) unless INSPECT_MODE=local; falls back to the local KoSIT daemon without retrying x402.
export async function inspectXml(xml,{scenario}){
 let note=null,txHash=null;
 if(process.env.INSPECT_MODE!=='local'){
  try{
   const {buyInspection}=await import('../gutachter/buy.mjs');
   const r=await buyInspection(xml);txHash=r.txHash??null;
   if(r.httpStatus===200&&typeof r.result?.report==='string')return {mode:'x402',txHash,kosit:kositFromReport(r.result.httpStatus,r.result.report,scenario)};
   note=`x402 HTTP ${r.httpStatus}`;
  }catch(e){note=`x402: ${e.message}`;}
 }
 return {mode:'local',txHash,note,kosit:await validate(xml,{scenario})};
}

export function defaultDeps(){
 return {rm:rmClient(),escrow:createEscrow(),inspect:inspectXml,now:()=>Date.now(),sleep:ms=>new Promise(r=>setTimeout(r,ms)),journalDir:'.local/abnahme-journal',pollMs:10000};
}

// ---------- journal ----------
const journalPath=(dir,id)=>join(dir,`${id}.json`);
function saveJournal(dir,j){const p=journalPath(dir,j.id);writeFileSync(p+'.tmp',JSON.stringify(j,null,1),{mode:0o600});renameSync(p+'.tmp',p);}
export function findOpenJournal(dir,inputKey){
 if(!existsSync(dir))return null;
 return readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(readFileSync(join(dir,f),'utf8'))).find(j=>j.inputKey===inputKey&&j.stage!=='done')??null;
}

const euro=n=>Number(n).toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2})+' €';
const time=ms=>new Date(Number(ms)).toLocaleTimeString('de-DE',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit'});

// ---------- engine ----------
export async function runAbnahme({invoiceText,recipientProfileId,expectedTotal,onProgress,followSettlement=false},deps=defaultDeps()){
 const {rm,escrow,inspect,now,sleep,journalDir,pollMs}=deps;
 mkdirSync(journalDir,{recursive:true,mode:0o700});
 const total=Number(expectedTotal);
 if(typeof invoiceText!=='string'||!invoiceText.trim())throw new Error('invoiceText fehlt');
 if(!Number.isFinite(total)||total<=0)throw new Error('expectedTotal muss ein positiver Betrag sein');
 const {acceptance,recipient,profileHash}=loadProfile(recipientProfileId);
 const input={invoiceText,recipientProfileId,expectedTotal:total.toFixed(2),acceptanceProfileHash:profileHash};
 const inputKey=sha256(canonicalJson({invoiceText,recipientProfileId,expectedTotal:input.expectedTotal}));

 let j=findOpenJournal(journalDir,inputKey);
 const resumed=!!j;
 if(!j){const nonce=randomBytes(10).toString('hex');j={id:`${new Date(now()).toISOString().replace(/[:.]/g,'-')}-${nonce.slice(0,6)}`,inputKey,nonce,inputHash:inputHashFor(input,nonce),profileHash,stage:'start',round:0,disputes:0,attempts:[],inspectionTxs:[],log:[],createdAt:new Date(now()).toISOString()};}
 const save=()=>saveJournal(journalDir,j);
 const say=line=>{j.log.push({at:new Date(now()).toISOString(),line});save();onProgress?.(line);};
 const finish=(status,line)=>{j.status=status;j.stage=followSettlement&&status!=='FAILED'?'follow':'done';say(line);};
 if(resumed)say(`Fortsetzung des Auftrags ${j.id} ab Schritt „${j.stage}“.`);else{save();say(`Auftrag ${j.id}: Rechnung für ${recipient.name}, erwarteter Betrag ${euro(total)}, Prüfprofil ${profileHash.slice(0,12)}…`);}

 const bcid=()=>j.startJob.blockchainIdentifier;
 let errors=0;
 while(j.stage!=='done'){
  try{
   await step();
   errors=0;
  }catch(e){
   if(e.permanent){j.error=e.message;finish('FAILED',`Abbruch: ${e.message}`);break;}
   errors++;j.lastError=e.message;save();
   if(errors>=12)throw new Error(`Abnahme ${j.id} hängt nach ${errors} Fehlern (${e.message}); Journal ${journalPath(journalDir,j.id)} bleibt zum Fortsetzen erhalten.`);
   await sleep(pollMs);
  }
 }
 await refreshTxs().catch(()=>{});save();
 return {status:j.status,protocolDe:j.log.map(l=>l.line).join('\n'),xml:j.lastXml??null,kositReport:j.lastKositReport??null,txs:j.txs??[],purchaseId:j.purchaseId??null,journalId:j.id};

 async function refreshTxs(){
  const [purchase,payment]=await Promise.all([escrow.getPurchase(bcid()),escrow.getPayment(bcid())]);
  j.txs=[...escrowTxs(purchase,payment),...j.inspectionTxs];
  return purchase;
 }
 function permanent(message){const e=new Error(message);e.permanent=true;return e;}
 function manualAction(p){if(p?.NextAction?.requestedAction==='WaitingForManualAction')throw permanent(`MPS verlangt manuelles Eingreifen: ${p.NextAction.errorNote??p.NextAction.errorType??'ohne Angabe'}`);}
 async function wait(){await sleep(pollMs);}

 async function step(){
  switch(j.stage){
   case 'start':{
    const r=await rm.startJob({identifier_from_purchaser:j.nonce,input_data:input});
    if(r.httpStatus>=500||r.httpStatus===409)throw new Error(`start_job HTTP ${r.httpStatus}: ${r.body.error}`);
    if(r.httpStatus!==200)throw permanent(`RechnungsMeister lehnt den Auftrag ab (HTTP ${r.httpStatus}: ${r.body.error})`);
    const s=r.body;
    if(s.input_hash!==j.inputHash)throw permanent(`Eingabe-Hash des RechnungsMeisters ${s.input_hash} weicht vom eigenen ${j.inputHash} ab`);
    if(JSON.stringify(s.amounts)!==JSON.stringify([{amount:'1000000',unit:USDM}]))throw permanent(`Preis ${JSON.stringify(s.amounts)} ist nicht 1 tUSDM`);
    if(Number(s.payByTime)<now()+MINUTE)throw permanent('Zahlungsfrist ist schon abgelaufen');
    j.startJob=s;j.stage='purchase';
    say(`Angebot von RechnungsMeister (Auftrag ${s.job_id??s.id}): 1 tUSDM, Ergebnis bis ${time(s.submitResultTime)}, Freigabe ab ${time(s.unlockTime)}. Eingabe-Hash geprüft.`);
    return;
   }
   case 'purchase':{
    let p=await escrow.getPurchase(bcid());
    if(!p){
     if(now()>Number(j.startJob.payByTime))throw permanent('Zahlungsfrist abgelaufen, bevor gekauft wurde');
     p=await escrow.purchase(j.startJob,{inputHash:j.inputHash,nonce:j.nonce,metadata:JSON.stringify({abnahmeJournal:j.id})});
    }
    j.purchaseId=p.id;j.stage='wait-locked';
    say('Kauf an den Masumi Payment Service übergeben; 1 tUSDM wird in der Escrow auf Cardano gesperrt.');
    return;
   }
   case 'wait-locked':{
    const p=await escrow.getPurchase(bcid());manualAction(p);
    if(p&&confirmed(p,'FundsLocked')){j.purchaseId=p.id;j.stage='wait-result';say('Geld gesperrt (FundsLocked). Warte auf das Ergebnis des RechnungsMeisters.');return;}
    if(now()>Number(j.startJob.payByTime)+3*MINUTE)throw permanent('Die Sperrung wurde bis zur Zahlungsfrist nicht bestätigt');
    return wait();
   }
   case 'wait-result':{
    const p=await escrow.getPurchase(bcid());manualAction(p);
    const state=j.round===0?'ResultSubmitted':'Disputed';
    if(p.onChainState===state&&p.resultHash&&p.resultHash!==j.lastResultHash&&p.CurrentTransaction?.status==='Confirmed'){
     j.stage='inspect';say(j.round===0?'Ergebnis auf Cardano eingereicht (ResultSubmitted). Starte die Abnahmeprüfung.':`Nachbesserung ${j.round} auf Cardano eingereicht. Prüfe erneut.`);return;
    }
    if(j.round===0){
     if(['RefundWithdrawn','RefundAuthorized'].includes(p.onChainState))return finish('FAILED',`Escrow ${p.onChainState}: der RechnungsMeister hat nicht geliefert, das Geld geht zurück.`);
     if(now()>Number(j.startJob.submitResultTime)+2*MINUTE)return finish('FAILED','Kein Ergebnis bis zur Frist. Die Escrow erstattet das Geld automatisch zurück.');
    }else{
     const st=await rm.status(j.startJob.job_id??j.startJob.id).catch(()=>null);
     if(['refund-authorized','refund-pending'].includes(st?.body?.phase)||p.onChainState==='RefundAuthorized')return finish('REFUSED','Der RechnungsMeister hat die Rückerstattung freigegeben. Rechnung abgelehnt, das Geld geht an das Büro zurück.');
     if(now()>j.cureDeadline)return finish('REFUSED','Keine Nachbesserung innerhalb der Frist. Rechnung abgelehnt; die Escrow bleibt im Streitfall (Disputed), bis der RechnungsMeister erstattet.');
    }
    return wait();
   }
   case 'inspect':{
    const p=await escrow.getPurchase(bcid());
    const st=await rm.status(j.startJob.job_id??j.startJob.id);
    if(st.httpStatus!==200)throw new Error(`status HTTP ${st.httpStatus}`);
    const contract=p.PaymentSource?.smartContractAddress??j.startJob.smartContractAddress;
    let chainHash=null,hashSource='MPS';
    try{chainHash=await escrow.chainResultHash(p.CurrentTransaction?.txHash,contract);if(chainHash)hashSource='Datum (Blockfrost)';}catch{}
    const onChainHash=chainHash??p.resultHash;
    const delivery=verifyDelivery({result:st.body.result,nonce:j.nonce,onChainHash,profileHash});
    if(chainHash&&chainHash!==p.resultHash)delivery.failures.push({code:'ABN-HASH',textDe:'Der Ergebnis-Hash im Datum auf Cardano weicht vom Stand des Payment Service ab.'});
    let kosit=null,checks={failures:[],minor:[]},inspection=null;
    if(delivery.xml){
     inspection=await inspect(delivery.xml,{scenario:acceptance.scenario});
     kosit=inspection.kosit;
     if(inspection.txHash)j.inspectionTxs.push({label:`x402 inspection ${j.inspectionTxs.length+1}`,txHash:inspection.txHash,explorerUrl:explorerUrl(inspection.txHash)});
     checks=runChecks({xml:delivery.xml,kosit,acceptance,recipient,expectedTotal:total});
     j.lastXml=delivery.xml;j.lastKositReport=kosit.reportXml;
    }
    const failures=[...delivery.failures,...checks.failures];
    const passed=!!kosit?.accepted&&!failures.length;
    j.lastResultHash=p.resultHash;
    j.attempts.push({round:j.round,attempt:delivery.manifest?.attempt??null,onChainHash,hashSource,passed,failures,minor:checks.minor.map(m=>m.code),inspection:inspection&&{mode:inspection.mode,txHash:inspection.txHash,note:inspection.note,httpStatus:kosit.httpStatus,scenario:kosit.scenario}});
    say(`Prüfung ${j.attempts.length} (${inspection?.mode==='x402'?'Gutachter über x402, 1 tADA':'lokaler KoSIT-Prüfer'}${inspection?.note?`, ${inspection.note}`:''}): Ergebnis-Hash (${hashSource}) ${delivery.failures.some(f=>f.code==='ABN-HASH')?'stimmt NICHT':'stimmt'}, KoSIT ${kosit?(kosit.accepted?'akzeptiert':'abgelehnt'):'nicht geprüft'}.`);
    if(passed){
     if(j.round===0)return finish('ACCEPTED',`ABGENOMMEN. Die Escrow zahlt den RechnungsMeister automatisch nach der Freigabezeit (${time(j.startJob.unlockTime)}) aus.`);
     j.stage='accept';say('Nachbesserung besteht die Abnahme. Gebe die Zahlung frei (AuthorizeWithdrawal).');return;
    }
    say(`Mängel: ${failures.map(f=>`[${f.code}] ${f.textDe}`).join(' ')}`);
    if(j.disputes>=MAX_DISPUTES)return finish('REFUSED','Rechnung abgelehnt: auch nach Nachbesserung mangelhaft. Die Escrow bleibt gesperrt, bis der RechnungsMeister erstattet.');
    j.pendingFailures=failures;j.stage=p.onChainState==='Disputed'?'notify':'dispute';return;
   }
   case 'dispute':{
    const p=await escrow.getPurchase(bcid());manualAction(p);
    if(p.onChainState==='Disputed'||p.NextAction?.requestedAction==='SetRefundRequestedRequested'){j.stage='wait-disputed';return;}
    if(p.onChainState==='ResultSubmitted'&&p.NextAction?.requestedAction==='WaitingForExternalAction'){
     if(now()>Number(j.startJob.unlockTime)-4*MINUTE)return finish('REFUSED','Mangel gefunden, aber die Frist für die Mängelrüge (vor der Freigabezeit) ist abgelaufen.');
     await escrow.requestRefund(bcid());j.stage='wait-disputed';say('Mängelrüge auf Cardano: Rückerstattung verlangt, die Escrow geht in den Streitfall (Disputed).');return;
    }
    return wait();
   }
   case 'wait-disputed':{
    const p=await escrow.getPurchase(bcid());manualAction(p);
    if(p.onChainState==='Disputed'&&confirmed(p,'Disputed')&&p.NextAction?.requestedAction==='WaitingForExternalAction'){j.stage='notify';say('Streitfall bestätigt (Disputed). Das Geld ist eingefroren. Sende das Prüfprotokoll an den RechnungsMeister.');return;}
    if(now()>Number(j.startJob.unlockTime))throw permanent('Die Mängelrüge wurde vor der Freigabezeit nicht bestätigt');
    return wait();
   }
   case 'notify':{
    const round=j.disputes+1;
    const r=await rm.dispute({jobId:j.startJob.job_id??j.startJob.id,round,failures:j.pendingFailures.map(({code,textDe})=>({code,textDe})),kositReport:j.lastKositReport??null});
    if(r.httpStatus===409||r.httpStatus>=500)throw new Error(`dispute HTTP ${r.httpStatus}: ${r.body.error}`);
    j.disputes=round;
    if(r.httpStatus===200&&r.body.status==='cure-submitted'){
     j.round++;j.cureDeadline=Math.min(Number(j.startJob.externalDisputeUnlockTime)-5*MINUTE,now()+20*MINUTE);j.stage='wait-result';
     const patch=Object.entries(r.body.patch??{}).map(([k,v])=>`${k} = ${v} (Quelle: ${r.body.sources?.[k]})`).join(', ');
     say(`RechnungsMeister bessert nach (Versuch ${r.body.attempt})${patch?`: ${patch}`:''}.`);return;
    }
    return finish('REFUSED',`Rechnung abgelehnt. Der RechnungsMeister kann nicht nachbessern (${(r.body.reasons??[r.body.error]).join(' ')}) und gibt die Rückerstattung frei.`);
   }
   case 'accept':{
    const p=await escrow.getPurchase(bcid());manualAction(p);
    if(['WithdrawAuthorized','Withdrawn'].includes(p.onChainState)||p.NextAction?.requestedAction==='AuthorizeWithdrawalRequested'){j.stage='wait-withdrawn';j.acceptedAt??=now();return;}
    if(p.onChainState==='Disputed'&&p.NextAction?.requestedAction==='WaitingForExternalAction'){await escrow.cancelRefundRequest(bcid());j.acceptedAt=now();j.stage='wait-withdrawn';say('Freigabe auf Cardano beauftragt (cancel-refund-request → AuthorizeWithdrawal).');return;}
    return wait();
   }
   case 'wait-withdrawn':{
    const p=await escrow.getPurchase(bcid());manualAction(p);
    if(p.onChainState==='Withdrawn')return finish('ACCEPTED','ABGENOMMEN. Der RechnungsMeister hat die Zahlung aus der Escrow erhalten (Withdrawn).');
    if(p.onChainState==='WithdrawAuthorized'&&!j.withdrawAuthorizedSeen){j.withdrawAuthorizedSeen=true;say('Zahlung freigegeben (WithdrawAuthorized). Warte auf die Auszahlung an den RechnungsMeister.');}
    if(now()>j.acceptedAt+25*MINUTE){
     if(j.withdrawAuthorizedSeen)return finish('ACCEPTED','ABGENOMMEN. Zahlung freigegeben (WithdrawAuthorized); die Auszahlung an den RechnungsMeister steht noch aus.');
     throw permanent(`Freigabe nicht bestätigt, Escrow ist ${p.onChainState}`);
    }
    return wait();
   }
   case 'follow':{
    // Optional: keep watching until the escrow pays out, to record the final txs.
    const p=await escrow.getPurchase(bcid());
    if(['Withdrawn','RefundWithdrawn','DisputedWithdrawn'].includes(p.onChainState)){j.stage='done';say(`Escrow abgeschlossen: ${p.onChainState}.`);return;}
    j.followUntil??=j.status==='ACCEPTED'&&j.round===0?Number(j.startJob.unlockTime)+25*MINUTE:now()+40*MINUTE;
    if(now()>j.followUntil){j.stage='done';say(`Escrow noch ${p.onChainState}; Beobachtung beendet.`);return;}
    return wait();
   }
   default:throw permanent(`Unbekannter Schritt ${j.stage}`);
  }
 }
}
