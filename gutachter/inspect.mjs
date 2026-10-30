// Maps one KoSIT daemon call to the Gutachter's answer: {status, body}.
// status 200 = completed inspection (ACCEPTABLE or REJECT, the buyer pays);
// status >= 400 = no inspection happened, @x402/express then skips settlement.
export async function inspect(xml,{url,stub=false,timeoutMs=30_000}){
 if(stub) return {status:200,body:{verdict:'ACCEPTABLE',httpStatus:200,report:'<stub>GUTACHTER_STUB=1, KoSIT not called</stub>'}};
 let res;
 try{ res=await fetch(url,{method:'POST',headers:{'content-type':'application/xml'},body:xml,signal:AbortSignal.timeout(timeoutMs)}); }
 catch(e){ return {status:503,body:{error:`KoSIT unreachable at ${url}: ${e.cause?.code??e.name}`}}; }
 const report=await res.text();
 if(res.status===200||res.status===406) return {status:200,body:{verdict:res.status===200?'ACCEPTABLE':'REJECT',httpStatus:res.status,report}};
 return {status:502,body:{error:`KoSIT answered HTTP ${res.status}`,httpStatus:res.status,report}};
}
