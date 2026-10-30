// Maps one KoSIT daemon call to the Gutachter's answer: {status, body}.
// status 200 = completed inspection (ACCEPTABLE or REJECT, the buyer pays);
// status >= 400 = no inspection happened, @x402/express then skips settlement. Its body names the cause only: KoSIT's
// URL and raw error page (stack traces) go to the seller log, not to the buyer.
// ACCEPTABLE also requires the pinned XRechnung UBL scenario: under the plain EN16931 scenario KoSIT answers 200 but skips every BR-DE rule.
import {parseReport,XRECHNUNG_UBL_SCENARIO} from '../verifier/kosit.mjs';
export async function inspect(xml,{url,stub=false,timeoutMs=30_000}){
 if(stub) return {status:200,body:{verdict:'ACCEPTABLE',httpStatus:200,report:'<stub>GUTACHTER_STUB=1, KoSIT not called</stub>'}};
 let res;
 try{ res=await fetch(url,{method:'POST',headers:{'content-type':'application/xml'},body:xml,signal:AbortSignal.timeout(timeoutMs)}); }
 catch(e){ console.error(`KoSIT unreachable at ${url}: ${e.cause?.code??e.name}`); return {status:503,body:{error:'KoSIT unreachable'}}; }
 const report=await res.text();
 if(res.status===200||res.status===406){
  const {scenario}=parseReport(report);
  return {status:200,body:{verdict:res.status===200&&scenario===XRECHNUNG_UBL_SCENARIO?'ACCEPTABLE':'REJECT',httpStatus:res.status,scenario,report}};
 }
 console.error(`KoSIT answered HTTP ${res.status}: ${report.slice(0,2000)}`);
 return {status:502,body:{error:`KoSIT answered HTTP ${res.status}`,httpStatus:res.status}};
}
