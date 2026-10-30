// KoSIT validator daemon client (kosit/start.sh). POST raw XML to / -> 200 acceptable, 406 reject.
export const XRECHNUNG_UBL_SCENARIO='EN16931 XRechnung (UBL Invoice)';
const kositUrl=()=>process.env.KOSIT_URL||'http://127.0.0.1:8090/';
const unescape=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
const attr=(tag,name)=>unescape(tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]??'');

export function parseReport(reportXml){
 const scenario=reportXml.match(/<rep:scenarioMatched>\s*<s:scenario>\s*<s:name>([^<]*)<\/s:name>/)?.[1]??null;
 const messages=[...reportXml.matchAll(/<rep:message\b([^>]*)>([\s\S]*?)<\/rep:message>/g)].map(([,attrs,text])=>({level:attr(attrs,'level'),code:attr(attrs,'code'),text:unescape(text).trim()}));
 const assessment=/<rep:assessment>\s*<rep:accept\b/.test(reportXml)?'accept':/<rep:assessment>\s*<rep:reject\b/.test(reportXml)?'reject':null;
 return {scenario,messages,assessment};
}

export async function kositAvailable(){
 try{return (await fetch(new URL('server/health',kositUrl()),{signal:AbortSignal.timeout(2000)})).ok;}catch{return false;}
}

// accepted requires HTTP 200, a KoSIT "accept" assessment AND the pinned scenario (default: XRechnung UBL invoice).
// Without the pin, an invoice carrying the plain EN16931 CustomizationID is accepted by the "EN16931 (UBL Invoice)"
// scenario even though it skips every BR-DE rule.
export async function validate(xml,{scenario:pinned=XRECHNUNG_UBL_SCENARIO}={}){
 const response=await fetch(kositUrl(),{method:'POST',headers:{'content-type':'application/xml'},body:xml,signal:AbortSignal.timeout(30000)});
 const reportXml=await response.text();
 const httpStatus=response.status;
 if(![200,406].includes(httpStatus))return {accepted:false,httpStatus,scenario:null,messages:[{level:'error',code:`KOSIT-HTTP-${httpStatus}`,text:reportXml.slice(0,500)}],reportXml};
 const {scenario,messages,assessment}=parseReport(reportXml);
 if(scenario!==pinned)messages.push({level:'error',code:'KOSIT-SCENARIO',text:`Matched scenario ${JSON.stringify(scenario)} instead of ${JSON.stringify(pinned)}`});
 return {accepted:httpStatus===200&&assessment==='accept'&&scenario===pinned,httpStatus,scenario,messages,reportXml};
}
