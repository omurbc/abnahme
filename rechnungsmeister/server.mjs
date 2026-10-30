// RechnungsMeister: seller agent (MIP-003), forked from the template agent-api.mjs.
// Converts an invoice text into an XRechnung (UBL), checks it with KoSIT, delivers it through a Masumi V2 escrow
// and cures it when the buyer disputes. Run from the repo root:
//   node --env-file=.env --env-file=.local/rechnungsmeister-runtime.env rechnungsmeister/server.mjs
// Demo switches (disclosed, read at job start): DEMO_SEED_DEFECT=1 drops the buyer VAT ID (BT-48) on the first
// attempt only. CHEAT=1 submits a result hash that does not match the delivered bytes (refund demo).
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {sha256} from '../standard-hash.mjs';
import {confirmedState,USDM} from '../paid-task.mjs';
import {extract} from '../einvoice/extract.mjs';
import {buildXml} from '../einvoice/build.mjs';
import {validate} from '../verifier/kosit.mjs';
import {runChecks} from '../verifier/checks.mjs';
import {loadProfile,recipientIds} from '../verifier/profile.mjs';
import {inputHashFor,resultHash,buildResult} from './mip004.mjs';
import {planCure} from './cure.mjs';

const jobsDir='.local/rechnungsmeister-jobs';mkdirSync(jobsDir,{recursive:true,mode:0o700});
const token=process.env.MPS_RUNTIME_TOKEN;
const MINUTE=60000;
const MAX_ATTEMPTS=2; // first delivery + one cure; a further dispute is answered with AuthorizeRefund
const registry=()=>JSON.parse(readFileSync('docs/rechnungsmeister-registration-state.json','utf8'));
const save=job=>writeFileSync(`${jobsDir}/${job.id}.json`,JSON.stringify(job),{mode:0o600});
const load=id=>JSON.parse(readFileSync(`${jobsDir}/${id}.json`,'utf8'));
const allJobs=()=>readdirSync(jobsDir).filter(x=>/^[0-9a-f-]{36}\.json$/.test(x)).map(x=>load(x.replace('.json','')));
async function mps(path,body){
 const response=await fetch(process.env.MPS_URL+'/api/v1'+path,{method:body?'POST':'GET',headers:{token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
 const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(`Payment service ${path} HTTP ${response.status}: ${JSON.stringify(data.error??data.message??'')}`);return data.data;
}
const resolvePayment=blockchainIdentifier=>mps('/payment/resolve-blockchain-identifier',{network:'Preprod',blockchainIdentifier,includeHistory:'true'});

// MPS 0.29.0 POST /payment: payBy <= submitResult-5min, submitResult >= now+15min, unlock >= submitResult+15min,
// externalDisputeUnlock >= unlock+15min. Cure SubmitResult from Disputed is accepted until submitResultTime-5min,
// then until externalDisputeUnlockTime-5min (dispute-window rotation). SetRefundRequested needs unlockTime-3min.
export function deadlines(now){
 return {payByTime:new Date(now+10*MINUTE).toISOString(),submitResultTime:new Date(now+25*MINUTE).toISOString(),unlockTime:new Date(now+45*MINUTE).toISOString(),externalDisputeUnlockTime:new Date(now+65*MINUTE).toISOString()};
}

const schema={input_data:[
 {id:'invoiceText',type:'string',name:'Rechnungstext',data:{description:'Die Rechnung als Text (aus PDF oder E-Mail kopiert).'},validations:[{validation:'min',value:'1'},{validation:'max',value:'16000'}]},
 {id:'recipientProfileId',type:'string',name:'Empfängerprofil',data:{description:`Kennung des Rechnungsempfängers: ${recipientIds().join(', ')}`}},
 {id:'expectedTotal',type:'string',name:'Erwarteter Zahlbetrag',data:{description:'Erwarteter Bruttobetrag in Euro, z. B. 18400.00'}},
 {id:'acceptanceProfileHash',type:'string',name:'Prüfprofil-Hash',data:{description:'SHA-256 (JCS) aus Abnahmeprofil und Empfängerprofil; wird mit dem Ergebnis geprüft.'}},
]};
export function validateInput(input){
 const keys=['acceptanceProfileHash','expectedTotal','invoiceText','recipientProfileId'];
 if(!input||typeof input!=='object'||Object.keys(input).sort().join()!==keys.join())return 'input_data needs exactly invoiceText, recipientProfileId, expectedTotal, acceptanceProfileHash';
 if(typeof input.invoiceText!=='string'||!input.invoiceText.trim()||input.invoiceText.length>16000)return 'invoiceText must be 1-16000 characters';
 if(!recipientIds().includes(input.recipientProfileId))return `recipientProfileId must be one of ${recipientIds().join(', ')}`;
 if(typeof input.expectedTotal!=='string'||!/^\d{1,9}\.\d{2}$/.test(input.expectedTotal))return 'expectedTotal must be a string like 18400.00';
 if(input.acceptanceProfileHash!==loadProfile(input.recipientProfileId).profileHash)return 'acceptanceProfileHash does not match the published acceptance profile for this recipient';
 return null;
}

// Builds, checks and packages one attempt. Pure apart from the KoSIT call.
export async function produceAttempt(job,attempt,fields){
 const {acceptance,recipient,profileHash}=loadProfile(job.input.recipientProfileId);
 const xml=await buildXml(fields);
 const kosit=await validate(xml,{scenario:acceptance.scenario});
 const checks=runChecks({xml,kosit,acceptance,recipient,expectedTotal:Number(job.input.expectedTotal)});
 const {manifest,result}=buildResult({xml,kosit,profileHash,attempt});
 const honest=resultHash(result,job.nonce);
 const submitted=job.demo.cheat?sha256(`CHEAT;${honest}`):honest;
 return {attempt,fields,manifest,result,resultHash:submitted,honestHash:honest,selfCheck:{passed:checks.passed,failures:checks.failures.map(f=>f.code)}};
}

const respond=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data))};
const readBody=async(req,limit)=>{let bytes=0,body='';for await(const part of req){bytes+=part.length;if(bytes>limit)return null;body+=part}return body};
const inFlight=new Set();
const port=Number(process.env.AGENT_API_PORT||21950);

async function startJob(input){
 const nonce=input.identifier_from_purchaser??input.identifierFromPurchaser;
 if(!/^[a-fA-F0-9]{14,26}$/.test(nonce||''))return [400,{error:'Expected hex purchaser nonce (14-26 chars)'}];
 const invalid=validateInput(input.input_data);if(invalid)return [400,{error:invalid}];
 const reg=registry();if(reg.registrationState!=='RegistrationConfirmed'&&reg.registration?.state!=='RegistrationConfirmed')return [503,{error:'Registration not confirmed'}];
 const sourceIndex=Number.isInteger(reg.supportedPaymentSourceIndex)?reg.supportedPaymentSourceIndex:reg.request?.supportedPaymentSources?.length===1?0:null;
 if(sourceIndex==null)return [503,{error:'supportedPaymentSourceIndex unknown'}];
 // Persist before the payment write. Unknown outcomes require inspection, never automatic replay.
 const key=sha256(nonce);const hash=inputHashFor(input.input_data,nonce);let job=allJobs().find(j=>j.nonceKey===key);
 if(job){if(job.inputHash!==hash)return [409,{error:'Nonce already used with another input'}];return job.response?[200,job.response]:[409,{error:'Payment outcome requires inspection'}];}
 job={id:randomUUID(),nonceKey:key,nonce,input:input.input_data,inputHash:hash,status:'awaiting_payment',phase:'payment-pending',attempts:[],disputes:[],
  demo:{seedDefect:process.env.DEMO_SEED_DEFECT==='1',cheat:process.env.CHEAT==='1'}};save(job);
 const payment=await mps('/payment',{network:'Preprod',paymentSourceType:'Web3CardanoV2',supportedPaymentSourceIndex:sourceIndex,inputHash:hash,agentIdentifier:reg.agentIdentifier,identifierFromPurchaser:nonce,
  RequestedFunds:[{unit:USDM,amount:'1000000'}],...deadlines(Date.now()),metadata:JSON.stringify({rechnungsmeisterJob:job.id})});
 job.payment=payment;job.phase='waiting-payment';
 job.response={id:job.id,job_id:job.id,status:'awaiting_payment',input_hash:hash,identifierFromPurchaser:nonce,blockchainIdentifier:payment.blockchainIdentifier,agentIdentifier:reg.agentIdentifier,
  sellerVKey:payment.SmartContractWallet?.walletVkey??reg.sellerVkey,paymentSourceType:'Web3CardanoV2',supportedPaymentSourceIndex:sourceIndex,smartContractAddress:payment.PaymentSource?.smartContractAddress,
  amounts:payment.RequestedFunds.map(({amount,unit})=>({amount,unit})),
  payByTime:Number(payment.payByTime),submitResultTime:Number(payment.submitResultTime),unlockTime:Number(payment.unlockTime),externalDisputeUnlockTime:Number(payment.externalDisputeUnlockTime)};
 save(job);console.log(`job ${job.id} payment requested`,payment.blockchainIdentifier.slice(0,24));
 return [200,job.response];
}

async function submit(job,produced){
 job.attempts.push(produced);job.result=produced.result;job.resultHash=produced.resultHash;job.phase='submit-pending';save(job);
 await mps('/payment/submit-result',{network:'Preprod',blockchainIdentifier:job.payment.blockchainIdentifier,submitResultHash:produced.resultHash});
 job.phase='awaiting-result';save(job);
 console.log(`job ${job.id} attempt ${produced.attempt} submitted${job.demo.cheat?' (CHEAT hash)':''}, self-check ${produced.selfCheck.passed?'passed':produced.selfCheck.failures.join(',')}`);
}

async function authorizeRefund(job,reasons){
 job.phase='refund-pending';job.refundReasons=reasons;save(job);
 await mps('/payment/authorize-refund',{network:'Preprod',blockchainIdentifier:job.payment.blockchainIdentifier});
 job.phase='refund-authorized';job.status='failed';save(job);console.log(`job ${job.id} refund authorized: ${reasons.join(' ')}`);
}

// POST /dispute {jobId, round, failures:[{code,textDe}], kositReport}
async function dispute(body){
 const {jobId,round,failures}=body??{};
 if(!/^[0-9a-f-]{36}$/.test(jobId||'')||!existsSync(`${jobsDir}/${jobId}.json`))return [404,{error:'Job not found'}];
 if(!Number.isInteger(round)||round<1)return [400,{error:'round must be a positive integer'}];
 if(inFlight.has(jobId))return [409,{error:'Job busy, retry'}];
 inFlight.add(jobId);
 try{
  let job=load(jobId);
  const seen=job.disputes.find(d=>d.round===round);
  if(seen)return seen.response?[seen.status,seen.response]:[409,{error:'Dispute outcome requires inspection'}];
  if(job.phase!=='result-confirmed')return [409,{error:`Job is ${job.phase}, retry when the result is confirmed on chain`}];
  const payment=await resolvePayment(job.payment.blockchainIdentifier);
  if(payment.onChainState!=='Disputed'||payment.NextAction?.requestedAction!=='WaitingForExternalAction')return [409,{error:`Escrow is ${payment.onChainState}/${payment.NextAction?.requestedAction}, retry when Disputed`}];
  const entry={round,receivedAt:new Date().toISOString(),failures:Array.isArray(failures)?failures.map(f=>({code:String(f.code),textDe:String(f.textDe??'')})):[],kositReportSha256:typeof body.kositReport==='string'?sha256(body.kositReport):null};
  job.disputes.push(entry);save(job);
  const finish=(status,response)=>{Object.assign(entry,{status,response});save(job);return [status,response]};
  const last=job.attempts.at(-1);
  if(job.attempts.length>=MAX_ATTEMPTS){await authorizeRefund(job,['Nachbesserung ausgeschöpft.']);return finish(200,{status:'refund-authorized',reasons:job.refundReasons});}
  const {recipient}=loadProfile(job.input.recipientProfileId);
  const plan=planCure({failures:entry.failures,current:last.fields,fields0:job.fields0,inputData:job.input,recipient});
  if(!plan.ok){await authorizeRefund(job,plan.reasons);return finish(422,{status:'cure-rejected',reasons:plan.reasons});}
  const produced=await produceAttempt(job,last.attempt+1,{...last.fields,...plan.patch});
  produced.cure={patch:plan.patch,sources:plan.sources,retransmit:plan.retransmit};
  if(!produced.selfCheck.passed){await authorizeRefund(job,[`Nachbesserung besteht die eigene Prüfung nicht: ${produced.selfCheck.failures.join(', ')}`]);return finish(422,{status:'cure-rejected',reasons:job.refundReasons});}
  await submit(job,produced);
  return finish(200,{status:'cure-submitted',attempt:produced.attempt,patch:plan.patch,sources:plan.sources});
 }finally{inFlight.delete(jobId)}
}

if(import.meta.main){
 createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://127.0.0.1');
   if(req.method==='GET'&&url.pathname==='/availability')return respond(res,200,{status:'available',type:'masumi-agent',message:'RechnungsMeister: Rechnung → XRechnung, KoSIT-geprüft'});
   if(req.method==='GET'&&url.pathname==='/input_schema')return respond(res,200,schema);
   if(req.method==='GET'&&url.pathname==='/status'){
    const id=url.searchParams.get('job_id');if(!/^[0-9a-f-]{36}$/.test(id||''))return respond(res,400,{error:'Invalid job_id'});
    if(!existsSync(`${jobsDir}/${id}.json`))return respond(res,404,{error:'Job not found'});
    const job=load(id);const delivered=['awaiting-result','result-confirmed','refund-pending','refund-authorized'].includes(job.phase)&&job.result;
    return respond(res,200,{id,job_id:id,status:job.status,phase:job.phase,attempt:job.attempts.at(-1)?.attempt??0,result:delivered?job.result:undefined,demo:job.demo});
   }
   if(req.method!=='POST'||!['/start_job','/dispute'].includes(url.pathname))return respond(res,404,{error:'Route not found'});
   const body=await readBody(req,url.pathname==='/dispute'?2_000_000:40000);if(body==null)return respond(res,413,{error:'Request too large'});
   let parsed;try{parsed=JSON.parse(body)}catch{return respond(res,400,{error:'Invalid JSON'})}
   const [status,data]=url.pathname==='/start_job'?await startJob(parsed):await dispute(parsed);
   return respond(res,status,data);
  }catch(e){console.error('request failed',e.message);respond(res,500,{error:'Request failed. Inspect the saved job state before retrying.'})}
 }).listen(port,'127.0.0.1',()=>console.log('RechnungsMeister API running',port,`(seed defect ${process.env.DEMO_SEED_DEFECT==='1'?'on':'off'}, cheat ${process.env.CHEAT==='1'?'on':'off'})`));

 let busy=false;
 setInterval(async()=>{
  if(busy)return;busy=true;
  try{for(const {id} of allJobs()){
   if(inFlight.has(id))continue;inFlight.add(id);
   const job=load(id);
   try{
    if(!['waiting-payment','awaiting-result'].includes(job.phase))continue;
    const payment=await resolvePayment(job.payment.blockchainIdentifier);
    if(job.phase==='awaiting-result'){
     const expected=job.attempts.length>1?'Disputed':'ResultSubmitted';
     if(payment.resultHash===job.resultHash&&['ResultSubmitted','Disputed'].includes(payment.onChainState)&&confirmedState(payment,payment.onChainState)){job.phase='result-confirmed';job.status='completed';save(job);console.log(`job ${id} attempt ${job.attempts.length} confirmed (${payment.onChainState}, expected ${expected})`)}
     continue;
    }
    if(payment.onChainState!=='FundsLocked'||!confirmedState(payment,'FundsLocked'))continue;
    if(Number(payment.submitResultTime)<=Date.now()+5*MINUTE){job.phase='deadline-blocked';job.status='failed';save(job);continue;}
    job.phase='model-pending';job.status='running';save(job);
    job.fields0=await extract(job.input.invoiceText);save(job);
    const fields=job.demo.seedDefect?{...job.fields0,buyerVatId:null}:job.fields0;
    const produced=await produceAttempt(job,1,fields);
    if(job.demo.seedDefect)produced.seededDefect='BT-48 (buyerVatId) removed, DEMO_SEED_DEFECT=1';
    if(Number(payment.submitResultTime)<=Date.now()+5*MINUTE){job.phase='deadline-blocked';job.status='failed';save(job);continue;}
    await submit(job,produced);
   }catch(e){console.error('RechnungsMeister job needs inspection',id,e.message)}
   finally{inFlight.delete(id)}
  }}finally{busy=false}
 },5000);
}
