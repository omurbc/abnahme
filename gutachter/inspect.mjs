// Maps one KoSIT daemon call to the Gutachter's answer: {status, body}.
// status 200 = completed inspection (ACCEPTABLE or REJECT, the buyer pays);
// status >= 400 = no inspection happened, @x402/express then skips settlement. Its body names the cause only: KoSIT's
// URL and raw error page (stack traces) go to the seller log, not to the buyer. It also says charged:false, so the buyer
// does not take it for a 502 that may still settle (a gateway, or the middleware's facilitator error during /settle).
// ACCEPTABLE also requires the pinned XRechnung UBL scenario: under the plain EN16931 scenario KoSIT answers 200 but skips every BR-DE rule.
// A report from another validator or XRechnung release, or about other bytes (rep:documentHash), is no inspection: 502.
// The answer names the validator and the inspected bytes (xmlSha256 hex, documentHash base64) so the buyer can bind it.
import {parseReport,assertPinnedValidator,assertDocumentHash,XRECHNUNG_UBL_SCENARIO} from '../verifier/kosit.mjs';
import {sha256} from './ledger.mjs';
export async function inspect(xml,{url,stub=false,timeoutMs=30_000}){
 if(stub) return {status:200,body:{verdict:'ACCEPTABLE',httpStatus:200,report:'<stub>GUTACHTER_STUB=1, KoSIT not called</stub>'}};
 let res,report;
 // The body is read inside the try: KoSIT breaking off or stalling mid-answer is no inspection either (it used to end the process).
 try{ res=await fetch(url,{method:'POST',headers:{'content-type':'application/xml'},body:xml,signal:AbortSignal.timeout(timeoutMs)}); report=await res.text(); }
 catch(e){ console.error(`KoSIT unreachable at ${url}: ${e.cause?.code??e.name}`); return {status:503,body:{error:'KoSIT unreachable or did not finish its answer',charged:false}}; }
 if(res.status===200||res.status===406){
  let parsed;
  try{ parsed=parseReport(report); assertPinnedValidator(parsed); assertDocumentHash(parsed,xml); }
  catch(e){ console.error(`KoSIT report refused: ${e.message}`); return {status:502,body:{error:'KoSIT report is not from the pinned validator or not about this body',charged:false}}; }
  const {scenario,engine,xrechnungVersion,documentHash}=parsed;
  return {status:200,body:{verdict:res.status===200&&scenario===XRECHNUNG_UBL_SCENARIO?'ACCEPTABLE':'REJECT',httpStatus:res.status,scenario,engine,xrechnungVersion,xmlSha256:sha256(xml),documentHash,report}};
 }
 console.error(`KoSIT answered HTTP ${res.status}: ${report.slice(0,2000)}`);
 return {status:502,body:{error:`KoSIT answered HTTP ${res.status}`,httpStatus:res.status,charged:false}};
}
