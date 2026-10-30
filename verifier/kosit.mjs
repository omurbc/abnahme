// KoSIT validator daemon client (kosit/start.sh). POST raw XML to / -> 200 acceptable, 406 reject.
import {loadAcceptance} from './profile.mjs';
export const XRECHNUNG_UBL_SCENARIO='EN16931 XRechnung (UBL Invoice)';
const kositUrl=()=>process.env.KOSIT_URL||`http://127.0.0.1:${process.env.KOSIT_PORT||8090}/`;
const unescape=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
const attr=(tag,name)=>unescape(tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]??'');

export function parseReport(reportXml){
 const scenario=reportXml.match(/<rep:scenarioMatched>\s*<s:scenario>\s*<s:name>([^<]*)<\/s:name>/)?.[1]??null;
 const messages=[...reportXml.matchAll(/<rep:message\b([^>]*)>([\s\S]*?)<\/rep:message>/g)].map(([,attrs,text])=>({level:attr(attrs,'level'),code:attr(attrs,'code'),text:unescape(text).trim()}));
 const assessment=/<rep:assessment>\s*<rep:accept\b/.test(reportXml)?'accept':/<rep:assessment>\s*<rep:reject\b/.test(reportXml)?'reject':null;
 const engine=reportXml.match(/<rep:engine>\s*<rep:name>([^<]*)<\/rep:name>/)?.[1]??null;
 // The XRechnung release the matched scenario names in its description ("... and XRechnung 3.0.2").
 const description=reportXml.match(/<rep:scenarioMatched>\s*<s:scenario>[\s\S]*?<s:description>([\s\S]*?)<\/s:description>/)?.[1]??'';
 const xrechnungVersion=description.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').match(/\bXRechnung (\d+(?:\.\d+)+)/)?.[1]??null;
 return {scenario,messages,assessment,engine:engine&&unescape(engine),xrechnungVersion};
}

export async function kositAvailable(){
 try{return (await fetch(new URL('server/health',kositUrl()),{signal:AbortSignal.timeout(2000)})).ok;}catch{return false;}
}

// A report from another validator or XRechnung rule release is no inspection under the acceptance profile: throws
// (the invoice was not judged). Also for reports that arrive another way, e.g. from the x402 Gutachter.
export function assertPinnedValidator({scenario,engine,xrechnungVersion},{scenario:pinned=XRECHNUNG_UBL_SCENARIO}={}){
 const {validator,configuration}=loadAcceptance(),pinnedEngine=`KoSIT Validator ${validator.version}`;
 if(engine!==pinnedEngine)throw new Error(`Der KoSIT-Prüfer meldet „${engine??'keine Version'}“, festgelegt ist „${pinnedEngine}“; die Rechnung wurde nicht beurteilt.`);
 if(scenario===pinned&&xrechnungVersion!==configuration.xrechnungVersion)throw new Error(`Das KoSIT-Szenario prüft ${xrechnungVersion?`XRechnung ${xrechnungVersion}`:'keine erkennbare XRechnung-Version'}, festgelegt ist XRechnung ${configuration.xrechnungVersion}; die Rechnung wurde nicht beurteilt.`);
}

// accepted requires HTTP 200, a KoSIT "accept" assessment AND the pinned scenario (default: XRechnung UBL invoice).
// Without the pin, an invoice carrying the plain EN16931 CustomizationID is accepted by the "EN16931 (UBL Invoice)"
// scenario even though it skips every BR-DE rule.
export async function validate(xml,{scenario:pinned=XRECHNUNG_UBL_SCENARIO}={}){
 const response=await fetch(kositUrl(),{method:'POST',headers:{'content-type':'application/xml'},body:xml,signal:AbortSignal.timeout(30000)});
 const reportXml=await response.text();
 const httpStatus=response.status;
 // 5xx: the validator failed, the invoice was not inspected. Never report that as a defect of the invoice.
 // Other statuses (400, 422 for XML that is not well-formed) stay defects of the delivered document.
 if(httpStatus>=500)throw new Error(`KoSIT-Prüfdienst nicht verfügbar (HTTP ${httpStatus}); die Rechnung wurde nicht beurteilt.`);
 if(![200,406].includes(httpStatus))return {accepted:false,httpStatus,scenario:null,messages:[{level:'error',code:`KOSIT-HTTP-${httpStatus}`,text:reportXml.slice(0,500)}],reportXml};
 const {scenario,messages,assessment,engine,xrechnungVersion}=parseReport(reportXml);
 assertPinnedValidator({scenario,engine,xrechnungVersion},{scenario:pinned});
 if(scenario!==pinned)messages.push({level:'error',code:'KOSIT-SCENARIO',text:`Matched scenario ${JSON.stringify(scenario)} instead of ${JSON.stringify(pinned)}`});
 return {accepted:httpStatus===200&&assessment==='accept'&&scenario===pinned,httpStatus,scenario,engine,messages,reportXml};
}
