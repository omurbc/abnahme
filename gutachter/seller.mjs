// Gutachter (inspector): an x402 seller on Cardano preprod, based on the x402-express template.
// POST /inspect with raw XRechnung UBL XML, 1 tADA per call. The XML goes to the KoSIT daemon
// (200 = acceptable, 406 = reject). A REJECT is a completed, paid inspection.
// Any handler status >= 400 (bad input, KoSIT down) cancels settlement in @x402/express, so the buyer is not charged.
import express from 'express';
import {paymentMiddleware,x402ResourceServer} from '@x402/express';
import {HTTPFacilitatorClient} from '@x402/core/server';
import {ExactCardanoScheme} from '@x402/cardano/exact/server';
import {inspect} from './inspect.mjs';

const NETWORK='cardano:preprod';
const PRICE={amount:'1000000',asset:'lovelace'};
const payTo=process.env.GUTACHTER_SELLER_ADDRESS;
const facilitatorUrl=process.env.FACILITATOR_URL??'https://x402.preprod.dev.ecosyseng.cf-deployments.org';
const kositUrl=process.env.KOSIT_URL??'http://127.0.0.1:8090/';
const stub=process.env.GUTACHTER_STUB==='1';
const port=Number(process.env.GUTACHTER_PORT??4021);
if(!payTo?.startsWith('addr_test1')) throw new Error('Set GUTACHTER_SELLER_ADDRESS (run npm run wallet)');

const resourceServer=new x402ResourceServer(new HTTPFacilitatorClient({url:facilitatorUrl}));
resourceServer.register(NETWORK,new ExactCardanoScheme());

const app=express();
app.use((_req,res,next)=>{ res.set('Cache-Control','no-store'); next(); });
app.use(paymentMiddleware({
 'POST /inspect':{
  accepts:[{scheme:'exact',network:NETWORK,price:PRICE,payTo}],
  description:'KoSIT XRechnung inspection (validator 1.6.3, XRechnung config 2026-08-31), 1 tADA',
  mimeType:'application/json',
 },
},resourceServer));
app.post('/inspect',express.text({type:()=>true,limit:'5mb'}),async(req,res)=>{
 const xml=typeof req.body==='string'?req.body:'';
 if(!xml.trim().startsWith('<')) return res.status(400).json({error:'Body must be raw XRechnung UBL XML'});
 const {status,body}=await inspect(xml,{url:kositUrl,stub});
 console.log(`${new Date().toISOString()} inspect -> ${status} ${body.verdict??body.error}`);
 res.status(status).json(body);
});
app.get('/health',(_req,res)=>res.json({ok:true,stub,kositUrl,facilitatorUrl,payTo}));

app.listen(port,()=>{
 console.log(`Gutachter listening on http://localhost:${port}`);
 console.log(`Paid route: POST /inspect (${Number(PRICE.amount)/1e6} tADA on ${NETWORK}) payTo ${payTo}`);
 console.log(`Facilitator: ${facilitatorUrl}`);
 console.log(stub?'KoSIT: STUB mode, every inspection is ACCEPTABLE':`KoSIT: ${kositUrl}`);
});
