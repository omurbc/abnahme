// Abnahme-Board: the demo board, a read-only view of what the agents already write, live over Server-Sent Events.
// Loopback only, 127.0.0.1:8787 (BOARD_PORT). Run from the repo root with its own env profile (Blockfrost for confirmations,
// the read-only MPS key for live tx history; no buyer key, no mnemonic):
//   node --env-file=.local/env/board.env --import=./scripts/env-guard.mjs board/server.mjs
// Sources, all read-only: .local/abnahme-journal/ (Büro-Agent), .local/rechnungsmeister-jobs/ (files, never the API),
// gutachter/payments.log.json, .local/sent-ledger.json + Mailpit (GET /api/v1/messages), the Sokosumi Task files in .local/,
// MPS GET /purchase and GET /payment (MPS_READ_TOKEN), Blockfrost /blocks/latest and /txs/{hash}, plan/EVIDENCE.md, README.md.
// The one write: POST /api/demo starts ONE buero/run.mjs at a time (a real purchase, 1 tUSDM), only from this page.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {existsSync,readFileSync,readdirSync,statSync,writeFileSync,mkdtempSync,openSync,closeSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {escrowTxs} from '../buero/escrow.mjs';
import {parseTask} from '../buero/sokosumi.mjs';
import {canonicalJson,loadProfile,recipientIds} from '../verifier/profile.mjs';
import {sha256} from '../standard-hash.mjs';
import {safeJournal,safeRmJob,safeLedger,timeline,summary,evidence,parseEvidenceMd} from './model.mjs';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
const PUBLIC=fileURLToPath(new URL('./public/',import.meta.url));
const BLOCKFROST='https://cardano-preprod.blockfrost.io/api/v0';
const DEMO_FIXTURE='fixtures/b-abschlag-13b-bau-isar.txt',DEMO_NUMBER='AR-2026-0087';
const STATIC={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/styles.css':['styles.css','text/css; charset=utf-8'],'/favicon.svg':['favicon.svg','image/svg+xml']};
const CSP="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const LOOPBACK=new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);
const JOURNAL_ID=/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9-]+Z-[0-9a-f]{6}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Re-parse a file only when its mtime or size changed; an unreadable file keeps its last good value.
function fileCache(){
 const cache=new Map();
 return (path,parse)=>{
  let st;try{st=statSync(path);}catch{cache.delete(path);return null;}
  const key=`${st.mtimeMs}:${st.size}`,hit=cache.get(path);
  if(hit?.key===key)return hit.value;
  let value=hit?.value??null;try{value=parse(readFileSync(path,'utf8'));}catch{}
  cache.set(path,{key,value});return value;
 };
}
const list=(dir,re)=>{try{return readdirSync(dir).filter(f=>re.test(f)).sort();}catch{return [];}};
const munichStamp=d=>new Intl.DateTimeFormat('de-DE',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(d).replaceAll(':','');
const inputKeyOf=({invoiceText,recipientProfileId,expectedTotal})=>sha256(canonicalJson({invoiceText,recipientProfileId,expectedTotal:Number(expectedTotal).toFixed(2)}));

// Labelled escrow txs from MPS purchase + payment records, with the block height of each (for confirmations).
function chainTxsOf(purchase,payment){
 const heights=new Map();
 for(const r of [purchase,payment].filter(Boolean))for(const tx of [...(r.TransactionHistory??[]),r.CurrentTransaction].filter(Boolean))if(tx.txHash&&tx.blockHeight)heights.set(tx.txHash,tx.blockHeight);
 return escrowTxs(purchase,payment).map(t=>({label:t.label,txHash:t.txHash,status:t.status,at:t.at,blockHeight:heights.get(t.txHash)??null}));
}

// The default demo runner: one buero/run.mjs with the buyer's own env file, in a clean environment (so the board's
// ABNAHME_ENV_PROFILE and keys never reach it), output appended to .local/board-demo.log.
function spawnRun({root,file}){
 const log=openSync(join(root,'.local/board-demo.log'),'a',0o600);
 const child=spawn(process.execPath,['--env-file=.local/env/buero.env','--import=./scripts/env-guard.mjs','buero/run.mjs',file,'bau-isar','18400.00','--follow'],
  {cwd:root,env:{PATH:process.env.PATH??'',HOME:process.env.HOME??''},stdio:['ignore',log,log],detached:true});
 closeSync(log);child.unref();
 return child;
}

export function createBoard({
 root=ROOT,port=Number(process.env.BOARD_PORT||8787),env=process.env,fetchImpl=fetch,now=()=>Date.now(),runDemo=spawnRun,
 mailpitUrl=env.MAILPIT_URL||'http://127.0.0.1:8025',mpsUrl=env.MPS_URL||'http://127.0.0.1:38127',
}={}){
 const p=rel=>join(root,rel);
 const read=fileCache();
 const nonce=randomBytes(24).toString('hex');
 const hosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`]),origins=new Set([...hosts].map(h=>`http://${h}`));
 const recipients=Object.fromEntries(recipientIds().map(id=>{const {recipient,profileHash}=loadProfile(id);return [profileHash,{id,name:recipient.name}];}));
 const live={mails:null,mailpit:'unknown',purchases:new Map(),payments:new Map(),mps:env.MPS_READ_TOKEN?'unknown':'off',tip:null,blockfrost:env.BLOCKFROST_API_KEY_PREPROD?'unknown':'off',heights:{},heightTried:{}};
 const demoPath=p('.local/board-demo.json');
 let demo=(()=>{try{return JSON.parse(readFileSync(demoPath,'utf8'));}catch{return {running:false};}})();
 const saveDemo=()=>{writeFileSync(demoPath+'.tmp',JSON.stringify(demo),{mode:0o600});renameSync(demoPath+'.tmp',demoPath);};
 const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
 if(demo.running&&!(demo.pid&&alive(demo.pid))){demo={...demo,running:false,finishedAt:demo.finishedAt??new Date(now()).toISOString()};}

 // ---------- snapshot of every source ----------
 function snapshot(){
  const journals=list(p('.local/abnahme-journal'),/^[0-9T-]+Z-[0-9a-f]{6}\.json$/).map(f=>read(p(`.local/abnahme-journal/${f}`),t=>safeJournal(JSON.parse(t)))).filter(j=>j&&JOURNAL_ID.test(j.id));
  const payments=read(p('gutachter/payments.log.json'),JSON.parse)??[];
  const ledger=safeLedger(read(p('.local/sent-ledger.json'),t=>JSON.parse(t).entries));
  // The worker's store of accepted invoices: which PRÜFEN (purchase) accepted the XML that a SENDEN mailed.
  const accepted=read(p('.local/abnahmen.json'),t=>Object.fromEntries(Object.entries(JSON.parse(t)).map(([n,v])=>[n,{purchaseId:v.purchaseId??null,xmlSha256:v.xmlSha256??null,acceptedAt:v.acceptedAt??null}])))??{};
  // Sokosumi Tasks the worker keeps in .local/<taskId>.json: completed ones name their journal, running ones match by input.
  const tasks=list(p('.local'),/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/).map(f=>read(p(`.local/${f}`),t=>{
   const task=JSON.parse(t);if(typeof task.input!=='string')return null;
   let inputKey=null,kind=null;try{const job=parseTask(task.input);kind=job.kind;if(job.kind==='PRUEFEN')inputKey=inputKeyOf(job);}catch{}
   return {taskId:f.slice(0,-5),kind,inputKey,journalId:/^Auftrag (\S+):/.exec(task.completion?.result??'')?.[1]??null};
  })).filter(Boolean);
  const timelines=journals.map(j=>{
   const rmJob=UUID.test(j.job.id??'')?read(p(`.local/rechnungsmeister-jobs/${j.job.id}.json`),t=>safeRmJob(JSON.parse(t))):null;
   const purchase=live.purchases.get(j.job.blockchainIdentifier),payment=live.payments.get(j.job.blockchainIdentifier);
   const task=tasks.find(t=>t.journalId===j.id)??(j.stage!=='done'?tasks.find(t=>!t.journalId&&t.inputKey&&t.inputKey===j.inputKey):null);
   const origin=demo.inputKey&&demo.inputKey===j.inputKey?{kind:'board'}:task?{kind:'sokosumi',taskId:task.taskId}:{kind:'cli'};
   // An e-mail belongs to this job only if this job's purchase accepted exactly the mailed XML before it was sent.
   const sent=j.xml&&j.purchaseId&&ledger.find(e=>{const a=accepted[e.invoiceNumber];
    return e.status==='sent'&&e.xmlSha256===j.xml.sha256&&a?.purchaseId===j.purchaseId&&a.xmlSha256===e.xmlSha256&&Date.parse(a.acceptedAt)<=Date.parse(e.sentAt);});
   const mail=sent?{to:sent.to,sentAt:sent.sentAt,messageId:sent.messageId,taskId:sent.taskId,subject:`XRechnung ${sent.invoiceNumber}`,
    inMailpit:live.mails?live.mails.some(m=>`<${m.messageId}>`===sent.messageId):null}:null;
   return timeline(j,{rmJob,payments,mail,chainTxs:purchase||payment?chainTxsOf(purchase,payment):null,escrowState:purchase?.onChainState??null,
    tip:live.tip,heights:live.heights,origin,recipients,now:now()});
  }).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
  return {journals,timelines,payments};
 }

 let current=null;
 function build(){
  const snap=snapshot();
  const demoJob=demo.inputKey?snap.timelines.find(t=>t.origin.kind==='board'):null;
  // Live: the board's own demo run, else the newest job still moving (not only waiting for its payout), else the newest.
  const liveT=(demoJob&&(demo.running||demoJob===snap.timelines[0])?demoJob:null)||snap.timelines.find(t=>t.running&&t.stage!=='follow')||snap.timelines[0]||null;
  const state={network:'preprod',liveId:liveT?.id??null,live:liveT,jobs:snap.timelines.map(summary),
   demo:{running:!!demo.running,startedAt:demo.startedAt??null,invoiceNumber:demo.invoiceNumber??null,journalId:demoJob?.id??null,finishedAt:demo.finishedAt??null,exitCode:demo.exitCode??null},
   sources:{journals:snap.timelines.length,mailpit:live.mailpit,mps:live.mps,blockfrost:live.blockfrost,tip:live.tip}};
  const version=sha256(JSON.stringify(state,(k,v)=>k==='durationMs'?undefined:v)).slice(0,16);
  current={...snap,state:{version,...state}};
  return current;
 }

 // ---------- live pollers ----------
 const anyRunning=()=>demo.running||current?.timelines.some(t=>t.running);
 async function getJson(url,headers={},ms=8000){const r=await fetchImpl(url,{headers,redirect:'error',signal:AbortSignal.timeout(ms)});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json();}
 async function pollMailpit(){
  try{const d=await getJson(`${mailpitUrl}/api/v1/messages?limit=100`);live.mails=(d.messages??[]).map(m=>({messageId:m.MessageID,to:m.To?.[0]?.Address??null,subject:m.Subject,created:m.Created}));live.mailpit='ok';}
  catch{live.mailpit='down';}
 }
 async function pollMps(){
  if(!env.MPS_READ_TOKEN)return;
  const contracts=[...new Set((current?.journals??[]).map(j=>j.job.smartContractAddress).filter(Boolean))];
  try{
   for(const c of contracts)for(const [kind,key,store] of [['purchase','Purchases',live.purchases],['payment','Payments',live.payments]]){
    const d=await getJson(`${mpsUrl}/api/v1/${kind}?network=Preprod&limit=100&includeHistory=true&filterSmartContractAddress=${encodeURIComponent(c)}`,{token:env.MPS_READ_TOKEN});
    for(const r of d.data?.[key]??[])store.set(r.blockchainIdentifier,r);
   }
   live.mps='ok';
  }catch{live.mps='down';}
 }
 // Block heights for the live job's txs that MPS does not carry (x402 payments), once each, then the chain tip.
 async function pollChain(){
  if(!env.BLOCKFROST_API_KEY_PREPROD)return;
  const headers={project_id:env.BLOCKFROST_API_KEY_PREPROD};
  try{
   const tip=await getJson(`${BLOCKFROST}/blocks/latest`,headers);live.tip=tip.height??live.tip;
   const fromMps=new Set([...live.purchases.values(),...live.payments.values()].flatMap(r=>[...(r.TransactionHistory??[]),r.CurrentTransaction].filter(t=>t?.blockHeight).map(t=>t.txHash)));
   for(const tx of current?.state.live?.txs??[]){
    if(live.heights[tx.hash]||fromMps.has(tx.hash)||now()-(live.heightTried[tx.hash]??0)<20000)continue;
    live.heightTried[tx.hash]=now();
    try{const t=await getJson(`${BLOCKFROST}/txs/${tx.hash}`,headers);if(t.block_height)live.heights[tx.hash]=t.block_height;}catch{}
   }
   live.blockfrost='ok';
  }catch{live.blockfrost='down';}
 }

 // ---------- SSE ----------
 const clients=new Set();
 let lastVersion=null;
 function broadcast(){
  const {state}=build();
  if(state.version===lastVersion)return;
  lastVersion=state.version;
  const msg=`event: state\ndata: ${JSON.stringify(state)}\n\n`;
  for(const res of clients)res.write(msg);
 }

 // ---------- demo ----------
 function startDemo(){
  if(demo.running)return [409,{error:'A demo run is already in progress. Wait until it has finished.'}];
  const invoiceNumber=`AR-2026-D${munichStamp(new Date(now()))}`;
  const fixture=readFileSync(p(DEMO_FIXTURE),'utf8');
  const invoiceText=fixture.replaceAll(DEMO_NUMBER,invoiceNumber);
  const file=join(mkdtempSync(join(tmpdir(),'abnahme-board-')),`${invoiceNumber}.txt`);
  writeFileSync(file,invoiceText,{mode:0o600});
  const child=runDemo({root,file});
  demo={running:true,pid:child.pid??null,startedAt:new Date(now()).toISOString(),invoiceNumber,file,inputKey:inputKeyOf({invoiceText,recipientProfileId:'bau-isar',expectedTotal:'18400.00'})};
  saveDemo();
  const ended=code=>{if(!demo.running)return;demo={...demo,running:false,exitCode:code,finishedAt:new Date(now()).toISOString()};saveDemo();broadcast();};
  child.on?.('exit',ended);child.on?.('error',e=>{console.error('demo run failed to start',e.message);ended(null);});
  broadcast();
  return [202,{started:true,invoiceNumber}];
 }
 // A run started before a board restart: no exit event, so watch its pid.
 function watchDemo(){if(demo.running&&demo.pid&&!alive(demo.pid)){demo={...demo,running:false,finishedAt:new Date(now()).toISOString()};saveDemo();}}

 // ---------- HTTP ----------
 const send=(res,status,body,type='application/json; charset=utf-8',extra={})=>{
  res.writeHead(status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':CSP,'cross-origin-resource-policy':'same-origin',...extra});
  res.end(typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body));
 };
 const same=(a,b)=>typeof a==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
 async function handler(req,res){
  try{
   // Loopback peers and our own Host only: a page on another origin (or a DNS-rebound name) gets nothing.
   if(!LOOPBACK.has(req.socket.remoteAddress))return send(res,403,{error:'loopback only'});
   if(!hosts.has(req.headers.host??''))return send(res,421,{error:'unexpected Host header'});
   const url=new URL(req.url,`http://${req.headers.host}`);
   if(req.method==='POST'&&url.pathname==='/api/demo'){
    const site=req.headers['sec-fetch-site'];
    if(!origins.has(req.headers.origin??'')||site!==undefined&&site!=='same-origin')return send(res,403,{error:'same-origin request from the board page required'});
    if(!same(req.headers['x-board-nonce'],nonce))return send(res,403,{error:'missing or wrong board nonce'});
    if(String(req.headers['content-type']??'').split(';')[0].trim()!=='application/json')return send(res,415,{error:'Content-Type must be application/json'});
    const [status,body]=startDemo();return send(res,status,body);
   }
   if(req.method!=='GET'&&req.method!=='HEAD')return send(res,405,{error:'read-only'},undefined,{allow:'GET, HEAD'});
   if(STATIC[url.pathname]){
    const [file,type]=STATIC[url.pathname];
    let body=readFileSync(join(PUBLIC,file),'utf8');
    if(file==='index.html')body=body.replace('{{BOARD_NONCE}}',nonce);
    return send(res,200,body,type);
   }
   if(url.pathname==='/api/state')return send(res,200,current?.state??build().state);
   if(url.pathname.startsWith('/api/jobs/')){
    const id=decodeURIComponent(url.pathname.slice('/api/jobs/'.length));
    const t=JOURNAL_ID.test(id)&&(current??build()).timelines.find(x=>x.id===id);
    return t?send(res,200,t):send(res,404,{error:'unknown job'});
   }
   if(url.pathname==='/api/evidence'){
    const {timelines,payments}=current??build();
    const docs=['plan/EVIDENCE.md','README.md'].map(name=>({name,entries:read(p(name),t=>parseEvidenceMd(t,name))??[]}));
    const txs=evidence({timelines,payments,docs});
    return send(res,200,{count:txs.length,txs});
   }
   if(url.pathname==='/api/events'){
    res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',connection:'keep-alive'});
    res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify((current??build()).state)}\n\n`);
    clients.add(res);req.on('close',()=>clients.delete(res));
    return;
   }
   return send(res,404,{error:'not found'});
  }catch(e){console.error('board request failed',e.message);if(!res.headersSent)send(res,500,{error:'board error'});}
 }

 const timers=[];
 function start(){
  build();
  const every=(ms,fn)=>{let busy=false;const run=async()=>{if(busy)return;busy=true;try{await fn();}finally{busy=false;}};run();timers.push(setInterval(run,ms));};
  every(2000,()=>{watchDemo();broadcast();});
  every(10000,pollMailpit);
  let mpsAt=0;every(3000,async()=>{if(now()-mpsAt<(anyRunning()?6000:60000))return;mpsAt=now();await pollMps();});
  let chainAt=0;every(5000,async()=>{if(now()-chainAt<(anyRunning()||clients.size?20000:120000))return;chainAt=now();await pollChain();});
  timers.push(setInterval(()=>{for(const res of clients)res.write(': ping\n\n');},15000));
 }
 const stop=()=>{for(const t of timers)clearInterval(t);for(const res of clients)res.end();clients.clear();};
 return {handler,start,stop,build,nonce,startDemo,get demo(){return demo;}};
}

if(import.meta.main){
 const port=Number(process.env.BOARD_PORT||8787);
 const board=createBoard({port});
 board.start();
 createServer(board.handler).listen(port,'127.0.0.1',()=>console.log(`Abnahme-Board on http://127.0.0.1:${port} (MPS ${process.env.MPS_READ_TOKEN?'read key':'off'}, Blockfrost ${process.env.BLOCKFROST_API_KEY_PREPROD?'on':'off'})`));
}
