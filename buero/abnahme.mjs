// Abnahme-Büro escrow engine (buyer). Buys one conversion from RechnungsMeister through the Masumi V2 escrow and
// releases the money only after its own acceptance test passes:
//   /start_job -> /purchase (FundsLocked) -> ResultSubmitted -> hash + KoSIT + semantic checks
//   pass -> ACCEPTED (deemed acceptance at unlockTime)
//   defect -> request-refund (Disputed) -> POST /dispute -> cure ResultSubmitted -> re-inspect
//             pass -> cancel-refund-request (AuthorizeWithdrawal) -> Withdrawn -> ACCEPTED
//             fail / no cure in time -> the seller's AuthorizeRefund on chain -> REFUSED
// In ResultSubmitted the escrow pays the seller at unlockTime without the buyer, so until a dispute is on chain no error
// ends the run: an inspection that has not passed by the decision deadline (seller /status, Blockfrost, KoSIT or the
// Gutachter failing, or a late result) gets a protective Mängelrüge, and the inspection goes on from Disputed, where the
// money waits for the buyer. A run that ends while the escrow is unsettled leaves its journal open.
// Every step observes MPS state before it writes, and the journal (.local/abnahme-journal/) is saved after
// every step, so a restart with the same input resumes the same job instead of paying twice; a finished job whose
// money went to the seller answers a rerun from its journal.
import {randomBytes} from 'node:crypto';
import {existsSync,mkdirSync,readdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sha256} from '../standard-hash.mjs';
import {USDM} from '../paid-task.mjs';
import {canonicalJson,loadProfile} from '../verifier/profile.mjs';
import {parseReport,validate,assertPinnedValidator,assertDocumentHash} from '../verifier/kosit.mjs';
import {runChecks} from '../verifier/checks.mjs';
import {inputHashFor,verifyDelivery} from '../rechnungsmeister/mip004.mjs';
import {createEscrow,confirmed,escrowTxs,explorerUrl} from './escrow.mjs';
import {invoiceNumberOf} from './sokosumi.mjs';

const MINUTE=60000;
const MAX_DISPUTES=2;
// Before unlockTime: by DECIDE an inspection has passed or a protective Mängelrüge goes out, and no inspection starts
// later than INSPECT before that (x402 calls are serialized per process and may resend for 3 min). MPS builds a refund
// request only while unlockTime is more than 3 min away and keeps a later one without a word (request-refund/
// service.ts:1271), so none is sent after LAST_DISPUTE.
const DECIDE=15*MINUTE,INSPECT=10*MINUTE,LAST_DISPUTE=5*MINUTE;
// Longest quote accepted, per window: RechnungsMeister's own deadlines() (+25, +20, +20 min) plus a margin.
const MAX_WINDOW=30*MINUTE;
// Escrow states from which the seller is no longer paid by deemed acceptance.
const SAFE=new Set(['Disputed','RefundRequested','WithdrawAuthorized','RefundAuthorized','Withdrawn','RefundWithdrawn','DisputedWithdrawn']);

// ---------- default dependencies (real services) ----------
// /status (the delivered result) and /dispute need the job token from /start_job. /start_job carries RM_BUYER_KEY, so the
// seller's window for new jobs does not count the Büro (DELTA-SELLER-3).
export function rmClient(base=process.env.RM_URL??`http://127.0.0.1:${process.env.AGENT_API_PORT||21950}`){
 async function call(path,body,token,extra={}){
  const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...token?{authorization:`Bearer ${token}`}:{},...extra},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(60000)});
  return {httpStatus:r.status,body:await r.json().catch(()=>({}))};
 }
 return {startJob:body=>call('/start_job',body,undefined,process.env.RM_BUYER_KEY?{'x-buyer-key':process.env.RM_BUYER_KEY}:{}),status:(jobId,token)=>call(`/status?job_id=${encodeURIComponent(jobId)}`,undefined,token),dispute:(body,token)=>call('/dispute',body,token)};
}

// A Gutachter report is an inspection only of exactly these bytes by the pinned validator; otherwise it throws (not
// inspected) and inspectXml falls back to the local KoSIT.
export function kositFromReport(httpStatus,reportXml,pinned,xml){
 const report=parseReport(reportXml),{scenario,messages,assessment}=report;
 assertPinnedValidator(report,{scenario:pinned});
 assertDocumentHash(report,xml);
 if(scenario!==pinned)messages.push({level:'error',code:'KOSIT-SCENARIO',text:`Matched scenario ${JSON.stringify(scenario)} instead of ${JSON.stringify(pinned)}`});
 return {accepted:httpStatus===200&&assessment==='accept'&&scenario===pinned,httpStatus,scenario,messages,reportXml};
}

// x402 Gutachter (1 tADA) unless INSPECT_MODE=local; falls back to the local KoSIT daemon without retrying x402.
// A Gutachter answer counts only with a settled payment. payment: buy.mjs returns a tx hash unless nothing was charged,
// so a hash without a 200 and a successful receipt may still settle ('unknown'), never 'not-charged' (DELTA-ENGINE-4).
export async function inspectXml(xml,{scenario,buyInspection}){
 let note=null,txHash=null,payment='not-charged';
 if(process.env.INSPECT_MODE!=='local'){
  try{
   buyInspection??=(await import('../gutachter/buy.mjs')).buyInspection;
   const r=await buyInspection(xml);txHash=r.txHash??null;
   payment=!txHash?'not-charged':r.httpStatus===200&&r.receipt?.success?'settled':'unknown';
   if(r.httpStatus===200&&typeof r.result?.report==='string'){
    if(!txHash||!r.receipt?.success)throw new Error('Antwort ohne bezahlte Quittung, keine Prüfung');
    return {mode:'x402',txHash,payment,kosit:kositFromReport(r.result.httpStatus,r.result.report,scenario,xml)};
   }
   note=`x402 HTTP ${r.httpStatus}`;
  }catch(e){note=`x402: ${e.message}`;}
 }
 return {mode:'local',txHash,payment,note,kosit:await validate(xml,{scenario})};
}
// The protocol goes to the customer (Sokosumi Task): a short German reason for the fallback. The raw note (English, may
// name local files) stays in the journal (LANE-A-4).
export function x402NoteDe(note){
 if(/budget/i.test(note))return 'x402-Budget für heute erreicht';
 if(/HTTP 402|Quittung|not confirmed/i.test(note))return 'x402: Zahlung nicht bestätigt';
 if(/fetch failed|ECONN|timeout|aborted|socket|HTTP 5\d\d/i.test(note))return 'x402: Gutachter nicht erreichbar';
 return 'x402: Gutachter-Prüfung nicht verwertbar';
}

// A deadline raced against a call still running: resolves after ms unless cancelled.
const realTimer=ms=>{let t;return {promise:new Promise(r=>{t=setTimeout(r,Math.max(0,ms));}),cancel:()=>clearTimeout(t)};};

export function defaultDeps(){
 return {rm:rmClient(),escrow:createEscrow(),inspect:inspectXml,now:()=>Date.now(),sleep:ms=>new Promise(r=>setTimeout(r,ms)),journalDir:'.local/abnahme-journal',pollMs:10000};
}

// ---------- journal ----------
const journalPath=(dir,id)=>join(dir,`${id}.json`);
function saveJournal(dir,j){const p=journalPath(dir,j.id);writeFileSync(p+'.tmp',JSON.stringify(j,null,1),{mode:0o600});renameSync(p+'.tmp',p);}
const journals=(dir,inputKey)=>existsSync(dir)?readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(readFileSync(join(dir,f),'utf8'))).filter(j=>j.inputKey===inputKey):[];
export function findOpenJournal(dir,inputKey){return journals(dir,inputKey).find(j=>j.stage!=='done')??null;}
// A finished job whose money went or goes to the seller: the same input is answered from it, never bought again.
const paidJournal=(dir,inputKey)=>journals(dir,inputKey).find(j=>j.stage==='done'&&(j.status==='ACCEPTED'||j.paidWithoutAcceptance))??null;
const outcome=j=>({status:j.status,protocolDe:j.log.map(l=>l.line).join('\n'),xml:j.lastXml??null,kositReport:j.lastKositReport??null,txs:j.txs??[],purchaseId:j.purchaseId??null,journalId:j.id});
const inputKeyOf=({invoiceText,recipientProfileId,expectedTotal})=>sha256(canonicalJson({invoiceText,recipientProfileId,expectedTotal:Number(expectedTotal).toFixed(2)}));

const euro=n=>Number(n).toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2})+' €';
const time=ms=>new Date(Number(ms)).toLocaleTimeString('de-DE',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit'});
const iso=ms=>Number.isFinite(ms)?new Date(ms).toISOString():String(ms);

// ---------- engine ----------
// Two PRÜFEN with the same input in one process share one run, so one driver moves each escrow.
const running=new Map();
export async function runAbnahme(job,deps=defaultDeps()){
 const key=`${deps.journalDir}\n${inputKeyOf(job)}`;
 if(!running.has(key))running.set(key,abnahme(job,deps).finally(()=>running.delete(key)));
 return running.get(key);
}

async function abnahme({invoiceText,recipientProfileId,expectedTotal,onProgress,followSettlement=false},deps){
 const {rm,escrow,inspect,now,sleep,journalDir,pollMs,timer=realTimer}=deps;
 mkdirSync(journalDir,{recursive:true,mode:0o700});
 const total=Number(expectedTotal);
 if(typeof invoiceText!=='string'||!invoiceText.trim())throw new Error('invoiceText fehlt');
 if(!Number.isFinite(total)||total<=0)throw new Error('expectedTotal muss ein positiver Betrag sein');
 const {acceptance,recipient,profileHash}=loadProfile(recipientProfileId);
 const input={invoiceText,recipientProfileId,expectedTotal:total.toFixed(2),acceptanceProfileHash:profileHash};
 const inputKey=inputKeyOf({invoiceText,recipientProfileId,expectedTotal});

 let j=findOpenJournal(journalDir,inputKey);
 const resumed=!!j;
 if(!j){
  const paid=paidJournal(journalDir,inputKey);
  if(paid){const line=`Diese Rechnung (gleicher Text, Empfänger und Betrag) wurde bereits in Auftrag ${paid.id} bezahlt (${paid.status}); es wird nicht erneut gekauft.`;onProgress?.(line);const r=outcome(paid);return {...r,protocolDe:`${line}\n${r.protocolDe}`};}
  const nonce=randomBytes(10).toString('hex');j={id:`${new Date(now()).toISOString().replace(/[:.]/g,'-')}-${nonce.slice(0,6)}`,inputKey,nonce,inputHash:inputHashFor(input,nonce),profileHash,stage:'start',round:0,disputes:0,attempts:[],inspectionTxs:[],log:[],createdAt:new Date(now()).toISOString()};
 }
 const save=()=>saveJournal(journalDir,j);
 const say=line=>{j.log.push({at:new Date(now()).toISOString(),line});save();onProgress?.(line);};
 // open: the run ends but the escrow is not settled; the journal stays open, so a rerun resumes it instead of buying.
 let ended=false;
 const finish=(status,line,{open=false,paidWithoutAcceptance=false}={})=>{j.status=status;if(paidWithoutAcceptance)j.paidWithoutAcceptance=true;if(open)ended=true;else j.stage=followSettlement&&status!=='FAILED'?'follow':'done';say(line);};
 if(resumed)say(`Fortsetzung des Auftrags ${j.id} ab Schritt „${j.stage}“.`);else{save();say(`Auftrag ${j.id}: Rechnung für ${recipient.name}, erwarteter Betrag ${euro(total)}, Prüfprofil ${profileHash.slice(0,12)}…`);}

 const bcid=()=>j.startJob.blockchainIdentifier;
 const jobId=()=>j.startJob.job_id??j.startJob.id;
 const token=()=>j.startJob.job_token;
 const unlock=()=>Number(j.startJob.unlockTime);
 // RechnungsMeister cures only until externalDisputeUnlockTime - 30 min (rechnungsmeister/server.mjs cureCutoff).
 const cureCutoff=()=>Number(j.startJob.externalDisputeUnlockTime)-30*MINUTE;
 const exposed=()=>!SAFE.has(j.escrowState);
 const paidOut=()=>`Die Escrow zahlt den RechnungsMeister ohne Abnahme aus (Fristablauf ${time(unlock())}): die 1 tUSDM sind bezahlt, die Rechnung ist nicht abgenommen. Ein erneutes PRÜFEN mit demselben Text kauft nicht erneut.`;
 const held=()=>`${j.escrowState==='Disputed'?`Das Geld ist in der Escrow eingefroren (Disputed): der RechnungsMeister wird ohne Freigabe des Büros nicht bezahlt; er kann erstatten, sonst entscheidet die Masumi-Schlichtung ab ${time(j.startJob.externalDisputeUnlockTime)}.`:`Escrow: ${j.escrowState??'Stand unbekannt'}.`} Erneutes PRÜFEN mit demselben Text setzt diesen Auftrag fort, es wird nicht erneut gekauft.`;
 let errors=0,pending=null;  // pending: the inspection still running, see inspectOnce
 while(j.stage!=='done'&&!ended){
  try{
   await step();
   errors=0;save();
  }catch(e){
   if(e.permanent){j.error=e.message;finish('FAILED',`Abbruch: ${e.message}`);break;}
   errors++;j.lastError=e.message;save();
   const stuck=`Abnahme ${j.id} hängt nach ${errors} Fehlern (${e.message}); Journal ${journalPath(journalDir,j.id)} bleibt zum Fortsetzen erhalten.`;
   // After a protective Mängelrüge the inspection goes on in Disputed until the cure cutoff; one that still cannot run
   // then sends /dispute with the protective code instead of ending without it (DELTA-ENGINE-3).
   const disputedInspection=j.stage==='inspect'&&j.escrowState==='Disputed';
   if(disputedInspection&&now()>=cureCutoff()){
    j.pendingFailures=[{code:j.inspectError?.code??'ABN-PRUEFUNG',textDe:j.inspectError?.why??`Die Abnahmeprüfung ist nicht möglich (${e.message}).`}];j.stage='notify';errors=0;
    say(`Bis zur Frist für eine Nachbesserung (${time(cureCutoff())}) nicht geprüft. Sende die Mängelrüge [${j.pendingFailures[0].code}] an den RechnungsMeister.`);continue;
   }
   // The defect list can still reach the seller until its cure cutoff: /dispute is retried with backoff until then, so an
   // outage does not turn a curable defect into a refund (LB-1). The same holds for the inspection in Disputed.
   const deliverable=(j.stage==='notify'||disputedInspection)&&now()<cureCutoff();
   // Nothing bought yet: give up. No longer paid out on its own: stop, journal open. Else retry past unlockTime.
   if(errors>=12&&j.stage==='start')throw new Error(stuck);
   if(errors>=12&&!exposed()&&!deliverable){finish('FAILED',`ALARM: ${stuck} ${held()}`,{open:true});break;}
   if(exposed()&&j.startJob&&now()>unlock()+5*MINUTE){finish('FAILED',`ALARM: ${stuck} Die Freigabezeit ${time(unlock())} ist vorbei; die Escrow hat den RechnungsMeister möglicherweise ohne Abnahme ausgezahlt.`,{open:true});break;}
   await sleep(deliverable&&errors>12?Math.min(pollMs*2**(errors-12),6*pollMs):pollMs);
  }
 }
 // An inspection cut off at the decision deadline is still paid for: its verdict and tx are journaled before the run ends.
 await pending?.promise.catch(()=>{});
 await refreshTxs().catch(()=>{});save();
 return outcome(j);

 async function read(){const p=await escrow.getPurchase(bcid());if(p)j.escrowState=p.onChainState??null;return p;}
 async function refreshTxs(){
  const [purchase,payment]=await Promise.all([escrow.getPurchase(bcid()),escrow.getPayment(bcid())]);
  j.txs=[...escrowTxs(purchase,payment),...j.inspectionTxs];
  return purchase;
 }
 function permanent(message){const e=new Error(message);e.permanent=true;return e;}
 // MPS needs an operator (e.g. a tx it could not build): alarm once, then retry; each stage's deadline decides.
 function manualAction(p){
  if(p?.NextAction?.requestedAction!=='WaitingForManualAction')return;
  const note=p.NextAction.errorNote??p.NextAction.errorType??'ohne Angabe';
  if(j.manualAlarm!==note){j.manualAlarm=note;say(`ALARM: MPS verlangt manuelles Eingreifen (${note}). Betreiber: Kauf ${j.purchaseId} im Payment Service prüfen.`);}
  throw new Error(`MPS verlangt manuelles Eingreifen: ${note}`);
 }
 async function wait(){await sleep(pollMs);}
 // One inspection per delivery. A call cut off at the decision deadline keeps running and is awaited, not bought again;
 // its verdict is journaled when it arrives, a payment with its tx (DELTA-ENGINE-2). x402 payments are listed as not
 // charged only when certain (DELTA-ENGINE-4); buy.mjs gives no hash for those.
 function inspectOnce(xml,resultSha256){
  if(pending?.resultSha256===resultSha256)return pending.promise;
  const previous=pending?.promise.catch(()=>{});
  const promise=(async()=>{await previous;return inspect(xml,{scenario:acceptance.scenario});})().then(inspection=>{
   const n=j.inspectionTxs.length+1;
   if(inspection.txHash)j.inspectionTxs.push({label:inspection.mode==='x402'?`x402 inspection ${n}`:inspection.payment==='settled'?`x402 inspection ${n} (paid, report not used; local KoSIT)`:`x402 inspection ${n} (payment unconfirmed, local KoSIT)`,
    txHash:inspection.txHash,explorerUrl:explorerUrl(inspection.txHash)});
   j.inspected={resultSha256,inspection};save();return inspection;
  }).finally(()=>{if(pending?.promise===promise)pending=null;});
  promise.catch(()=>{});
  pending={resultSha256,promise};
  return promise;
 }
 // Protective Mängelrüge: without a passed inspection the escrow must not pay at unlockTime; inspection goes on in Disputed.
 function protect(code,why){
  j.pendingFailures=[{code,textDe:why}];j.protective=code;j.stage='dispute';
  say(`Vorsorgliche Mängelrüge [${code}]: ${why} Ohne bestandene Prüfung zahlt die Escrow nicht aus; geprüft wird im Streitfall weiter.`);
 }

 async function step(){
  switch(j.stage){
   case 'start':{
    const r=await rm.startJob({identifier_from_purchaser:j.nonce,input_data:input});
    if(r.httpStatus>=500||r.httpStatus===409||r.httpStatus===429)throw new Error(`start_job HTTP ${r.httpStatus}: ${r.body.error}`);
    if(r.httpStatus!==200)throw permanent(`RechnungsMeister lehnt den Auftrag ab (HTTP ${r.httpStatus}: ${r.body.error})`);
    const s=r.body;
    if(s.input_hash!==j.inputHash)throw permanent(`Eingabe-Hash des RechnungsMeisters ${s.input_hash} weicht vom eigenen ${j.inputHash} ab`);
    // The seller gives the token out in its first answer only (a crash before this journal save loses it): without it
    // there is no /status result and no /dispute, so nothing is bought (DELTA-SELLER-1).
    if(!/^[0-9a-f]{64}$/.test(s.job_token??''))throw permanent('Der RechnungsMeister hat kein Job-Token geliefert (es wird nur in der ersten Antwort ausgegeben); ohne es sind Ergebnis und Mängelrüge nicht möglich, es wurde nichts gekauft');
    if(JSON.stringify(s.amounts)!==JSON.stringify([{amount:'1000000',unit:USDM}]))throw permanent(`Preis ${JSON.stringify(s.amounts)} ist nicht 1 tUSDM`);
    if(Number(s.payByTime)<now()+MINUTE)throw permanent('Zahlungsfrist ist schon abgelaufen');
    const submitAt=Number(s.submitResultTime),unlockAt=Number(s.unlockTime),externalAt=Number(s.externalDisputeUnlockTime);
    if(!(submitAt<=now()+MAX_WINDOW&&unlockAt-submitAt<=MAX_WINDOW&&externalAt-unlockAt<=MAX_WINDOW))throw permanent(`Die Fristen des Angebots (Ergebnis bis ${iso(submitAt)}, Freigabe ab ${iso(unlockAt)}, Schlichtung ab ${iso(externalAt)}) sind länger als vereinbart oder ungültig`);
    j.startJob=s;j.stage='purchase';
    say(`Angebot von RechnungsMeister (Auftrag ${s.job_id??s.id}): 1 tUSDM, Ergebnis bis ${time(s.submitResultTime)}, Freigabe ab ${time(s.unlockTime)}. Eingabe-Hash geprüft.`);
    return;
   }
   case 'purchase':{
    let p=await read();
    if(!p){
     if(j.profileHash!==profileHash)throw permanent(`Das Prüfprofil wurde seit dem Angebot geändert (${j.profileHash.slice(0,12)}… → ${profileHash.slice(0,12)}…); es wurde nichts gekauft`);
     if(now()>Number(j.startJob.payByTime))throw permanent('Zahlungsfrist abgelaufen, bevor gekauft wurde');
     p=await escrow.purchase(j.startJob,{inputHash:j.inputHash,nonce:j.nonce,metadata:JSON.stringify({abnahmeJournal:j.id})});
    }
    j.purchaseId=p.id;j.stage='wait-locked';
    say('Kauf an den Masumi Payment Service übergeben; 1 tUSDM wird in der Escrow auf Cardano gesperrt.');
    return;
   }
   case 'wait-locked':{
    const p=await read();
    if(p&&confirmed(p,'FundsLocked')){j.purchaseId=p.id;j.stage='wait-result';say('Geld gesperrt (FundsLocked). Der RechnungsMeister liest jetzt die Rechnung aus und erstellt die XRechnung; warte auf das Ergebnis.');return;}
    // MPS builds the lock with a validity that ends at payByTime: a lock still unseen 15 min later did not happen.
    if(now()>Number(j.startJob.payByTime)+15*MINUTE)throw permanent('Die Sperrung wurde bis zur Zahlungsfrist nicht bestätigt');
    manualAction(p);
    return wait();
   }
   case 'wait-result':{
    const p=await read();
    const state=j.round===0?'ResultSubmitted':'Disputed';
    if(p.onChainState===state&&p.resultHash&&p.resultHash!==j.lastResultHash&&p.CurrentTransaction?.status==='Confirmed'){
     j.stage='inspect';say(j.round===0?'Ergebnis auf Cardano eingereicht (ResultSubmitted). Starte die Abnahmeprüfung.':`Nachbesserung ${j.round} auf Cardano eingereicht. Prüfe erneut.`);return;
    }
    if(j.round===0){
     if(['RefundWithdrawn','RefundAuthorized'].includes(p.onChainState))return finish('FAILED',`Escrow ${p.onChainState}: der RechnungsMeister hat nicht geliefert, das Geld geht zurück.`);
     // MPS refunds 10 min after submitResultTime; until then a late result may still show up in MPS.
     if(now()>unlock()+5*MINUTE)return finish('FAILED',`Kein Ergebnis bis zur Frist; die Rückerstattung ist noch nicht bestätigt (Escrow ${p.onChainState}).`);
    }else{
     const st=await rm.status(jobId(),token()).catch(()=>null);
     if(['refund-authorized','refund-pending'].includes(st?.body?.phase)||p.onChainState==='RefundAuthorized'){j.stage='wait-refund';say('Der RechnungsMeister gibt die Rückerstattung frei.');return;}
     // No cure in time: the next round asks the seller for its AuthorizeRefund instead of leaving the money frozen.
     if(now()>j.cureDeadline){j.pendingFailures=[{code:'ABN-FRIST',textDe:`Keine Nachbesserung bis ${time(j.cureDeadline)} auf Cardano bestätigt.`}];j.stage='notify';say('Keine Nachbesserung innerhalb der Frist. Fordere beim RechnungsMeister die Rückerstattung an.');return;}
    }
    manualAction(p);
    return wait();
   }
   case 'inspect':{
    const p=await read();
    const disputed=p.onChainState==='Disputed',canDispute=()=>!disputed&&now()<unlock()-LAST_DISPUTE;
    // Not inspected: retry; from INSPECT before the decision deadline (or at once, urgent) file the protective Mängelrüge;
    // too late for one, the escrow pays out at unlockTime.
    const notInspected=(code,why,urgent=false)=>{
     j.inspectError={code,why};
     if(canDispute()&&(urgent||now()>=unlock()-DECIDE-INSPECT))return protect(code,why);
     if(!disputed&&!canDispute()&&now()>unlock())return finish('FAILED',`Nicht geprüft: ${why} ${paidOut()}`,{paidWithoutAcceptance:true});
     throw new Error(why);
    };
    if(j.profileHash!==profileHash)return notInspected('ABN-PRUEFUNG',`Das Prüfprofil wurde seit dem Kauf geändert (vereinbart ${j.profileHash.slice(0,12)}…, jetzt ${profileHash.slice(0,12)}…); gegen das vereinbarte kann nicht mehr geprüft werden.`,true);
    if(canDispute()&&now()>=unlock()-DECIDE-INSPECT)return protect(j.inspectError?.code??'ABN-PRUEFUNG',j.inspectError?.why??`Das Ergebnis kann vor ${time(unlock()-DECIDE)} nicht mehr sicher geprüft werden.`);
    const st=await rm.status(jobId(),token()).catch(e=>({httpStatus:null,body:{error:e.message}}));
    if(st.httpStatus!==200)return notInspected('ABN-LIEFERUNG',`Der RechnungsMeister liefert das Ergebnis nicht aus (${st.httpStatus?`HTTP ${st.httpStatus}`:st.body.error}).`);
    const contract=p.PaymentSource?.smartContractAddress??j.startJob.smartContractAddress;
    let chainHash=null,hashSource='MPS';
    // This escrow's own datum; while Blockfrost fails, wait for it as long as a dispute is still possible.
    try{chainHash=await escrow.chainResultHash(p.CurrentTransaction?.txHash,contract,{inputHash:j.inputHash});if(chainHash)hashSource='Datum (Blockfrost)';}
    catch(e){if(canDispute())return notInspected('ABN-PRUEFUNG',`Der Ergebnis-Hash im Datum auf Cardano ist nicht lesbar (${e.message}).`);hashSource=`MPS (Blockfrost: ${e.message})`;}
    const onChainHash=chainHash??p.resultHash;
    const delivery=verifyDelivery({result:st.body.result,nonce:j.nonce,onChainHash,profileHash});
    if(chainHash&&chainHash!==p.resultHash)delivery.failures.push({code:'ABN-HASH',textDe:'Der Ergebnis-Hash im Datum auf Cardano weicht vom Stand des Payment Service ab.'});
    let kosit=null,checks={failures:[],minor:[]},inspection=null;
    if(delivery.xml){
     // A paid verdict for this delivery is journaled at once and reused after a restart.
     const resultSha256=sha256(st.body.result);
     if(j.inspected?.resultSha256===resultSha256)inspection=j.inspected.inspection;
     else{
      // While the escrow can still pay out on its own, the verdict must be in by the decision deadline; a slower one (a
      // held x402 call, a second PRÜFEN queued behind it) gets the protective Mängelrüge and is used in Disputed.
      const deadline=canDispute()?timer(unlock()-DECIDE-now()):null;
      try{inspection=await (deadline?Promise.race([inspectOnce(delivery.xml,resultSha256),deadline.promise.then(()=>null)]):inspectOnce(delivery.xml,resultSha256));}
      catch(e){return notInspected('ABN-PRUEFUNG',`Die Abnahmeprüfung ist nicht möglich (${e.message}).`);}
      finally{deadline?.cancel();}
      if(!inspection)return notInspected('ABN-PRUEFUNG',`Die Abnahmeprüfung ist bis ${time(unlock()-DECIDE)} nicht abgeschlossen.`,true);
     }
     kosit=inspection.kosit;
     checks=runChecks({xml:delivery.xml,kosit,acceptance,recipient,expectedTotal:total});
     // The Büro refuses to send this number later; refuse it now, while the money can still be withheld.
     try{invoiceNumberOf(delivery.xml);}catch(e){checks.failures.push({code:'ABN-BT1',textDe:e.message});}
     j.lastXml=delivery.xml;j.lastKositReport=kosit.reportXml;
    }
    const failures=[...delivery.failures,...checks.failures];
    const passed=!!kosit?.accepted&&!failures.length;
    j.lastResultHash=p.resultHash;
    j.attempts.push({round:j.round,attempt:delivery.manifest?.attempt??null,onChainHash,hashSource,passed,failures,minor:checks.minor.map(m=>m.code),inspection:inspection&&{mode:inspection.mode,txHash:inspection.txHash,note:inspection.note,httpStatus:kosit.httpStatus,scenario:kosit.scenario}});
    say(`Prüfung ${j.attempts.length} (${inspection?.mode==='x402'?'Gutachter über x402, 1 tADA':'lokaler KoSIT-Prüfer'}${inspection?.note?`, ${x402NoteDe(inspection.note)}`:''}): Ergebnis-Hash (${hashSource}) ${delivery.failures.some(f=>f.code==='ABN-HASH')?'stimmt NICHT':'stimmt'}, KoSIT ${kosit?(kosit.accepted?'akzeptiert':'abgelehnt'):'nicht geprüft'}.`);
    if(passed){
     if(!disputed)return finish('ACCEPTED',`ABGENOMMEN. Die Escrow zahlt den RechnungsMeister automatisch nach der Freigabezeit (${time(j.startJob.unlockTime)}) aus.`);
     j.stage='accept';say(`${j.round?'Nachbesserung':'Lieferung'} besteht die Abnahme. Gebe die Zahlung frei (AuthorizeWithdrawal).`);return;
    }
    say(`Mängel: ${failures.map(f=>`[${f.code}] ${f.textDe}`).join(' ')}`);
    if(j.disputes>=MAX_DISPUTES){j.stage='wait-refund';say('Rechnung abgelehnt: auch nach Nachbesserung mangelhaft. Die Escrow bleibt gesperrt, bis der RechnungsMeister erstattet.');return;}
    j.pendingFailures=failures;j.stage=disputed?'notify':'dispute';return;
   }
   case 'dispute':{
    const p=await read();
    if(p.onChainState==='Disputed'||p.NextAction?.requestedAction==='SetRefundRequestedRequested'){j.stage='wait-disputed';return;}
    if(['RefundAuthorized','RefundWithdrawn'].includes(p.onChainState)){j.stage='wait-refund';return;}
    if(now()>=unlock()-LAST_DISPUTE)return finish('FAILED',`Mangel festgestellt, aber die Frist für die Mängelrüge (bis ${time(unlock()-LAST_DISPUTE)}) ist abgelaufen. ${paidOut()}`,{paidWithoutAcceptance:true});
    manualAction(p);
    if(p.onChainState==='ResultSubmitted'&&p.NextAction?.requestedAction==='WaitingForExternalAction'){
     await escrow.requestRefund(bcid());j.stage='wait-disputed';say('Mängelrüge auf Cardano: Rückerstattung verlangt, die Escrow geht in den Streitfall (Disputed).');return;
    }
    return wait();
   }
   case 'wait-disputed':{
    const p=await read();
    if(p.onChainState==='Disputed'&&confirmed(p,'Disputed')&&p.NextAction?.requestedAction==='WaitingForExternalAction'){
     const next=j.protective?'inspect':'notify';delete j.protective;j.stage=next;
     say(next==='notify'?'Streitfall bestätigt (Disputed). Das Geld ist eingefroren. Sende das Prüfprotokoll an den RechnungsMeister.':'Streitfall bestätigt (Disputed). Das Geld ist eingefroren; die Abnahmeprüfung geht weiter.');return;
    }
    // MPS no longer builds the request within 3 min of unlockTime: say so while the seller is not paid yet.
    if(now()>unlock()-3*MINUTE&&!j.disputeAlarm){j.disputeAlarm=true;say(`ALARM: Die Mängelrüge ist 3 Minuten vor der Freigabezeit (${time(unlock())}) nicht auf Cardano bestätigt (MPS: ${p.onChainState}, ${p.NextAction?.requestedAction}); der Payment Service reicht sie nicht mehr ein.`);}
    if(now()>unlock()+5*MINUTE)return finish('FAILED',`Die Mängelrüge hat Cardano nicht vor der Freigabezeit erreicht. ${paidOut()}`,{paidWithoutAcceptance:true});
    manualAction(p);
    return wait();
   }
   case 'notify':{
    // No round beyond MAX_DISPUTES: a seller that announces cures it never submits gets no further round; the refund is
    // waited for, then the frozen-money alarm ends the run (DELTA-ENGINE-1).
    if(j.disputes>=MAX_DISPUTES){j.stage='wait-refund';say(`Keine weitere Mängelrüge nach ${MAX_DISPUTES} Runden ohne bestandene Nachbesserung. Die Escrow bleibt gesperrt, bis der RechnungsMeister erstattet.`);return wait();}
    const round=j.disputes+1;
    const r=await rm.dispute({jobId:jobId(),round,failures:j.pendingFailures.map(({code,textDe})=>({code,textDe})),kositReport:j.lastKositReport??null},token());
    // Only a cure or the seller's refund (422 cure-rejected comes after its AuthorizeRefund) ends a round; anything
    // else (busy, unauthorized, down) is retried.
    const refunded=r.httpStatus===422||r.body?.status==='refund-authorized';
    if(!refunded&&!(r.httpStatus===200&&r.body?.status==='cure-submitted'))throw new Error(`dispute HTTP ${r.httpStatus}: ${r.body?.error??r.body?.status}`);
    j.disputes=round;
    if(!refunded){
     j.round++;j.cureDeadline=Math.min(Number(j.startJob.externalDisputeUnlockTime)-5*MINUTE,now()+20*MINUTE);j.stage='wait-result';
     const patch=Object.entries(r.body.patch??{}).map(([k,v])=>`${k} = ${v} (Quelle: ${r.body.sources?.[k]})`).join(', ');
     say(`RechnungsMeister bessert nach (Versuch ${r.body.attempt})${patch?`: ${patch}`:''}.`);return;
    }
    j.stage='wait-refund';
    say(`Rechnung abgelehnt. Der RechnungsMeister kann nicht nachbessern (${(r.body.reasons??[r.body.error]).join(' ')}) und gibt die Rückerstattung frei.`);return;
   }
   case 'wait-refund':{
    // A refusal ends only when the seller's AuthorizeRefund is on chain; until then the money is frozen in Disputed.
    const p=await read();
    if(['RefundAuthorized','RefundWithdrawn'].includes(p.onChainState)&&confirmed(p,p.onChainState)){
     // MPS 0.29.0 does not collect a refund whose resultHash is set (upstream #1327); mps/refund-repair.mjs does (LB2-4).
     const stale=p.onChainState==='RefundAuthorized'&&p.resultHash?' Sie wird automatisch ausgezahlt (Workaround für Masumi #1327).':'';
     return finish('REFUSED',`Rechnung abgelehnt. Rückerstattung auf Cardano freigegeben (${p.onChainState}); das Geld geht an das Büro zurück.${stale}`);
    }
    j.refundUntil??=now()+20*MINUTE;
    if(now()>j.refundUntil)return finish('REFUSED',`ALARM: Rechnung abgelehnt, aber die Rückerstattung ist nach 20 Minuten nicht auf Cardano. ${held()}`,{open:true});
    return wait();
   }
   case 'accept':{
    const p=await read();manualAction(p);
    if(['WithdrawAuthorized','Withdrawn'].includes(p.onChainState)||p.NextAction?.requestedAction==='AuthorizeWithdrawalRequested'){j.stage='wait-withdrawn';j.acceptedAt??=now();return;}
    if(['RefundAuthorized','RefundWithdrawn'].includes(p.onChainState)){j.stage='wait-refund';say('Der RechnungsMeister hat vor der Freigabe erstattet.');return;}
    if(p.onChainState==='Disputed'&&p.NextAction?.requestedAction==='WaitingForExternalAction'){
     // AuthorizeWithdrawal copies whatever result_hash the escrow holds now: release only the inspected one.
     let chainHash=null;
     try{chainHash=await escrow.chainResultHash(p.CurrentTransaction?.txHash,p.PaymentSource?.smartContractAddress??j.startJob.smartContractAddress,{inputHash:j.inputHash});}catch{}
     if(p.resultHash!==j.lastResultHash||chainHash&&chainHash!==j.attempts.at(-1)?.onChainHash){j.stage='inspect';say('Das Ergebnis in der Escrow wurde nach der Prüfung geändert; es wird erst geprüft, dann freigegeben.');return;}
     await escrow.cancelRefundRequest(bcid());j.acceptedAt=now();j.stage='wait-withdrawn';say('Freigabe auf Cardano beauftragt (cancel-refund-request → AuthorizeWithdrawal).');return;
    }
    j.acceptSince??=now();
    if(now()>j.acceptSince+25*MINUTE)return finish('FAILED',`ALARM: Die Lieferung ist abgenommen, aber der Payment Service nimmt die Freigabe seit 25 Minuten nicht an (Escrow ${p.onChainState}, ${p.NextAction?.requestedAction}). ${held()}`,{open:true});
    return wait();
   }
   case 'wait-withdrawn':{
    const p=await read();
    if(p.onChainState==='Withdrawn')return finish('ACCEPTED','ABGENOMMEN. Der RechnungsMeister hat die Zahlung aus der Escrow erhalten (Withdrawn).');
    if(p.onChainState==='WithdrawAuthorized'&&!j.withdrawAuthorizedSeen){
     j.withdrawAuthorizedSeen=true;say('Zahlung freigegeben (WithdrawAuthorized). Warte auf die Auszahlung an den RechnungsMeister.');
     if(p.resultHash&&p.resultHash!==j.lastResultHash)say(`WARNUNG: Die Freigabe auf Cardano trägt den Ergebnis-Hash ${p.resultHash.slice(0,12)}…, abgenommen wurde ${String(j.lastResultHash).slice(0,12)}…; gültig bleibt die abgenommene XML.`);
    }
    if(now()>j.acceptedAt+25*MINUTE){
     if(j.withdrawAuthorizedSeen)return finish('ACCEPTED','ABGENOMMEN. Zahlung freigegeben (WithdrawAuthorized); die Auszahlung an den RechnungsMeister steht noch aus.');
     // The buyer has accepted; MPS keeps the AuthorizeWithdrawal queued and may still build it.
     return finish('ACCEPTED',`ABGENOMMEN. Die Freigabe ist beauftragt, nach 25 Minuten auf Cardano aber noch nicht bestätigt (Escrow ${p.onChainState}, MPS ${p.NextAction?.requestedAction}). Betreiber: Kauf ${j.purchaseId} im Payment Service prüfen.`);
    }
    return wait();
   }
   case 'follow':{
    // Optional: keep watching until the escrow pays out, to record the final txs.
    const p=await read();
    if(['Withdrawn','RefundWithdrawn','DisputedWithdrawn'].includes(p.onChainState)){
     j.stage='done';say(`Escrow abgeschlossen: ${p.onChainState}.`);
     // The seller may replace result_hash in ResultSubmitted until externalDisputeUnlockTime, after the buyer's window.
     if(p.onChainState==='Withdrawn'&&j.lastResultHash&&p.resultHash&&p.resultHash!==j.lastResultHash)say(`WARNUNG: Ausgezahlt wurde für Ergebnis-Hash ${p.resultHash.slice(0,12)}…, abgenommen war ${j.lastResultHash.slice(0,12)}…; gültig bleibt die abgenommene XML.`);
     return;
    }
    j.followUntil??=j.status==='ACCEPTED'&&j.round===0?Number(j.startJob.unlockTime)+25*MINUTE:now()+40*MINUTE;
    if(now()>j.followUntil){j.stage='done';say(`Escrow noch ${p.onChainState}; Beobachtung beendet.`);return;}
    return wait();
   }
   default:throw permanent(`Unbekannter Schritt ${j.stage}`);
  }
 }
}
