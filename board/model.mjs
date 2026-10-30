// Abnahme-Board model: pure functions from what the agents already write to the timeline the board draws.
// Inputs: the Büro-Agent journal (.local/abnahme-journal/, buero/abnahme.mjs), the RechnungsMeister job
// (.local/rechnungsmeister-jobs/), the Gutachter payments log, the send ledger + Mailpit, and MPS tx history.
// No I/O and no clock here: server.mjs reads everything and passes `now`. Every input is first reduced to safe fields
// (safeJournal, safeRmJob, safeLedger): job tokens, nonces and invoice texts never reach a timeline.
import {createHash} from 'node:crypto';

export const explorerUrl=hash=>`https://preprod.cardanoscan.io/transaction/${hash}`;
const HEX64=/^[0-9a-f]{64}$/;
const sha256=text=>createHash('sha256').update(text,'utf8').digest('hex');
const num=v=>v==null||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const ms=v=>v==null?null:typeof v==='number'?v:Date.parse(v);
const iso=v=>{const t=ms(v);return Number.isFinite(t)?new Date(t).toISOString():null;};
// German amount as the journal writes it ("18.400,00 €") -> 18400
const parseEuro=text=>{const n=Number(String(text??'').replace(/[^\d,]/g,'').replace(',','.'));return Number.isFinite(n)&&n>0?n:null;};

// Invoice fields the cure may touch, with their EN 16931 business terms (rechnungsmeister/cure.mjs CURABLE).
export const FIELDS={
 buyerVatId:['BT-48','Buyer VAT ID'],buyerReference:['BT-10','Buyer reference'],sellerVatId:['BT-31','Seller VAT ID'],
 sellerIban:['BT-84','Seller IBAN'],invoiceNumber:['BT-1','Invoice number'],buyerName:['BT-44','Buyer name'],
 buyerPostcode:['BT-53','Buyer postcode'],grossTotal:['BT-112','Gross total'],dueDate:['BT-9','Due date'],invoiceDate:['BT-2','Invoice date'],
};
const sourceText=src=>!src?null:src==='input_data.invoiceText'?'from the invoice text':src.startsWith('recipient.')?'from the recipient profile':src.startsWith('input_data')?'from the order data':src;
// One English line per defect code; the German text from KoSIT / verifier/messages-de.mjs stays next to it.
export const DEFECT_EN={
 'BR-AE-02':'Buyer VAT ID missing (§13b reverse charge)','ABN-BT48':'Buyer VAT ID (BT-48) missing or wrong under §13b',
 'BR-DE-15':'Buyer reference (BT-10) missing','ABN-BT10':'Buyer reference (BT-10) missing or wrong pattern',
 'ABN-BETRAG':'Payable amount differs from the agreed total','ABN-HASH':'Delivered bytes do not match the result hash on chain',
 'ABN-USTID':'Seller VAT ID not in the master data','ABN-IBAN':'IBAN differs from the master data','ABN-13B':'Wrong VAT category for this recipient',
 'ABN-13B-HINWEIS':'§14a(5) reverse-charge wording missing','ABN-WAEHRUNG':'Currency is not EUR','ABN-RECHNUNGSART':'Invoice type is not 380 or 875',
 'ABN-UST':'VAT arithmetic is wrong','ABN-KAEUFER':'Buyer name or postcode is wrong','ABN-DATUM':'Invoice or due date is wrong','ABN-XML':'XML cannot be read safely',
 'ABN-LIEFERUNG':'Seller did not deliver the result','ABN-PRUEFUNG':'Inspection was not possible','ABN-FRIST':'No cure in time','ABN-MANIFEST':'Malformed delivery',
 'ABN-BT1':'Invoice number cannot be sent','KOSIT-SCENARIO':'Wrong KoSIT scenario (not XRechnung)',
};
const defectKind=code=>code.startsWith('BR-')?'KoSIT rule (EN 16931)':code==='ABN-HASH'?'Hash check':code.startsWith('KOSIT')?'KoSIT':'Recipient profile';

// ---------- input reduction ----------
// Absolute local paths in engine messages (home directory, temp dirs) are cut to their file name before anything is shown.
const redactPaths=text=>text==null?text:String(text).replace(/(?:\/(?:Users|home|private|var|tmp|opt)\/)[^\s)]*\/([^\s)/]+)/g,'…/$1');
const inspectionNote=n=>!n?null:/budget reached/i.test(n)?'x402 daily budget reached':redactPaths(n).slice(0,90);
const xmlValue=(xml,re)=>(re.exec(xml)??[])[1]?.trim()??null;
export function invoiceNumberInText(text){
 return typeof text==='string'?(/(?:rechnung|rechnungs)[-\s]*nr\.?\s*:?\s*([\p{L}\p{N}][\p{L}\p{N}._/#&+()-]*)/iu.exec(text)??[])[1]??null:null;
}
export function safeJournal(j){
 const s=j.startJob??{},xml=typeof j.lastXml==='string'?j.lastXml:null;
 return {
  id:j.id,inputKey:j.inputKey??null,createdAt:j.createdAt??null,stage:j.stage??null,status:j.status??null,round:j.round??0,disputes:j.disputes??0,
  escrowState:j.escrowState??null,protective:j.protective??null,paidWithoutAcceptance:!!j.paidWithoutAcceptance,profileHash:j.profileHash??null,
  attempts:(j.attempts??[]).map(a=>({round:a.round,attempt:a.attempt??null,passed:!!a.passed,hashSource:a.hashSource??null,
   failures:(a.failures??[]).map(f=>({code:String(f.code),textDe:String(f.textDe??'')})),minor:a.minor??[],
   inspection:a.inspection?{mode:a.inspection.mode,txHash:a.inspection.txHash??null,note:inspectionNote(a.inspection.note),httpStatus:a.inspection.httpStatus??null,scenario:a.inspection.scenario??null}:null})),
  inspectionTxs:(j.inspectionTxs??[]).filter(t=>HEX64.test(t.txHash??'')).map(t=>({label:t.label,txHash:t.txHash})),
  log:(j.log??[]).map(l=>({at:l.at,line:redactPaths(l.line)})),
  txs:(j.txs??[]).filter(t=>HEX64.test(t.txHash??'')).map(t=>({label:t.label,txHash:t.txHash,status:t.status??null,at:t.at??null})),
  error:redactPaths(j.error??null),lastError:redactPaths(j.lastError??null),withdrawAuthorizedSeen:!!j.withdrawAuthorizedSeen,purchaseId:j.purchaseId??null,
  job:{id:s.job_id??s.id??null,blockchainIdentifier:s.blockchainIdentifier??null,payByTime:num(s.payByTime),submitResultTime:num(s.submitResultTime),
   unlockTime:num(s.unlockTime),externalDisputeUnlockTime:num(s.externalDisputeUnlockTime),smartContractAddress:s.smartContractAddress??null},
  xml:xml&&{sha256:sha256(xml),invoiceNumber:xmlValue(xml,/<\/cbc:ProfileID>\s*<cbc:ID>([^<]+)<\/cbc:ID>/)??xmlValue(xml,/<cbc:ID>([^<]+)<\/cbc:ID>/),
   payable:num(xmlValue(xml,/<cbc:PayableAmount[^>]*>([^<]+)</)),
   buyerVatId:xmlValue(xmlValue(xml,/<cac:AccountingCustomerParty>([\s\S]*?)<\/cac:AccountingCustomerParty>/)??'',/<cac:PartyTaxScheme>\s*<cbc:CompanyID>([^<]+)</)},
 };
}
export function safeRmJob(r){
 if(!r)return null;
 const pick=f=>f?Object.fromEntries(Object.keys(FIELDS).filter(k=>k in f).map(k=>[k,f[k]])):{};
 return {id:r.id,phase:r.phase??null,closed:r.closed??null,demo:{seedDefect:!!r.demo?.seedDefect,cheat:!!r.demo?.cheat},
  recipientProfileId:r.input?.recipientProfileId??null,expectedTotal:num(r.input?.expectedTotal),
  invoiceNumber:r.fields0?.invoiceNumber??invoiceNumberInText(r.input?.invoiceText),
  attempts:(r.attempts??[]).map(a=>({attempt:a.attempt,fields:pick(a.fields),selfCheck:a.selfCheck??null,seededDefect:a.seededDefect??null,
   cure:a.cure?{patch:a.cure.patch??{},sources:a.cure.sources??{},retransmit:!!a.cure.retransmit}:null,submittedAt:num(a.submittedAt)})),
  refundReasons:r.refundReasons??null};
}
export const safeLedger=entries=>(entries??[]).map(e=>({invoiceNumber:e.invoiceNumber,xmlSha256:e.xmlSha256,to:e.to,status:e.status,sentAt:e.sentAt??null,messageId:e.messageId??null,taskId:e.taskId??null}));

// ---------- journal reading ----------
const LOG={
 order:/^Auftrag \S+: Rechnung für (.+?), erwarteter Betrag (.+?), Prüfprofil/,
 locked:/^Geld gesperrt \(FundsLocked\)/,
 delivered:/^Ergebnis auf Cardano eingereicht \(ResultSubmitted\)/,
 inspection:n=>new RegExp(`^Prüfung ${n} \\(`),
 protective:/^Vorsorgliche Mängelrüge \[([^\]]+)\]: (.*?) Ohne bestandene Prüfung/,
 disputeSent:/^Mängelrüge auf Cardano/,
 disputed:/^Streitfall bestätigt \(Disputed\)/,
 cure:/^RechnungsMeister bessert nach \(Versuch (\d+)\)(?:: (.*))?\.$/,
 cureSubmitted:/^Nachbesserung \d+ auf Cardano eingereicht/,
 acceptOrdered:/^Freigabe auf Cardano beauftragt/,
 authorized:/^Zahlung freigegeben \(WithdrawAuthorized\)/,
 withdrawn:/Zahlung aus der Escrow erhalten \(Withdrawn\)|^Escrow abgeschlossen: Withdrawn/,
 accepted:/^ABGENOMMEN\./,
 noCure:/^Rechnung abgelehnt\. Der RechnungsMeister kann nicht nachbessern \((.*)\) und gibt die Rückerstattung frei/,
 exhausted:/^Rechnung abgelehnt: auch nach Nachbesserung mangelhaft/,
 refundAuthorized:/^Rechnung abgelehnt\. Rückerstattung auf Cardano freigegeben/,
 refunded:/^Escrow abgeschlossen: RefundWithdrawn/,
 alarm:/^ALARM: /,
 abort:/^Abbruch: /,
};
const findLog=(j,re)=>j.log.find(l=>re.test(l.line))??null;
const findLastLog=(j,re)=>j.log.findLast(l=>re.test(l.line))??null;
const TX_STEP={'FundsLocked':'locked','ResultSubmitted':'delivered','Disputed':'disputed','RefundRequested':'disputed','ResultSubmitted (cure)':'cure',
 'AuthorizeWithdrawal':'accepted','Withdrawn':'paid','Withdrawn (deemed acceptance)':'paid','AuthorizeRefund':'refundAuthorized','RefundWithdrawn':'refunded','DisputedWithdrawn':'arbitration'};
export const TX_NAME={'FundsLocked':'Funds locked','ResultSubmitted':'Delivery','Disputed':'Defect notice (Mängelrüge)','RefundRequested':'Refund requested','ResultSubmitted (cure)':'Cure (Nachbesserung)',
 'AuthorizeWithdrawal':'Acceptance (Abnahme)','Withdrawn':'Payout','Withdrawn (deemed acceptance)':'Payout after unlock time (deemed acceptance)','AuthorizeRefund':'Refund authorized',
 'RefundWithdrawn':'Refund paid out','DisputedWithdrawn':'Arbitration payout'};

// Escrow txs of one job: the journal's final table plus MPS's live history (chainTxs), one row per hash.
function escrowTxsOf(j,chainTxs){
 const map=new Map();
 for(const t of [...j.txs,...(chainTxs??[])]){
  if(!HEX64.test(t.txHash??'')||String(t.label).startsWith('x402'))continue;
  const prev=map.get(t.txHash)??{};
  map.set(t.txHash,{label:prev.label??t.label,txHash:t.txHash,status:prev.status==='Confirmed'?prev.status:t.status??prev.status??null,at:prev.at??t.at??null,blockHeight:prev.blockHeight??t.blockHeight??null});
 }
 return [...map.values()].sort((a,b)=>String(a.at).localeCompare(String(b.at)));
}

// [English label, German term, tone]
const STATUS={
 running:['Running','läuft','blue'],accepted:['Accepted','abgenommen','green'],paid:['Paid','bezahlt','green'],
 refused:['Refused','abgelehnt','red'],refunded:['Refused · refunded','abgelehnt, erstattet','red'],failed:['Failed','abgebrochen','amber'],
 alarm:['Alarm','Betreiber gefragt','amber'],'paid-unaccepted':['Paid without acceptance','ohne Abnahme ausgezahlt','amber'],stale:['Stalled','ohne Fortschritt','grey'],
};
const STALE=45*60000;
const STAGE_ORDER=['start','purchase','wait-locked','wait-result','inspect','dispute','wait-disputed','notify','accept','wait-withdrawn','wait-refund','follow','done'];

// ---------- timeline ----------
// ctx: {rmJob (safeRmJob), payments (Gutachter log), mail ({to,sentAt,messageId,taskId,inMailpit}|null), chainTxs ([{label,txHash,status,at,blockHeight}]
// from MPS), tip (latest block height), heights ({hash: blockHeight}), escrowState (live MPS state), origin ({kind,taskId}), recipients ({profileHash:{id,name}}), now}
export function timeline(j,ctx={}){
 const now=ctx.now??Date.now(),rm=ctx.rmJob??null,payments=ctx.payments??[];
 const escrowState=ctx.escrowState??j.escrowState;
 const txs=escrowTxsOf(j,ctx.chainTxs);
 const heights={...ctx.heights};for(const t of txs)if(t.blockHeight)heights[t.txHash]=t.blockHeight;
 const conf=hash=>ctx.tip&&heights[hash]?Math.max(0,ctx.tip-heights[hash]+1):null;
 const txRef=(hash,label)=>hash?{hash,url:explorerUrl(hash),label,confirmations:conf(hash)}:null;
 const txFor=key=>txs.find(t=>TX_STEP[t.label]===key)??null;
 const confirmedTx=key=>{const t=txFor(key);return t&&(t.status==null||t.status==='Confirmed')?t:null;};
 const stageIdx=STAGE_ORDER.indexOf(j.stage);
 const [,orderName,orderAmount]=LOG.order.exec(j.log[0]?.line??'')??[];
 const recipient=ctx.recipients?.[j.profileHash]??null;

 const a0=j.attempts[0]??null,a1=j.attempts[1]??null;
 const protectiveLog=findLog(j,LOG.protective);
 const noCureLog=findLog(j,LOG.noCure);
 const paid=!!(confirmedTx('paid')||findLog(j,LOG.withdrawn)||escrowState==='Withdrawn');
 const refunded=!!(confirmedTx('refunded')||findLog(j,LOG.refunded)||escrowState==='RefundWithdrawn');
 const alarmLog=findLastLog(j,LOG.alarm);
 const lastActivity=Math.max(...j.log.map(l=>ms(l.at)).filter(Number.isFinite),...txs.map(t=>ms(t.at)).filter(Number.isFinite),ms(j.createdAt)||0);
 // Final status from the journal; a job in `follow` is still waiting for the escrow to settle.
 const settled=paid||refunded||escrowState==='DisputedWithdrawn';
 let running=j.status?j.stage==='follow'&&!settled:j.stage!=='done';
 let code=!j.status?'running':j.status==='ACCEPTED'?(paid?'paid':'accepted'):j.status==='REFUSED'?(refunded?'refunded':'refused'):j.paidWithoutAcceptance?'paid-unaccepted':alarmLog?'alarm':'failed';
 if(code==='running'&&now-lastActivity>STALE){code='stale';running=false;}
 const refusal=j.status==='REFUSED'||j.stage==='wait-refund'||!!noCureLog||!!txFor('refundAuthorized')||!!txFor('refunded');
 const disputedDone=!!(confirmedTx('disputed')||findLog(j,LOG.disputed));
 const path=refusal?'refusal':a0?.passed&&!disputedDone&&!protectiveLog?'deemed':a0||disputedDone||protectiveLog?'cure':'pending';
 const ended=!running;

 const step=(key,o)=>({key,term:null,law:null,status:'pending',tone:null,at:null,tx:null,amount:null,note:null,conditional:false,...o});
 const active=cond=>running&&cond;
 const at=(t,l)=>iso(t?.at)??l?.at??null;

 const lockedTx=txFor('locked'),lockedLog=findLog(j,LOG.locked);
 const lockedDone=!!(confirmedTx('locked')||lockedLog||stageIdx>2||a0);
 const failedAt=stages=>ended&&j.status==='FAILED'&&stages.includes(j.stage);
 const locked=step('locked',{title:'Funds locked',tech:'FundsLocked · Masumi V2 escrow',law:'§ 631 BGB',amount:'1 tUSDM',
  status:lockedDone?'done':failedAt(['start','purchase','wait-locked'])?'failed':active(stageIdx<=2)?'active':'pending',
  at:at(lockedTx,lockedLog)??(lockedDone?null:j.createdAt),tx:txRef(lockedTx?.txHash,lockedTx?.label),
  note:lockedDone?'price of the conversion, held by the escrow':'purchase via the Masumi Payment Service'});

 const deliveredTx=txFor('delivered'),deliveredLog=findLog(j,LOG.delivered);
 const deliveredDone=!!(confirmedTx('delivered')||deliveredLog||a0);
 const delivered=step('delivered',{title:'Work delivered',tech:'ResultSubmitted',
  status:deliveredDone?'done':failedAt(['wait-result'])&&!j.round?'failed':active(lockedDone&&j.stage==='wait-result'&&!j.round)?'active':'pending',
  at:at(deliveredTx,deliveredLog),tx:txRef(deliveredTx?.txHash,deliveredTx?.label),
  note:rm?.attempts[0]?.seededDefect&&(!a0||a0.failures.some(f=>f.code==='ABN-BT48'))?'Demo: BT-48 left out on purpose':deliveredDone?'XRechnung (UBL), result hash on chain':'RechnungsMeister builds the XRechnung'});

 const paymentOf=hash=>payments.find(p=>p.txHash===hash)??null;
 const inspections=j.attempts.map((a,i)=>{
  const x402=a.inspection?.mode==='x402',hash=a.inspection?.txHash??null,pay=hash?paymentOf(hash):null,line=findLog(j,LOG.inspection(i+1));
  return {n:i+1,round:a.round,passed:a.passed,mode:a.inspection?.mode??null,x402,httpStatus:a.inspection?.httpStatus??null,scenario:a.inspection?.scenario??null,
   note:a.inspection?.note??null,tx:x402?txRef(hash,'x402 inspection'):null,verdict:pay?.verdict??(a.passed?'ACCEPTABLE':'REJECT'),at:line?.at??iso(pay?.time),
   hashOk:!a.failures.some(f=>f.code==='ABN-HASH'),hashSource:a.hashSource,failures:a.failures,minor:a.minor};
 });
 const inspectStep=(i,o={})=>{
  const r=inspections[i],waiting=active(j.stage==='inspect'&&j.attempts.length===i&&(i===0?deliveredDone:true));
  const s=step(`inspection${i+1}`,{title:`Inspection ${i+1}`,term:'Prüfung',tech:i?'re-inspection of the cure':'KoSIT + recipient profile',...o});
  if(r)return {...s,status:r.passed?'done':'failed',tone:r.passed?'ok':'bad',at:r.at,tx:r.tx,amount:r.x402?'1 tADA':'0 tADA',
   note:`${r.x402?'Gutachter over x402':'local KoSIT'}${r.note?` (${r.note})`:''} · KoSIT ${r.httpStatus??'?'}${r.passed?' · passed':` · ${r.failures.length} defect${r.failures.length===1?'':'s'}`}`};
  if(waiting)return {...s,status:'active',note:'Gutachter (x402) or local KoSIT inspects'};
  if(ended&&j.stage==='inspect'&&j.attempts.length===i&&j.status==='FAILED')return {...s,status:'failed',tone:'bad',note:j.error??j.lastError};
  return s;
 };

 const disputedTx=txFor('disputed'),disputedLog=findLog(j,LOG.disputed),disputeSentLog=findLog(j,LOG.disputeSent);
 const disputeStep=(o={})=>step('disputed',{title:protectiveLog?'Protective defect notice':'Defect notice',term:protectiveLog?'vorsorgliche Mängelrüge':'Mängelrüge',
  tech:protectiveLog?'Disputed · no passed inspection yet (ESCROW-1)':'SetRefundRequested → Disputed',law:'§ 640(2) BGB',tone:'dispute',amount:'1 tUSDM frozen',
  status:disputedDone?'done':active(['dispute','wait-disputed'].includes(j.stage))?'active':'pending',at:at(disputedTx,disputedLog??disputeSentLog),
  tx:txRef(disputedTx?.txHash,disputedTx?.label),
  note:protectiveLog?`${LOG.protective.exec(protectiveLog.line)[1]}: ${DEFECT_EN[LOG.protective.exec(protectiveLog.line)[1]]??LOG.protective.exec(protectiveLog.line)[2]}`:'money frozen, the seller cannot withdraw',...o});

 const cureTx=txFor('cure'),cureLog=findLog(j,LOG.cure),cureSubmittedLog=findLog(j,LOG.cureSubmitted);
 // The seller cures only after the defect notice reached it; before that a cure in its job file cannot belong to this round.
 const rmCure=cureLog||disputedDone&&!['dispute','wait-disputed'].includes(j.stage)?rm?.attempts.find(a=>a.cure)??null:null;
 const patch=rmCure?Object.entries(rmCure.cure.patch).map(([field,to])=>({field,to,from:rm.attempts.find(a=>a.attempt===rmCure.attempt-1)?.fields?.[field]??null,source:rmCure.cure.sources[field]??null}))
  :[...(LOG.cure.exec(cureLog?.line??'')?.[2]??'').matchAll(/(\w+) = (\S+) \(Quelle: ([^)]+)\)/g)].map(([,field,to,source])=>({field,to,from:null,source}));
 const cure=cureLog||rmCure?{at:cureLog?.at??iso(rmCure?.submittedAt),attempt:Number(LOG.cure.exec(cureLog?.line??'')?.[1]??rmCure?.attempt??2),
  retransmit:!!rmCure?.cure.retransmit||!patch.length,patch:patch.map(p=>({...p,bt:FIELDS[p.field]?.[0]??null,label:FIELDS[p.field]?.[1]??p.field,sourceText:sourceText(p.source)}))}:null;
 const cureDone=!!(confirmedTx('cure')||cureSubmittedLog);
 const cureFailed=!!noCureLog||(ended&&!cureDone&&j.stage==='notify');
 const cureStep=(o={})=>step('cure',{title:'Cure',term:'Nachbesserung',tech:'SubmitResult while Disputed',law:'§ 635 BGB',
  status:cureDone?'done':cureFailed?'failed':active(j.stage==='notify'||j.stage==='wait-result'&&j.round>=1)?'active':'pending',tone:cureFailed?'bad':null,
  at:at(cureTx,cureSubmittedLog),tx:txRef(cureTx?.txHash,cureTx?.label),
  note:noCureLog?`not curable: ${LOG.noCure.exec(noCureLog.line)[1]}`:cureFailed?(j.lastError??alarmLog?.line):cure?.patch.length?cure.patch.map(p=>`${p.bt??p.field}: ${p.from??'empty'} → ${p.to}`).join(', '):cure?'delivery retransmitted':'RechnungsMeister cures',...o});

 const acceptTx=txFor('accepted'),authorizedLog=findLog(j,LOG.authorized),orderedLog=findLog(j,LOG.acceptOrdered);
 const acceptDone=!!(confirmedTx('accepted')||authorizedLog||j.withdrawAuthorizedSeen);
 const acceptStep=()=>step('accepted',{title:'Acceptance',term:'Abnahme',tech:'AuthorizeWithdrawal · irrevocable',law:'§ 640(1) BGB',tone:'ok',
  status:acceptDone?'done':active(j.stage==='accept'||j.stage==='wait-withdrawn')?'active':'pending',at:at(acceptTx,authorizedLog??orderedLog),
  tx:txRef(acceptTx?.txHash,acceptTx?.label),note:acceptDone?'the buyer agent releases the payment':'only for the inspected result hash'});

 const paidTx=txFor('paid'),paidLog=findLog(j,LOG.withdrawn);
 const unlock=j.job.unlockTime;
 const deemed=path==='deemed';
 const paidStep=()=>step('paid',{title:'Paid',term:'Vergütung fällig',tech:deemed?'Withdraw after unlock_time':'Withdrawn',law:'§ 641(1) BGB',tone:'ok',amount:'1 tUSDM → RechnungsMeister',
  status:paid?'done':active(deemed?true:acceptDone)||deemed&&!paid&&j.status==='ACCEPTED'?'active':'pending',at:at(paidTx,paidLog)??(deemed&&!paid?iso(unlock):null),
  tx:txRef(paidTx?.txHash,paidTx?.label),note:paid?'payment falls due on acceptance':deemed?'payout after the unlock time':'payout to the RechnungsMeister'});

 const acceptedLog=findLog(j,LOG.accepted);
 const deemedStep=()=>step('deemed',{title:'Accepted, no notice',term:'Abnahme ohne Rüge',tech:'no dispute · escrow pays at unlock_time',law:'§ 640(2) BGB',tone:'ok',
  status:acceptedLog||paid?'done':'pending',at:acceptedLog?.at??null,note:'inspection passed, no defect notice'});

 const refundTx=txFor('refundAuthorized'),refundLog=findLog(j,LOG.refundAuthorized);
 const refundAuthorized=!!(confirmedTx('refundAuthorized')||refundLog||refunded);
 const refundedTx=txFor('refunded'),refundedLog=findLog(j,LOG.refunded);
 const refundSteps=()=>[
  step('refundAuthorized',{title:'Refund authorized',tech:'AuthorizeRefund · seller concedes',tone:'bad',
   status:refundAuthorized?'done':active(j.stage==='wait-refund')?'active':'pending',at:at(refundTx,refundLog),tx:txRef(refundTx?.txHash,refundTx?.label),
   note:rm?.refundReasons?.join(' ')??(noCureLog?LOG.noCure.exec(noCureLog.line)[1]:'invoice refused')}),
  step('refunded',{title:'Money back',tech:'RefundWithdrawn · buyer refunded',tone:'bad',amount:'1 tUSDM → buyer',
   status:refunded?'done':refundAuthorized?'active':'pending',at:at(refundedTx,refundedLog),tx:txRef(refundedTx?.txHash,refundedTx?.label),
   note:refunded?'back to the buyer (Büro-Agent)':refundAuthorized?'waiting for WithdrawRefund (MPS #1327)':null}),
 ];
 const mailStep=()=>step('mail',{title:'E-invoice sent',term:'E-Rechnung versendet',tech:'XRechnung to accounts payable',tone:'ok',
  status:ctx.mail?'done':'pending',at:ctx.mail?.sentAt??null,note:ctx.mail?`to ${ctx.mail.to}`:'SENDEN in Sokosumi (separate paid Task)'});

 const steps=[locked,delivered];
 if(protectiveLog)steps.push(disputeStep());
 steps.push(inspectStep(0));
 if(path==='deemed')steps.push(deemedStep(),paidStep(),mailStep());
 else if(path==='pending'||!a0)steps.push(...(protectiveLog?[]:[disputeStep({conditional:true,note:'only on a defect'})]),cureStep({conditional:true,note:'only on a defect'}),inspectStep(1,{conditional:true,note:'only on a defect'}),acceptStep(),paidStep(),mailStep());
 else{
  if(!protectiveLog)steps.push(disputeStep());
  if(!a0.passed){steps.push(cureStep());if(a1||!noCureLog)steps.push(inspectStep(1));}
  steps.push(...(path==='refusal'?refundSteps():[acceptStep(),paidStep(),mailStep()]));
 }

 const firstFailed=inspections.find(r=>!r.passed)??null;
 const finished=ended?Math.max(...steps.filter(s=>s.status==='done'||s.status==='failed').map(s=>ms(s.at)).filter(t=>Number.isFinite(t)&&t<=now),lastActivity):null;
 const created=ms(j.createdAt);
 const allTxs=[...txs.map(t=>({label:t.label,name:TX_NAME[t.label]??t.label,rail:'escrow',...txRef(t.txHash,t.label),at:iso(t.at),status:t.status})),
  ...inspections.filter(r=>r.tx).map(r=>({label:`x402 inspection ${r.n}`,name:`x402 inspection ${r.n} (Prüfung)`,rail:'x402',...r.tx,at:iso(r.at),status:'Confirmed'}))]
  .sort((a,b)=>String(a.at).localeCompare(String(b.at)));
 const [label,de,tone]=STATUS[code];
 return {
  id:j.id,createdAt:j.createdAt,finishedAt:finished?new Date(finished).toISOString():null,durationMs:created?(finished??now)-created:null,running,
  status:{code,label,de,tone},path,stage:j.stage,escrowState,
  invoice:{number:j.xml?.invoiceNumber??rm?.invoiceNumber??null,recipientId:rm?.recipientProfileId??recipient?.id??null,recipientName:orderName??recipient?.name??null,
   amount:parseEuro(orderAmount)??rm?.expectedTotal??null,buyerVatId:j.xml?.buyerVatId??null},
  // seedDefect: the switch was on AND it caused this job's first defect (it only bites a §13b recipient, via BT-48).
  demo:{seedDefect:!!rm?.demo.seedDefect&&(a0?a0.failures.some(f=>f.code==='ABN-BT48'||f.code==='BR-AE-02'):!!rm?.attempts[0]?.seededDefect&&(rm.recipientProfileId??recipient?.id)==='bau-isar'),
   seedSwitch:!!rm?.demo.seedDefect,cheat:!!rm?.demo.cheat},origin:ctx.origin??{kind:'cli'},
  stamp:code==='refused'||code==='refunded'?'abgelehnt':code==='accepted'||code==='paid'||acceptDone||a0?.passed||a1?.passed?'abgenommen':firstFailed?'mangel':null,
  steps,inspections:inspections.map(r=>({...r,failures:r.failures.map(f=>({...f,en:DEFECT_EN[f.code]??null}))})),
  defects:firstFailed?.failures.map(f=>({...f,en:DEFECT_EN[f.code]??null,kind:defectKind(f.code)}))??[],
  protective:protectiveLog?{code:LOG.protective.exec(protectiveLog.line)[1],en:DEFECT_EN[LOG.protective.exec(protectiveLog.line)[1]]??null,textDe:LOG.protective.exec(protectiveLog.line)[2],at:protectiveLog.at}:null,
  cure,mail:ctx.mail??null,txs:allTxs,
  deadlines:{submitResultTime:iso(j.job.submitResultTime),unlockTime:iso(unlock),externalDisputeUnlockTime:iso(j.job.externalDisputeUnlockTime)},
  // An ALARM counts while it is the job's last word (failed or still running with it among the last lines), not after a later resume settled it.
  alarm:['alarm','failed','paid-unaccepted'].includes(code)?alarmLog?.line??j.error??findLastLog(j,LOG.abort)?.line??null:running&&alarmLog&&j.log.slice(-3).includes(alarmLog)?alarmLog.line:null,
  log:j.log.slice(-40),
 };
}

export function summary(t){
 const failed=t.inspections.some(r=>!r.passed),passedLater=t.inspections.some(r=>r.passed);
 const pathLabel=t.path==='deemed'?'Accepted, no defect':t.path==='refusal'?'Defect → refused':t.path==='pending'?'running'
  :failed?(passedLater?'Defect → cure → accepted':'Defect → cure …'):t.protective?'Protective notice → accepted':'running';
 const active=t.steps.find(s=>s.status==='active')?.title??null;
 const next=t.running&&active?`now: ${active}`:t.status.code==='accepted'?'payout pending':t.status.code==='refused'?'refund pending':null;
 return {id:t.id,createdAt:t.createdAt,finishedAt:t.finishedAt,durationMs:t.durationMs,running:t.running,status:t.status,path:t.path,pathLabel,next,
  invoice:t.invoice,demo:t.demo,origin:t.origin,stamp:t.stamp,txCount:t.txs.length,mailed:!!t.mail,
  inspection:{x402:t.inspections.filter(r=>r.x402).length,local:t.inspections.filter(r=>!r.x402).length},
  current:active};
}

// ---------- evidence ----------
const railOf=label=>/x402/i.test(label)?'x402':/registr|NFT/i.test(label)?'registry':/sokosumi/i.test(label)?'sokosumi':/top-up|fund/i.test(label)?'funding':'escrow';
const cells=line=>line.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
// Hashes in a Markdown file with a short label: a run table row (| Step | Time | `hash` | url |), a numbered evidence row, or
// the words in front of the hash.
export function parseEvidenceMd(text,source){
 const out=[];let section=null;
 for(const line of String(text).split('\n')){
  const h=/^#{2,4} (.+)/.exec(line);if(h){section=h[1].trim();continue;}
  const hashes=[...new Set([...line.matchAll(/[0-9a-f]{64}/g)].map(m=>m[0]))];
  if(!hashes.length)continue;
  const c=line.trim().startsWith('|')?cells(line):null;
  for(const hash of hashes){
   let label=null,at=null;
   if(c&&c.length>=4&&c[2]?.includes(hash)&&/^\d{4}-\d{2}-\d{2}T|^$/.test(c[1])){label=c[0];at=c[1]||null;}
   else if(c&&/^\d+$/.test(c[0])){label=c[1];}
   else{const before=line.slice(0,line.indexOf(hash)).replace(/[`[\]]/g,'');label=before.split(/[|,;(]/).at(-1).replace(/[:\s]+$/,'').trim().slice(-48)||null;}
   if(label&&/^https?:/.test(label))label=null;
   out.push({hash,label:label||section,section,at,source});
  }
 }
 return out;
}
export function evidence({timelines=[],payments=[],docs=[]}){
 const map=new Map();
 const add=(hash,o)=>{if(!HEX64.test(hash))return;const prev=map.get(hash);map.set(hash,prev?{...o,...prev,sources:[...new Set([...prev.sources,...o.sources])],runs:[...new Set([...prev.runs,...o.runs])]}:{hash,url:explorerUrl(hash),...o});};
 for(const t of timelines)for(const tx of t.txs)add(tx.hash,{label:tx.label,name:tx.name,rail:tx.rail,at:tx.at,runs:[t.id],invoiceNumber:t.invoice.number,sources:['Journal']});
 for(const p of payments)if(p.status!=='not-charged')add(p.txHash,{label:'x402 inspection',name:`x402 inspection · ${p.verdict??'no report'}`,rail:'x402',at:iso(p.time),runs:[],invoiceNumber:null,sources:['Gutachter-Log']});
 for(const d of docs)for(const e of d.entries)add(e.hash,{label:e.label,name:TX_NAME[e.label]??e.label,rail:railOf(`${e.label} ${e.section}`),at:iso(e.at),runs:[],invoiceNumber:null,sources:[e.source],section:e.section});
 return [...map.values()].sort((a,b)=>String(b.at??'').localeCompare(String(a.at??'')));
}
