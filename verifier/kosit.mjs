// KoSIT validator daemon client (kosit/start.sh). POST raw XML to / -> 200 acceptable, 406 reject.
import {createHash} from 'node:crypto';
import {loadAcceptance} from './profile.mjs';
export const XRECHNUNG_UBL_SCENARIO='EN16931 XRechnung (UBL Invoice)';
const MAX_XML_BYTES=5*1024*1024;
const kositUrl=()=>process.env.KOSIT_URL||`http://127.0.0.1:${process.env.KOSIT_PORT||8090}/`;
const unescape=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
const attr=(tag,name)=>unescape(tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]??'');

// A report can come from the x402 Gutachter (anyone answering on its port), so the reader must stay linear: element
// spans are found with indexOf, and every regex has a literal start and single-class quantifiers that cannot overlap.
// KoSIT reports for our invoices are about 30 KiB; a larger one than MAX_REPORT_CHARS is not read.
const MAX_REPORT_CHARS=16*1024*1024;
// Text of the first <open>…</close> at or after `from`, or null.
const between=(xml,open,close,from=0)=>{const a=xml.indexOf(open,from);if(a<0)return null;const b=xml.indexOf(close,a+open.length);return b<0?null:xml.slice(a+open.length,b);};
// "XRechnung 3.0.2": digits and dots after the label, cut before the first empty part ("3.0.2." -> 3.0.2, "3..0" -> none).
const versionIn=text=>{for(const [,v] of text.matchAll(/\bXRechnung (\d[\d.]*)/g)){const parts=v.split('.'),cut=parts.indexOf('');const p=cut<0?parts:parts.slice(0,cut);if(p.length>1)return p.join('.');}return null;};
export function parseReport(reportXml){
 if(reportXml.length>MAX_REPORT_CHARS)throw new Error('Der KoSIT-Bericht ist größer als 16 MiB; die Rechnung wurde nicht beurteilt.');
 const scenario=reportXml.match(/<rep:scenarioMatched>\s*<s:scenario>\s*<s:name>([^<]*)<\/s:name>/)?.[1]??null;
 const messages=[];
 for(let i=reportXml.indexOf('<rep:message');i>=0;i=reportXml.indexOf('<rep:message',i+1)){
  if(/\w/.test(reportXml[i+12]??''))continue;// <rep:messages…, not <rep:message
  const gt=reportXml.indexOf('>',i),end=gt<0?-1:reportXml.indexOf('</rep:message>',gt);
  if(end<0)break;// no later message can be closed either
  messages.push({level:attr(reportXml.slice(i+12,gt),'level'),code:attr(reportXml.slice(i+12,gt),'code'),text:unescape(reportXml.slice(gt+1,end)).trim()});
  i=end;
 }
 const assessment=/<rep:assessment>\s*<rep:accept\b/.test(reportXml)?'accept':/<rep:assessment>\s*<rep:reject\b/.test(reportXml)?'reject':null;
 const engine=reportXml.match(/<rep:engine>\s*<rep:name>([^<]*)<\/rep:name>/)?.[1]??null;
 // The XRechnung release the matched scenario names in its description ("... and XRechnung 3.0.2").
 const scenarioAt=reportXml.search(/<rep:scenarioMatched>\s*<s:scenario>/);
 const description=scenarioAt<0?'':between(reportXml,'<s:description>','</s:description>',scenarioAt)??'';
 const xrechnungVersion=versionIn(description.replace(/<[^<>]*>/g,' ').replace(/\s+/g,' '));
 // base64 SHA-256 of the document KoSIT judged (rep:documentIdentification/rep:documentHash): the first
 // <rep:hashValue> after <rep:documentHash> whose text runs up to </rep:hashValue>.
 let documentHash=null;
 const hashAt=reportXml.indexOf('<rep:documentHash>');
 for(let i=hashAt<0?-1:reportXml.indexOf('<rep:hashValue>',hashAt);i>=0&&documentHash==null;i=reportXml.indexOf('<rep:hashValue>',i+1)){
  const lt=reportXml.indexOf('<',i+15);
  if(lt>=0&&reportXml.startsWith('</rep:hashValue>',lt))documentHash=reportXml.slice(i+15,lt);
 }
 return {scenario,messages,assessment,engine:engine&&unescape(engine),xrechnungVersion,documentHash};
}

// What KoSIT writes into rep:documentHash for these bytes (strings are hashed as UTF-8).
export const documentHashOf=xml=>createHash('sha256').update(xml).digest('base64');

// A report about other bytes is no inspection of this invoice: throws (the invoice was not judged). For reports that
// arrive another way, e.g. a replayed or misrouted x402 Gutachter answer.
export function assertDocumentHash({documentHash},xml){
 const expected=documentHashOf(xml);
 if(documentHash!==expected)throw new Error(`Der KoSIT-Bericht gehört zu einem anderen Dokument (${documentHash?`documentHash ${documentHash}`:'documentHash fehlt'}, erwartet ${expected}); die Rechnung wurde nicht beurteilt.`);
}

// 15 s: under parallel test load the JVM can take several seconds to answer, and a skip would hide the acceptance test.
export async function kositAvailable(){
 try{return (await fetch(new URL('server/health',kositUrl()),{signal:AbortSignal.timeout(15000)})).ok;}catch{return false;}
}

// A report from another validator or XRechnung rule release is no inspection under the acceptance profile: throws
// (the invoice was not judged). Also for reports that arrive another way, e.g. from the x402 Gutachter.
// Not pinned (DEPS-4): a KoSIT 1.6.3 report does not name the configuration release (2026-08-31). Its scenario
// description names the Schematron packages (en16931-ubl-1.3.16, xrechnung-3.0.2-schematron-2.6.0), but every field of a
// report is written by whoever answers, so pinning more of them would catch a misconfigured daemon, never a fake one.
// The jar and the configuration are bound by sha256 only when kosit/start.sh starts the daemon.
export function assertPinnedValidator({scenario,engine,xrechnungVersion},{scenario:pinned=XRECHNUNG_UBL_SCENARIO}={}){
 const {validator,configuration}=loadAcceptance(),pinnedEngine=`KoSIT Validator ${validator.version}`;
 if(engine!==pinnedEngine)throw new Error(`Der KoSIT-Prüfer meldet „${engine??'keine Version'}“, festgelegt ist „${pinnedEngine}“; die Rechnung wurde nicht beurteilt.`);
 if(scenario===pinned&&xrechnungVersion!==configuration.xrechnungVersion)throw new Error(`Das KoSIT-Szenario prüft ${xrechnungVersion?`XRechnung ${xrechnungVersion}`:'keine erkennbare XRechnung-Version'}, festgelegt ist XRechnung ${configuration.xrechnungVersion}; die Rechnung wurde nicht beurteilt.`);
}

// accepted requires HTTP 200, a KoSIT "accept" assessment AND the pinned scenario (default: XRechnung UBL invoice).
// Without the pin, an invoice carrying the plain EN16931 CustomizationID is accepted by the "EN16931 (UBL Invoice)"
// scenario even though it skips every BR-DE rule.
export async function validate(xml,{scenario:pinned=XRECHNUNG_UBL_SCENARIO}={}){
 // Same limit and status (413) as the Gutachter's body cap (gutachter/seller.mjs): an oversized delivery is a defect, KoSIT is not asked.
 const bytes=Buffer.byteLength(xml);
 if(bytes>MAX_XML_BYTES)return {accepted:false,httpStatus:413,scenario:null,messages:[{level:'error',code:'KOSIT-SIZE',text:`Die XML-Datei ist größer als 5 MB (${bytes} Bytes) und wurde nicht an den KoSIT-Prüfer gesendet.`}],reportXml:null};
 const response=await fetch(kositUrl(),{method:'POST',headers:{'content-type':'application/xml'},body:xml,signal:AbortSignal.timeout(30000)});
 const reportXml=await response.text();
 const httpStatus=response.status;
 // The daemon answers 200/406 with a report, or 400/422 for a document it cannot read (a defect of the delivery).
 // Every other status (5xx, or 401/403/404/429 from a wrong URL or a proxy) means the invoice was not inspected.
 // Never report that as a defect of the invoice.
 if(![200,406,400,422].includes(httpStatus))throw new Error(`KoSIT-Prüfdienst nicht verfügbar (HTTP ${httpStatus}); die Rechnung wurde nicht beurteilt.`);
 if(![200,406].includes(httpStatus))return {accepted:false,httpStatus,scenario:null,messages:[{level:'error',code:`KOSIT-HTTP-${httpStatus}`,text:reportXml.slice(0,500)}],reportXml};
 const {scenario,messages,assessment,engine,xrechnungVersion}=parseReport(reportXml);
 assertPinnedValidator({scenario,engine,xrechnungVersion},{scenario:pinned});
 if(scenario!==pinned)messages.push({level:'error',code:'KOSIT-SCENARIO',text:`Matched scenario ${JSON.stringify(scenario)} instead of ${JSON.stringify(pinned)}`});
 return {accepted:httpStatus===200&&assessment==='accept'&&scenario===pinned,httpStatus,scenario,engine,messages,reportXml};
}
