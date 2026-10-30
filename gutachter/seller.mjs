// Gutachter (inspector): an x402 seller on Cardano preprod, based on the x402-express template.
// POST /inspect with raw XRechnung UBL XML, 1 tADA per call. The XML goes to the KoSIT daemon
// (200 = acceptable, 406 = reject). A REJECT is a completed, paid inspection.
// Any handler status >= 400 (bad input, KoSIT down) cancels settlement in @x402/express, so the buyer is not charged.
// One payment buys one inspection: ledger.mjs caches the answer and the settle receipt per payment tx.
import {fileURLToPath} from 'node:url';
import express from 'express';
import {paymentMiddleware,x402ResourceServer} from '@x402/express';
import {HTTPFacilitatorClient} from '@x402/core/server';
import {decodePaymentSignatureHeader,encodePaymentResponseHeader} from '@x402/core/http';
import {ExactCardanoScheme} from '@x402/cardano/exact/server';
import {decodeCardanoTransaction} from '@x402/cardano';
import {inspect} from './inspect.mjs';
import {openLedger,sha256} from './ledger.mjs';
import {checkEnv} from '../scripts/env-split.mjs';

// The seller holds no key (payTo is an address), so it refuses to run next to the project's secrets.
const unneeded=checkEnv(process.env,'gutachter-seller');
if(unneeded.length) throw new Error(`The Gutachter needs no secrets but holds ${unneeded.join(', ')}: start it with npm run seller (../.local/env/gutachter-seller.env)`);

const NETWORK='cardano:preprod';
const PRICE={amount:'1000000',asset:'lovelace'};
const payTo=process.env.GUTACHTER_SELLER_ADDRESS;
const facilitatorUrl=process.env.FACILITATOR_URL??'https://x402.preprod.dev.ecosyseng.cf-deployments.org';
const kositUrl=process.env.KOSIT_URL||`http://127.0.0.1:${process.env.KOSIT_PORT||8090}/`;
const stub=process.env.GUTACHTER_STUB==='1';
const port=Number(process.env.GUTACHTER_PORT??4021);
const host=process.env.GUTACHTER_HOST||'127.0.0.1';
const ledger=openLedger(process.env.GUTACHTER_LEDGER??fileURLToPath(new URL('./.local/ledger.json',import.meta.url)));
if(!payTo?.startsWith('addr_test1')) throw new Error('Set GUTACHTER_SELLER_ADDRESS (run npm run wallet)');

const facilitator=new HTTPFacilitatorClient({url:facilitatorUrl});
const resourceServer=new x402ResourceServer(facilitator);
resourceServer.register(NETWORK,new ExactCardanoScheme());
// The canonical tx hash identifies a payment: the nonce may name any input of the tx, in any letter case.
const paymentTx=paymentPayload=>decodeCardanoTransaction(String(paymentPayload.payload.transaction)).txHash;
resourceServer.onBeforeSettle(({paymentPayload,requirements})=>ledger.remember(paymentTx(paymentPayload),{payload:paymentPayload,requirements}));
resourceServer.onAfterSettle(({paymentPayload,result})=>ledger.settled(paymentTx(paymentPayload),result));

// The exact bytes the buyer sent go to KoSIT, the ledger and the documentHash check: express.text decoded the body and
// stripped a leading BOM, so the report named other bytes than the buyer's (DELTA-X402-5).
const raw=express.raw({type:()=>true,limit:'5mb'});
const bodyBytes=req=>Buffer.isBuffer(req.body)?req.body:Buffer.alloc(0);
const app=express();
app.disable('x-powered-by');
app.use((_req,res,next)=>{ res.set('Cache-Control','no-store'); next(); });
// A resend of a payment the ledger already knows does not go through /verify again: the hosted facilitator rejects
// /verify (nonce_not_on_chain) once the tx is in a block. Same body: the stored answer with the stored receipt, or
// with a fresh /settle of the stored payment if the first settle answer was lost. Other body: 409.
app.post('/inspect',(req,res,next)=>{
 let tx; try{ tx=paymentTx(decodePaymentSignatureHeader(req.get('payment-signature'))); }catch{ return next(); }
 if(!ledger.knows(tx)) return next();
 raw(req,res,async err=>{
  if(err) return next(err);
  try{
   const {status,body,receipt,cached}=await ledger.resend(tx,sha256(bodyBytes(req)),payment=>facilitator.settle(payment.payload,payment.requirements));
   console.log(`${new Date().toISOString()} resend -> ${status} ${body.verdict??body.error??receipt?.errorReason}${cached?' (cached)':''} tx ${tx}`);
   if(receipt) res.set('PAYMENT-RESPONSE',encodePaymentResponseHeader(receipt));
   res.status(status).json(body);
  }catch(e){ console.error(`${new Date().toISOString()} resend settle failed tx ${tx}: ${e.message}`); res.status(502).json({error:'Facilitator did not answer, resend the same payment later'}); }
 });
});
app.use(paymentMiddleware({
 'POST /inspect':{
  accepts:[{scheme:'exact',network:NETWORK,price:PRICE,payTo}],
  description:'KoSIT XRechnung inspection (validator 1.6.3, XRechnung config 2026-08-31), 1 tADA',
  mimeType:'application/json',
 },
},resourceServer));
// Express 4 does not catch a rejected async handler: the process ended (DELTA-X402-1). A failure here is no inspection,
// and a status >= 400 makes the middleware skip settlement.
app.post('/inspect',raw,async(req,res)=>{
 try{
  const xml=bodyBytes(req);
  if(!xml.toString('utf8').trim().startsWith('<')) return res.status(400).json({error:'Body must be raw XRechnung UBL XML',charged:false});
  const tx=paymentTx(decodePaymentSignatureHeader(req.get('payment-signature'))); // verified by the middleware
  const {status,body,cached}=await ledger.inspectOnce(tx,sha256(xml),()=>inspect(xml,{url:kositUrl,stub}));
  console.log(`${new Date().toISOString()} inspect -> ${status} ${body.verdict??body.error}${cached?' (cached)':''} tx ${tx}`);
  res.status(status).json(body);
 }catch(e){ console.error(`${new Date().toISOString()} inspect failed: ${e.message}`); res.status(502).json({error:'Inspection failed, nothing was charged',charged:false}); }
});
app.get('/health',(_req,res)=>res.json({ok:true})); // config is in the startup log, not on the wire
// Body parser errors (413, 415, 400) and anything else: a fixed JSON message. Express's own error page carries the stack
// trace and absolute paths outside production (DELTA-X402-6); npm run seller also sets NODE_ENV=production.
app.use((err,_req,res,_next)=>{ const status=err.status>=400&&err.status<500?err.status:500; res.status(status).json({error:status===413?'Body larger than 5 MB':status<500?'Bad request body':'Internal error'}); });

app.listen(port,host,()=>{
 console.log(`Gutachter listening on http://${host}:${port}`);
 console.log(`Paid route: POST /inspect (${Number(PRICE.amount)/1e6} tADA on ${NETWORK}) payTo ${payTo}`);
 console.log(`Facilitator: ${facilitatorUrl}`);
 console.log(stub?'KoSIT: STUB mode, every inspection is ACCEPTABLE':`KoSIT: ${kositUrl}`);
});
