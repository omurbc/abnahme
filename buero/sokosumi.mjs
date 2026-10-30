// Büro-Agent behind the Sokosumi Coworker "Abnahme-Büro". Two Task types, chosen by the first line:
//   PRÜFEN (unpaid): invoice text + "Empfänger: <profil>" + "Betrag: <brutto>" → runAbnahme → Abnahmeprotokoll.
//   SENDEN <Rechnungsnummer> (paid): only for an invoice a PRÜFEN Task accepted; e-mails the accepted XML once (§ 14c UStG).
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {sendMail as smtpSend} from '../mail/smtp.mjs';
import {AP_INBOX,SENDER} from '../mail/recipients.mjs';
import {loadSokosumiRuntime} from '../sokosumi-runtime.mjs';
import {verifyRuntimeTask} from '../task-target.mjs';

export const SEND_PRICE_DE='Senden: 1 tUSDM (nur für abgenommene Rechnungen)';
const DAY=24*60*60*1000;
export const sha256=text=>createHash('sha256').update(text,'utf8').digest('hex');
const euro=n=>Number(n).toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2})+' €';
const dateDe=d=>d.toLocaleDateString('de-DE',{timeZone:'Europe/Berlin',day:'2-digit',month:'2-digit',year:'numeric'});

export function parseAmount(text){
 let s=String(text).replace(/€|EUR/giu,'').replace(/\s/gu,'');
 if(/,\d{1,2}$/u.test(s))s=s.replace(/\./gu,'').replace(',','.');
 else if(/^\d{1,3}(\.\d{3})+$/u.test(s))s=s.replace(/\./gu,'');
 const n=/^\d+(\.\d{1,2})?$/u.test(s)?Number(s):NaN;
 if(!(n>0))throw new Error(`Betrag „${text}“ ist kein gültiger Bruttobetrag (z. B. 18.400,00).`);
 return n;
}

export function parseTask(description){
 const lines=String(description??'').trim().split(/\r?\n/u);
 const first=lines[0].trim();
 const senden=/^SENDEN\s+(\S+)$/u.exec(first);
 if(senden)return {kind:'SENDEN',invoiceNumber:senden[1]};
 if(!/^PR(Ü|UE)FEN\b/iu.test(first))return {kind:'UNKNOWN'};
 let recipientProfileId,expectedTotal;const rest=[];
 for(const line of lines.slice(1)){
  const r=/^\s*Empf(ä|ae)nger\s*:\s*(\S+)\s*$/iu.exec(line),b=/^\s*Betrag\s*:\s*(.+?)\s*$/iu.exec(line);
  if(r)recipientProfileId=r[2];else if(b)expectedTotal=parseAmount(b[1]);else rest.push(line);
 }
 if(!Object.hasOwn(AP_INBOX,recipientProfileId??''))throw new Error(`Zeile „Empfänger: ${Object.keys(AP_INBOX).join('|')}“ fehlt oder nennt ein unbekanntes Empfängerprofil.`);
 if(expectedTotal===undefined)throw new Error('Zeile „Betrag: <Bruttobetrag>“ fehlt (z. B. Betrag: 18.400,00).');
 const invoiceText=rest.join('\n').trim();
 if(!invoiceText)throw new Error('Der Rechnungstext fehlt.');
 return {kind:'PRUEFEN',recipientProfileId,expectedTotal,invoiceText};
}
export const isSenden=description=>/^\s*SENDEN\s/u.test(String(description??''));

// BT-1: the first cbc:ID in a UBL invoice is the invoice number (CustomizationID/ProfileID are other elements).
export function invoiceNumberOf(xml){
 const m=/<cbc:ID>([^<]+)<\/cbc:ID>/u.exec(xml);
 if(!m)throw new Error('Rechnungsnummer (BT-1) nicht im XML gefunden.');
 return m[1].trim();
}

export function txTableDe(txs){
 if(!txs?.length)return 'Transaktionen: keine (lokale Prüfung ohne Escrow-Kauf).';
 return ['Transaktionen (Cardano preprod):','| Schritt | Tx | Explorer |','|---|---|---|',
  ...txs.map(t=>`| ${t.label} | \`${t.txHash}\` | ${t.explorerUrl} |`)].join('\n');
}

export function createBuero({runAbnahme,send=smtpSend,dir='.local',now=()=>new Date()}){
 const acceptedPath=`${dir}/abnahmen.json`,ledgerPath=`${dir}/sent-ledger.json`;
 const read=(path,empty)=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')):empty;
 const write=(path,value)=>writeFileSync(path,JSON.stringify(value,null,1),{mode:0o600});
 const sentEntry=(invoiceNumber,xmlSha256)=>read(ledgerPath,{entries:[]}).entries.find(e=>e.invoiceNumber===invoiceNumber||e.xmlSha256===xmlSha256);

 async function pruefen({taskId,input,onProgress=async()=>{}}){
  const job=parseTask(input);
  if(job.kind==='SENDEN')throw new Error('SENDEN-Aufträge laufen nur über den bezahlten Ablauf.');
  if(job.kind!=='PRUEFEN')throw new Error('Unbekannter Auftrag. Die erste Zeile muss „PRÜFEN“ oder „SENDEN <Rechnungsnummer>“ sein.');
  const progress=async text=>{try{await onProgress(text)}catch(e){console.error('Progress comment failed',taskId,e.message.slice(0,200))}};
  await progress(`Prüfung gestartet: Empfängerprofil ${job.recipientProfileId}, erwarteter Bruttobetrag ${euro(job.expectedTotal)}. Die Prüfung ist kostenlos.`);
  const r=await runAbnahme({invoiceText:job.invoiceText,recipientProfileId:job.recipientProfileId,expectedTotal:job.expectedTotal,onProgress:progress});
  if(r?.status==='REFUSED')return [r.protocolDe,'',txTableDe(r.txs),'','Nicht abgenommen. Es fallen keine Kosten an. Bitte die Mängel beheben und erneut PRÜFEN.'].join('\n');
  if(r?.status!=='ACCEPTED')throw new Error(`Prüfung fehlgeschlagen. ${r?.protocolDe??'Kein Ergebnis.'}`);
  if(typeof r.xml!=='string'||!r.xml.trim())throw new Error('Abnahme ohne XRechnung-XML.');
  const invoiceNumber=invoiceNumberOf(r.xml),xmlSha256=sha256(r.xml);
  mkdirSync(`${dir}/abnahmen`,{recursive:true,mode:0o700});
  const xmlFile=`${dir}/abnahmen/${xmlSha256}.xml`;writeFileSync(xmlFile,r.xml,{mode:0o600});
  const store=read(acceptedPath,{});
  store[invoiceNumber]={taskId,recipientProfileId:job.recipientProfileId,xmlSha256,xmlFile,acceptedAt:now().toISOString(),purchaseId:r.purchaseId??null};
  write(acceptedPath,store);
  return [r.protocolDe,'',txTableDe(r.txs),'',`Rechnungsnummer: ${invoiceNumber}`,`XML sha256: ${xmlSha256}`,'',
   `${SEND_PRICE_DE}. Auftrag dafür: „SENDEN ${invoiceNumber}“.`].join('\n');
 }

 // Runs before any payment request, so a refused SENDEN costs nothing.
 function sendenCheck(input){
  const job=parseTask(input);
  if(job.kind!=='SENDEN')return {ok:false,reasonDe:'Kein SENDEN-Auftrag.'};
  const accepted=read(acceptedPath,{})[job.invoiceNumber];
  if(!accepted)return {ok:false,reasonDe:`Rechnung ${job.invoiceNumber} wurde nicht in einer PRÜFEN-Aufgabe abgenommen. Bitte zuerst PRÜFEN.`};
  const sent=sentEntry(job.invoiceNumber,accepted.xmlSha256);
  if(sent)return {ok:false,reasonDe:`§ 14c UStG: Rechnung ${sent.invoiceNumber} (XML sha256 ${sent.xmlSha256}) ist bereits ${sent.status==='sent'?`am ${sent.sentAt} versendet (Message-ID ${sent.messageId})`:'im Versand mit ungeklärtem Ausgang'}. Keine Doppelausstellung.`};
  return {ok:true,job,accepted};
 }

 // Called by the paid adapter after FundsLocked. Throws on any refusal; the adapter then posts FAILED and submits nothing.
 async function senden(input){
  const check=sendenCheck(input);
  if(!check.ok)throw new Error(check.reasonDe);
  const {job:{invoiceNumber},accepted}=check;
  const xml=readFileSync(accepted.xmlFile,'utf8');
  if(sha256(xml)!==accepted.xmlSha256)throw new Error('Gespeichertes XML weicht vom abgenommenen XML ab.');
  const to=AP_INBOX[accepted.recipientProfileId];
  const ledger=read(ledgerPath,{entries:[]});
  const entry={invoiceNumber,xmlSha256:accepted.xmlSha256,to,status:'sending',reservedAt:now().toISOString()};
  ledger.entries.push(entry);write(ledgerPath,ledger);  // reserve before SMTP: a crash leaves it blocked, never resent
  let mail;
  try{
   mail=await send({from:SENDER,to,subject:`XRechnung ${invoiceNumber}`,
    text:`Guten Tag,\n\nanbei die XRechnung ${invoiceNumber} (XML sha256 ${accepted.xmlSha256}).\nSie wurde vor dem Versand mit dem KoSIT-Validator und Ihrem Empfängerprofil ${accepted.recipientProfileId} geprüft und abgenommen.\n\nToni Huber Elektrotechnik GmbH`,
    attachment:{filename:`${invoiceNumber}.xml`,content:xml,contentType:'application/xml'}});
  }catch(error){
   const current=read(ledgerPath,{entries:[]});
   if(error.dataSent)Object.assign(current.entries.find(e=>e.invoiceNumber===invoiceNumber&&e.status==='sending'),{status:'uncertain',error:error.message});
   else current.entries=current.entries.filter(e=>!(e.invoiceNumber===invoiceNumber&&e.status==='sending'));
   write(ledgerPath,current);
   throw new Error(`Versand fehlgeschlagen${error.dataSent?' (Ausgang ungeklärt, Postfach prüfen)':' (nichts versendet)'}: ${error.message}`);
  }
  const sentAt=now();
  const done=read(ledgerPath,{entries:[]});
  Object.assign(done.entries.find(e=>e.invoiceNumber===invoiceNumber&&e.status==='sending'),{status:'sent',sentAt:sentAt.toISOString(),messageId:mail.messageId,smtpReply:mail.smtpReply});
  write(ledgerPath,done);
  return [`Versendet: XRechnung ${invoiceNumber} an ${to} (Empfängerprofil ${accepted.recipientProfileId}).`,
   `Message-ID: ${mail.messageId}`,`SMTP-Antwort: ${mail.smtpReply}`,`XML sha256: ${accepted.xmlSha256}`,`Versandzeit: ${sentAt.toISOString()}`,
   `Fälligkeit: Eine Abschlagsforderung nach VOB/B § 16 Abs. 1 Nr. 3 wird 21 Tage nach Zugang fällig; bei Zugang heute am ${dateDe(new Date(sentAt.getTime()+21*DAY))}. Der Zugang beim Empfänger ist damit nicht bewiesen.`,
   `§ 14c UStG: Rechnungsnummer und XML-Hash sind jetzt gesperrt; ein zweites SENDEN wird abgelehnt.`,
   `Abgenommen in PRÜFEN-Aufgabe ${accepted.taskId} am ${accepted.acceptedAt}.`].join('\n');
 }
 return {pruefen,sendenCheck,senden};
}

// Comments and FAILED events go through the Coworker runtime key, with the template's Task/Workspace check first.
export async function sokosumiEvents(target){
 const {readRuntimeCredential,createCoworkerHttpClient}=await loadSokosumiRuntime();
 const runtime=createCoworkerHttpClient({apiKey:readRuntimeCredential(target.coworkerId)});
 const post=async(taskId,body)=>(await (await verifyRuntimeTask(runtime,taskId,target)).post(`/v1/tasks/${encodeURIComponent(taskId)}/events`,body,AbortSignal.timeout(30000))).data;
 return {comment:(taskId,text)=>post(taskId,{comment:text}),fail:(taskId,text)=>post(taskId,{status:'FAILED',comment:text})};
}
