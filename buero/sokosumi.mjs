// Büro-Agent behind the Sokosumi Coworker "Abnahme-Büro". Two Task types, chosen by the first line:
//   PRÜFEN (unpaid): "Empfänger: <profil>" + "Betrag: <brutto>" directly below the first line, then the invoice text
//     → runAbnahme → Abnahmeprotokoll.
//   SENDEN <Rechnungsnummer> (paid): only for an invoice a completed PRÜFEN Task of the same user accepted; e-mails the
//     accepted XML once (Doppelversand gesperrt), and never a second invoice for the same supply (§ 14c UStG).
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {sendMail as smtpSend,probeSmtp} from '../mail/smtp.mjs';
import {AP_INBOX,SENDER} from '../mail/recipients.mjs';
import {loadSokosumiRuntime} from '../sokosumi-runtime.mjs';
import {verifyRuntimeTask} from '../task-target.mjs';
import {invoiceFacts} from '../verifier/checks.mjs';
import {parseXml} from '../verifier/xml.mjs';

export const SEND_PRICE_DE='Senden: kostenpflichtig, Sokosumi bucht dafür Credits (Escrow 1 tUSDM); nur für abgenommene Rechnungen';
export const MAX_TASK_CHARS=16000;  // same cap as the template's answer() and RechnungsMeister's invoice text
export const sha256=text=>createHash('sha256').update(text,'utf8').digest('hex');
const euro=n=>Number(n).toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2})+' €';
const dateDe=d=>d.toLocaleDateString('de-DE',{timeZone:'Europe/Berlin',day:'2-digit',month:'2-digit',year:'numeric'});
const timeDe=d=>`${new Date(d).toLocaleString('de-DE',{timeZone:'Europe/Berlin',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})} Uhr`;
// Public holidays at the place of payment (Munich), 2026-2027: Art. 1 Abs. 1 Bayerisches Feiertagsgesetz (FTG), with
// 15 August, which counts in predominantly Catholic municipalities such as Munich; Easter Sunday is 5 Apr 2026 and
// 28 Mar 2027. From 2028 only weekends are skipped until the list is extended.
const HOLIDAYS_MUNICH=new Set(['2026-01-01','2026-01-06','2026-04-03','2026-04-06','2026-05-01','2026-05-14','2026-05-25','2026-06-04','2026-08-15','2026-10-03','2026-11-01','2026-12-25','2026-12-26',
 '2027-01-01','2027-01-06','2027-03-26','2027-03-29','2027-05-01','2027-05-06','2027-05-17','2027-05-27','2027-08-15','2027-10-03','2027-11-01','2027-12-25','2027-12-26']);
// Calendar days on the Berlin date, so a DST change cannot move the result by a day; then § 193 BGB: a last day on a
// Saturday, Sunday or public holiday moves to the next working day.
const dueDateDe=(d,days)=>{
 const [day,month,year]=dateDe(d).split('.').map(Number),due=new Date(Date.UTC(year,month-1,day+days,12));
 while([0,6].includes(due.getUTCDay())||HOLIDAYS_MUNICH.has(due.toISOString().slice(0,10)))due.setUTCDate(due.getUTCDate()+1);
 return dateDe(due);
};
// Pasted text: NFC (macOS pastes NFD umlauts), no zero-width characters; quotes around a copied „SENDEN …“ line.
const normalize=text=>String(text??'').normalize('NFC').replace(/[​-‍⁠﻿]/gu,'');
const QUOTES=/^[\s„“”"‚‘’'»«]+|[\s„“”"‚‘’'»«]+$/gu;
const firstLine=description=>normalize(description).trim().split(/\r?\n/u)[0].replace(QUOTES,'');

export function parseAmount(text){
 let s=String(text).replace(/€|EUR/giu,'').replace(/\s/gu,'');
 if(/,\d{1,2}$/u.test(s))s=s.replace(/\./gu,'').replace(',','.');
 else if(/^\d{1,3}(\.\d{3})+$/u.test(s))s=s.replace(/\./gu,'');
 const n=/^\d+(\.\d{1,2})?$/u.test(s)?Number(s):NaN;
 if(!(n>0))throw new Error(`Betrag „${text}“ ist kein gültiger Bruttobetrag (z. B. 18.400,00).`);
 return n;
}

export function parseTask(description){
 const raw=String(description??'');
 if(raw.length>MAX_TASK_CHARS)throw new Error(`Der Auftrag ist zu lang (${raw.length.toLocaleString('de-DE')} Zeichen; höchstens ${MAX_TASK_CHARS.toLocaleString('de-DE')}).`);
 const lines=normalize(raw).trim().split(/\r?\n/u);
 const first=lines[0].trim().replace(QUOTES,'');
 const senden=/^SENDEN(?:\s+(.*))?$/iu.exec(first);
 if(senden){
  const invoiceNumber=(senden[1]??'').replace(QUOTES,'');
  if(!invoiceNumber)throw new Error('Nach „SENDEN“ fehlt die Rechnungsnummer (z. B. SENDEN AR-2026-0087).');
  return {kind:'SENDEN',invoiceNumber};
 }
 if(!/^PR(Ü|UE)FEN\b/iu.test(first))return {kind:'UNKNOWN'};
 // Control lines only in the block directly below the first line: a line inside the invoice can neither set nor
 // hide the reference values, and the invoice text stays as pasted.
 let recipientProfileId,expectedTotal,i=1;
 for(;i<lines.length;i++){
  const r=/^\s*Empf(ä|ae)nger\s*:\s*(.*?)\s*$/iu.exec(lines[i]),b=/^\s*Betrag\s*:\s*(.+?)\s*$/iu.exec(lines[i]);
  if(r){if(recipientProfileId!==undefined)throw new Error('Die Zeile „Empfänger:“ ist doppelt. Bitte nur eine angeben.');recipientProfileId=r[2];}
  else if(b){if(expectedTotal!==undefined)throw new Error('Die Zeile „Betrag:“ ist doppelt. Bitte nur eine angeben.');expectedTotal=parseAmount(b[1]);}
  else break;
 }
 if(recipientProfileId===undefined)throw new Error(`Die Zeile „Empfänger: ${Object.keys(AP_INBOX).join('|')}“ fehlt direkt unter der ersten Zeile.`);
 if(!Object.hasOwn(AP_INBOX,recipientProfileId))throw new Error(`Das Empfängerprofil „${recipientProfileId}“ ist unbekannt. Bekannt: ${Object.keys(AP_INBOX).join(', ')}.`);
 if(expectedTotal===undefined)throw new Error('Die Zeile „Betrag: <Bruttobetrag>“ fehlt direkt unter der ersten Zeile (z. B. Betrag: 18.400,00).');
 const invoiceText=lines.slice(i).join('\n').trim();
 if(!invoiceText)throw new Error('Der Rechnungstext fehlt.');
 return {kind:'PRUEFEN',recipientProfileId,expectedTotal,invoiceText};
}
export const isSenden=description=>/^SENDEN(\s|$)/iu.test(firstLine(description));
// The input checks pruefen() makes before anything runs. They cost nothing, so the worker makes them before its queue too.
export function pruefenJob(input){
 const job=parseTask(input);
 if(job.kind==='SENDEN')throw new Error('SENDEN-Aufträge laufen nur über den bezahlten Ablauf.');
 if(job.kind!=='PRUEFEN')throw new Error('Unbekannter Auftrag. Die erste Zeile muss „PRÜFEN“ oder „SENDEN <Rechnungsnummer>“ sein.');
 return job;
}

// BT-1, read by the verifier's strict XML reader (Invoice/cbc:ID by namespace path, as KoSIT reads it).
// It becomes the store key, the SENDEN line, the subject and the attachment name: one printable line, no quotes.
export function invoiceNumberOf(xml){
 let n;try{n=invoiceFacts(xml).invoiceNumber}catch(e){throw new Error(`Rechnungsnummer (BT-1) nicht lesbar: ${e.message}.`)}
 if(!n)throw new Error('Rechnungsnummer (BT-1) nicht im XML gefunden.');
 if(!/^[\p{L}\p{N}][\p{L}\p{N} ._/#&+()-]*$/u.test(n))throw new Error(`Die Rechnungsnummer (BT-1) ${JSON.stringify(n).slice(0,80)} enthält Zeichen, die der Büro-Agent nicht versenden kann. Erlaubt sind Buchstaben, Ziffern, Leerzeichen und . _ - / # & + ( ).`);
 return n;
}
// Same supply: same AP inbox, same lines (quantity, net, price) and same Leistungsdatum (BT-72, BG-14 or BG-26, else the
// issue date). BT-1 and the payment reference do not count, a re-issue under a new number changes them; nor does the
// free-text line name, which a second conversion of the same text may word differently. Read by namespace path with the
// verifier's strict reader, as KoSIT reads it: another prefix, CDATA or a copy inside an extension change nothing (DELTA-VERIFIER-3).
const UBL={cac:'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',cbc:'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2'};
const select=(el,path)=>path.split('/').reduce((set,step)=>{const [p,name]=step.split(':');return set.flatMap(e=>e.children.filter(c=>c.ns===UBL[p]&&c.name===name));},[el]);
const texts=(el,path)=>select(el,path).map(e=>e.text.trim());
const number=v=>v===undefined?'':String(Number(v));  // 238.00 and 238 are the same amount
export function supplyKey(xml,to){
 const doc=parseXml(xml);
 const lines=select(doc,'cac:InvoiceLine').map(l=>['cbc:InvoicedQuantity','cbc:LineExtensionAmount','cac:Price/cbc:PriceAmount'].map(p=>number(texts(l,p)[0])).join('|')).sort();
 const period=[...new Set(['cac:Delivery/cbc:ActualDeliveryDate','cac:InvoicePeriod/cbc:StartDate','cac:InvoicePeriod/cbc:EndDate',
  'cac:InvoiceLine/cac:InvoicePeriod/cbc:StartDate','cac:InvoiceLine/cac:InvoicePeriod/cbc:EndDate'].flatMap(p=>texts(doc,p)))].sort();
 return sha256(JSON.stringify({to,lines,period:period.length?period:texts(doc,'cbc:IssueDate')}));
}
const facts=xml=>{try{return invoiceFacts(xml)}catch{return {taxSubtotals:[]}}};
const vatShown=xml=>facts(xml).taxSubtotals.some(t=>Number(t.tax)>0);
const typeCode=xml=>facts(xml).invoiceType;
// Where the escrow refund of a REFUSED run stands, read from its txs (labels from escrow.mjs). MPS 0.29.0 does not
// collect a refund whose resultHash is set (upstream #1327); the refund-repair loop (mps/refund-repair.mjs) completes it.
function refundDe(r){
 const has=label=>(r.txs??[]).some(t=>t.label===label);
 if(!r.purchaseId)return 'Es fallen keine Kosten an.';  // local check: no escrow, nothing was paid
 if(has('RefundWithdrawn'))return 'Rückerstattung abgeschlossen (RefundWithdrawn): die 1 tUSDM sind aus der Escrow an das Büro zurückgegangen.';
 if(has('AuthorizeRefund'))return 'Rückerstattung freigegeben (AuthorizeRefund auf Cardano); sie wird automatisch ausgezahlt (Workaround für Masumi #1327): die 1 tUSDM gehen aus der Escrow an das Büro zurück.';
 return 'Die Rückerstattung ist noch nicht auf Cardano: die 1 tUSDM bleiben in der Escrow gesperrt, der RechnungsMeister wird ohne Freigabe des Büros nicht bezahlt. Ein Betreiber schließt die Rückerstattung ab.';
}
const smtpErrorDe=e=>/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET/u.test(e.message)?'Postausgang (SMTP) nicht erreichbar':/timeout/iu.test(e.message)?'Zeitüberschreitung beim Postausgang (SMTP)'
 :/^SMTP message refused: /u.test(e.message)?`Der Postausgang (SMTP) hat die Nachricht abgelehnt: ${e.message.slice(22,222)}`:e.message;

export function txTableDe(txs){
 if(!txs?.length)return 'Transaktionen: keine (lokale Prüfung ohne Escrow-Kauf).';
 return ['Transaktionen (Cardano preprod):','| Schritt | Tx | Explorer |','|---|---|---|',
  ...txs.map(t=>`| ${t.label} | ${t.txHash?`\`${t.txHash}\``:'–'} | ${t.explorerUrl??'–'} |`)].join('\n');
}

export function createBuero({runAbnahme,send=smtpSend,probe=probeSmtp,dir='.local',now=()=>new Date()}){
 const acceptedPath=`${dir}/abnahmen.json`,ledgerPath=`${dir}/sent-ledger.json`;
 const read=(path,empty)=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')):empty;
 // Write and rename: a crash leaves the old or the new file, never a torn one.
 const write=(path,value)=>{writeFileSync(`${path}.tmp`,JSON.stringify(value,null,1),{mode:0o600});renameSync(`${path}.tmp`,path);};
 const xmlOf=sha=>{const p=`${dir}/abnahmen/${sha}.xml`;return existsSync(p)?readFileSync(p,'utf8'):null;};
 // The stored XML decides, so entries keyed by the old regex reader still count; the saved key only without the XML.
 const keyOf=e=>{const xml=xmlOf(e.xmlSha256);return xml===null?e.supplyKey??null:supplyKey(xml,e.to);};
 const refuse=reasonDe=>({ok:false,reasonDe});
 const outcome=e=>e.status==='sent'?`am ${timeDe(e.sentAt)} versendet (Message-ID ${e.messageId})`
  :`im Versand mit ungeklärtem Ausgang${e.messageId?` (Message-ID ${e.messageId})`:''}. Bitte Postfach prüfen; danach kann der Betreiber den Eintrag als versendet oder nicht versendet klären`;
 const sentText=(e,accepted,xml)=>[`Versendet: XRechnung ${e.invoiceNumber} an ${e.to} (Empfängerprofil ${accepted.recipientProfileId}).`,
  `Message-ID: ${e.messageId}`,`SMTP-Antwort: ${e.smtpReply}`,`XML sha256: ${e.xmlSha256}`,`Versandzeit: ${timeDe(e.sentAt)}`,
  ...(typeCode(xml)==='875'?[`Fälligkeit: Eine Abschlagsforderung nach VOB/B § 16 Abs. 1 Nr. 3 wird 21 Tage nach Zugang fällig; bei Zugang heute am ${dueDateDe(new Date(e.sentAt),21)} (§ 193 BGB: fällt Tag 21 auf ein Wochenende oder einen Feiertag in München, gilt der nächste Werktag).`]:[]),
  'Der Zugang beim Empfänger ist damit nicht bewiesen.',
  'Doppelversand gesperrt: Rechnungsnummer und XML-Hash sind jetzt gesperrt; ein zweites SENDEN wird abgelehnt.',
  `Eine weitere Rechnung für dieselbe Leistung unter neuer Nummer wird ebenfalls abgelehnt${vatShown(xml)?' (§ 14c UStG: sie würde die ausgewiesene Umsatzsteuer ein zweites Mal schulden)':''}.`,
  `Abgenommen in PRÜFEN-Aufgabe ${accepted.taskId} am ${timeDe(accepted.acceptedAt)}.`].join('\n');

 async function pruefen({taskId,userId=null,input,onProgress=async()=>{}}){
  const job=pruefenJob(input);
  const progress=async text=>{try{await onProgress(text)}catch(e){console.error('Progress comment failed',taskId,e.message.slice(0,200))}};
  await progress(`Prüfung gestartet: Empfängerprofil ${job.recipientProfileId}, erwarteter Bruttobetrag ${euro(job.expectedTotal)}. Die Prüfung ist kostenlos.`);
  const r=await runAbnahme({invoiceText:job.invoiceText,recipientProfileId:job.recipientProfileId,expectedTotal:job.expectedTotal,onProgress:progress});
  if(r?.status==='REFUSED'){
   // A refusal supersedes an earlier acceptance of the same number: SENDEN must not mail the older version. It is kept
   // also without one, so a SENDEN for this number says it was refused (LANE-A2-7).
   let n;try{n=typeof r.xml==='string'?invoiceNumberOf(r.xml):null}catch{n=null}
   const store=read(acceptedPath,{});
   if(n){store[n]={taskId,userId,refused:true,refusedAt:now().toISOString()};write(acceptedPath,store);}
   return [r.protocolDe,'',txTableDe(r.txs),'',`Nicht abgenommen. ${refundDe(r)} Bitte die Mängel beheben und erneut PRÜFEN.`].join('\n');
  }
  // journalId lets the worker resume an escrow run whose journal is still open.
  if(r?.status!=='ACCEPTED')throw Object.assign(new Error(`Prüfung fehlgeschlagen. ${r?.protocolDe??'Kein Ergebnis.'}`),{journalId:r?.journalId});
  // After ACCEPTED the seller is paid: answer with the protocol, never with FAILED (STATEMACHINE-2).
  let invoiceNumber;
  try{
   if(typeof r.xml!=='string'||!r.xml.trim())throw new Error('Abnahme ohne XRechnung-XML.');
   invoiceNumber=invoiceNumberOf(r.xml);
  }catch(e){
   return [r.protocolDe,'',txTableDe(r.txs),'',`Abgenommen, aber nicht versendbar: ${e.message}`,
    ...(r.purchaseId?['Die Escrow bezahlt den RechnungsMeister für diese Umwandlung; ein erneutes PRÜFEN mit demselben Text kauft nicht erneut.']:[]),
    'SENDEN ist für diese Rechnung nicht möglich. Bitte die Rechnung korrigieren und erneut PRÜFEN.'].join('\n');
  }
  const xmlSha256=sha256(r.xml);
  mkdirSync(`${dir}/abnahmen`,{recursive:true,mode:0o700});
  const xmlFile=`${dir}/abnahmen/${xmlSha256}.xml`;writeFileSync(xmlFile,r.xml,{mode:0o600});
  const store=read(acceptedPath,{});
  // pending until the worker has completed this PRÜFEN Task (confirm): a cancelled check never counts.
  store[invoiceNumber]={taskId,userId,recipientProfileId:job.recipientProfileId,xmlSha256,xmlFile,acceptedAt:now().toISOString(),purchaseId:r.purchaseId??null,pending:true};
  write(acceptedPath,store);
  return [r.protocolDe,'',txTableDe(r.txs),'',`Rechnungsnummer: ${invoiceNumber}`,`XML sha256: ${xmlSha256}`,'',
   `${SEND_PRICE_DE}. Auftrag dafür: „SENDEN ${invoiceNumber}“.`].join('\n');
 }
 function confirm(taskId){
  const store=read(acceptedPath,{}),done=Object.values(store).filter(v=>v.taskId===taskId&&v.pending);
  for(const v of done)delete v.pending;
  if(done.length)write(acceptedPath,store);
 }

 // Runs before any payment request (reserve:true from sendenGate) and again inside senden(). One synchronous
 // read-check-write, and the worker lock admits one process, so an invoice has at most one reserving Task.
 function sendenCheck(input,{taskId,userId,reserve=false}={}){
  let job;try{job=parseTask(input)}catch(e){return refuse(e.message)}
  if(job.kind!=='SENDEN')return refuse('Die erste Zeile muss „SENDEN <Rechnungsnummer>“ lauten.');
  const n=job.invoiceNumber,ledger=read(ledgerPath,{entries:[]});
  // A reservation pins the acceptance it was made for (DELTA-WORKER-1): a later PRÜFEN of the same number changes nothing.
  const mine=taskId&&ledger.entries.find(e=>e.taskId===taskId&&e.invoiceNumber===n&&e.status==='reserved');
  if(mine){
   const xml=xmlOf(mine.xmlSha256)??'';
   if(sha256(xml)!==mine.xmlSha256)return refuse('Das gespeicherte XML weicht vom abgenommenen XML ab. Bitte erneut PRÜFEN.');
   return {ok:true,job,reservation:mine,xml};
  }
  const accepted=read(acceptedPath,{})[n];
  if(!accepted)return refuse(`Rechnung „${n}“ wurde nicht in einer PRÜFEN-Aufgabe abgenommen. Bitte zuerst PRÜFEN.`);
  if(accepted.refused)return refuse(`Rechnung ${n} wurde zuletzt in PRÜFEN-Aufgabe ${accepted.taskId} abgelehnt. Bitte die Mängel beheben und erneut PRÜFEN.`);
  if(accepted.pending)return refuse(`Die PRÜFEN-Aufgabe ${accepted.taskId} für Rechnung ${n} wurde nicht abgeschlossen. Bitte erneut PRÜFEN.`);
  if(accepted.userId&&accepted.userId!==userId)return refuse(`Rechnung ${n} wurde unter einem anderen Sokosumi-Konto geprüft. SENDEN ist nur für dieses Konto möglich.`);
  const xml=existsSync(accepted.xmlFile)?readFileSync(accepted.xmlFile,'utf8'):'';
  if(sha256(xml)!==accepted.xmlSha256)return refuse('Das gespeicherte XML weicht vom abgenommenen XML ab. Bitte erneut PRÜFEN.');
  const same=ledger.entries.find(e=>e.invoiceNumber===n||e.xmlSha256===accepted.xmlSha256);
  if(same?.status==='reserved')return refuse(`Für Rechnung ${same.invoiceNumber} läuft bereits der SENDEN-Auftrag ${same.taskId}.`);
  if(same)return refuse(`Doppelversand gesperrt: Rechnung ${same.invoiceNumber} (XML sha256 ${same.xmlSha256}) ist bereits ${outcome(same)}.`);
  const to=AP_INBOX[accepted.recipientProfileId],key=supplyKey(xml,to),twin=ledger.entries.find(e=>keyOf(e)===key);
  if(twin)return refuse(`Dieselbe Leistung (Empfänger ${to}, gleiche Positionen, gleiches Leistungsdatum) ist bereits als Rechnung ${twin.invoiceNumber} ${twin.status==='reserved'?`im SENDEN-Auftrag ${twin.taskId}`:outcome(twin)}.${vatShown(xml)?' Eine zweite Rechnung mit Steuerausweis für dieselbe Leistung würde die Umsatzsteuer nach § 14c Abs. 1 UStG ein zweites Mal schulden.':''} Ein zweiter Versand für dieselbe Leistung ist gesperrt.`);
  if(reserve){
   if(!taskId)return refuse('SENDEN ohne Auftrags-ID.');
   const reservation={invoiceNumber:n,xmlSha256:accepted.xmlSha256,supplyKey:key,taskId,userId:userId??null,to,status:'reserved',reservedAt:now().toISOString(),
    acceptedTaskId:accepted.taskId,acceptedAt:accepted.acceptedAt,recipientProfileId:accepted.recipientProfileId};
   ledger.entries.push(reservation);
   write(ledgerPath,ledger);
   return {ok:true,job,reservation,xml};
  }
  return {ok:true,job,accepted,xml};
 }
 // The acceptance a ledger entry was reserved for; entries from before DELTA-WORKER-1 fall back to the current store.
 const acceptanceOf=e=>e.acceptedTaskId?{taskId:e.acceptedTaskId,acceptedAt:e.acceptedAt,recipientProfileId:e.recipientProfileId}:read(acceptedPath,{})[e.invoiceNumber]??{};
 // The paid gate. Free refusals first (they also explain themselves with the mail server down), then the SMTP probe,
 // then the reservation. Mailpit can still fail after the probe; the paid FAILED text then names the credits.
 async function sendenGate(input,task){
  const check=sendenCheck(input,{taskId:task.id,userId:task.userId});
  if(!check.ok)return check;
  if(!(await probe()))return refuse('Der Postausgang (SMTP) ist gerade nicht erreichbar; der Versand würde nach der Zahlung scheitern. Bitte später erneut SENDEN.');
  return sendenCheck(input,{taskId:task.id,userId:task.userId,reserve:true});
 }
 // Frees a reservation whose Task failed before anything was handed to SMTP. Never touches sending/sent/uncertain.
 function release(taskId){
  const ledger=read(ledgerPath,{entries:[]}),kept=ledger.entries.filter(e=>!(e.taskId===taskId&&e.status==='reserved'));
  if(kept.length!==ledger.entries.length)write(ledgerPath,{...ledger,entries:kept});
 }
 const update=(taskId,change)=>{const ledger=read(ledgerPath,{entries:[]}),e=ledger.entries.find(e=>e.taskId===taskId&&['reserved','sending'].includes(e.status));change(e);write(ledgerPath,ledger);return e;};

 // Called by the paid adapter after FundsLocked, with the Task that holds the reservation. Throws on any refusal;
 // the adapter then posts FAILED and submits nothing.
 async function senden(input,task={}){
  if(!task.id)throw new Error('SENDEN ohne Auftrags-ID.');
  const check=sendenCheck(input,{taskId:task.id,userId:task.userId,reserve:true});
  if(!check.ok)throw new Error(check.reasonDe);
  const {job:{invoiceNumber},reservation,xml}=check,accepted={...acceptanceOf(reservation),xmlSha256:reservation.xmlSha256};
  const messageId=`<${randomUUID()}@abnahme.local>`,to=reservation.to;
  update(task.id,e=>Object.assign(e,{status:'sending',messageId,sendingAt:now().toISOString()}));  // before SMTP: a crash leaves it blocked, never resent
  let mail;
  try{
   mail=await send({from:SENDER,to,subject:`XRechnung ${invoiceNumber}`,messageId,
    // "Abgenommen" would read as the GC's own acceptance of the construction work (§ 640 BGB, audit EINVOICE-10).
    text:`Hello,\n\nattached is the e-invoice (XRechnung) ${invoiceNumber} (XML sha256 ${accepted.xmlSha256}).\nE-invoice accepted by the buyer's agent: our Büro agent bought the conversion of this invoice into an XRechnung and accepted the result before sending, after the KoSIT validator and the checks of the recipient profile we keep for you (${accepted.recipientProfileId}) passed. This concerns the e-invoice only, not the construction work (keine Abnahme der Bauleistung nach § 640 BGB).\n\nToni Huber Elektrotechnik GmbH`,
    attachment:{filename:`${invoiceNumber.replace(/[/\\]/gu,'-')}.xml`,content:xml,contentType:'application/xml'}});
  }catch(error){
   const current=read(ledgerPath,{entries:[]}),i=current.entries.findIndex(e=>e.taskId===task.id&&e.status==='sending');
   if(error.dataSent)Object.assign(current.entries[i],{status:'uncertain',error:error.message});else current.entries.splice(i,1);
   write(ledgerPath,current);
   throw new Error(`Versand fehlgeschlagen${error.dataSent?' (Ausgang ungeklärt, Postfach prüfen)':' (nichts versendet)'}: ${smtpErrorDe(error)}.`);
  }
  const entry=update(task.id,e=>Object.assign(e,{status:'sent',sentAt:now().toISOString(),messageId:mail.messageId??messageId,smtpReply:mail.smtpReply}));
  return sentText(entry,accepted,xml);
 }
 // A paid SENDEN found at model-pending after a restart: did this Task's mail go out?
 function recover(task){
  const ledger=read(ledgerPath,{entries:[]}),e=ledger.entries.find(e=>e.taskId===task.id);
  if(!e||e.status==='reserved')return {retry:true};  // nothing was handed to SMTP; the adapter re-checks FundsLocked and the deadline
  if(e.status==='sent')return {result:sentText(e,acceptanceOf(e),xmlOf(e.xmlSha256)??'')};
  if(e.status==='sending'){e.status='uncertain';e.error='Unterbrechung während des Versands';write(ledgerPath,ledger);}
  return {error:`Versand von Rechnung ${e.invoiceNumber} mit ungeklärtem Ausgang (Unterbrechung während des Versands, Message-ID ${e.messageId??'unbekannt'}). Bitte Postfach prüfen.`};
 }
 // Operator step (buero/resolve.mjs) after checking the inbox for the entry's Message-ID: 'sent' keeps the number locked,
 // 'not-sent' frees it for one new SENDEN. It also frees a reservation whose Task closed without the worker (DELTA-WORKER-3).
 function resolve(invoiceNumber,result){
  const ledger=read(ledgerPath,{entries:[]}),e=ledger.entries.find(e=>e.invoiceNumber===invoiceNumber&&['reserved','sending','uncertain'].includes(e.status));
  if(!e)throw new Error(`Kein ungeklärter Versand für Rechnung ${invoiceNumber}.`);
  if(result==='sent'){
   if(e.status==='reserved')throw new Error(`Rechnung ${invoiceNumber} ist nur reserviert (SENDEN-Auftrag ${e.taskId}); es wurde nichts an SMTP übergeben. Nur not-sent ist möglich.`);
   Object.assign(e,{status:'sent',sentAt:e.sendingAt??now().toISOString(),smtpReply:e.smtpReply??'vom Betreiber nach Postfachprüfung bestätigt',resolvedAt:now().toISOString()});
  }
  else if(result==='not-sent')ledger.entries.splice(ledger.entries.indexOf(e),1);
  else throw new Error('Ergebnis muss sent oder not-sent sein.');
  write(ledgerPath,ledger);
  return e;
 }
 return {pruefen,confirm,sendenCheck,sendenGate,release,senden,recover,resolve};
}

// Comments and FAILED events go through the Coworker runtime key, with the template's Task/Workspace check first.
export async function sokosumiEvents(target){
 const {readRuntimeCredential,createCoworkerHttpClient}=await loadSokosumiRuntime();
 const runtime=createCoworkerHttpClient({apiKey:readRuntimeCredential(target.coworkerId)});
 const post=async(taskId,body)=>(await (await verifyRuntimeTask(runtime,taskId,target)).post(`/v1/tasks/${encodeURIComponent(taskId)}/events`,body,AbortSignal.timeout(30000))).data;
 return {comment:(taskId,text)=>post(taskId,{comment:text}),fail:(taskId,text)=>post(taskId,{status:'FAILED',comment:text})};
}
