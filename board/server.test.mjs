// board/server.mjs on a temporary copy of board/fixtures/, with a fake fetch (no network) and a fake demo runner
// (no purchase can start from a test). Checks the request guards, the one-run lock, the mail link and that keys only
// ever leave the process as read-only requests to their own service.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {request,createServer} from 'node:http';
import {cpSync,mkdirSync,mkdtempSync,readFileSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBoard} from './server.mjs';

const FX=new URL('./fixtures/',import.meta.url);
const READ='sentinel-read-token-0123456789',BF='sentinel-blockfrost-0123456789';
let root,server,board,port;const calls=[],runs=[];

function call(method,path,headers={},body){
 return new Promise((resolve,reject)=>{
  const r=request({host:'127.0.0.1',port,method,path,headers:{host:`127.0.0.1:${port}`,...headers}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:d,json:()=>JSON.parse(d)}));});
  r.on('error',reject);if(body)r.write(body);r.end();
 });
}
const demo=headers=>call('POST','/api/demo',{'content-type':'application/json',...headers},'{}');

before(async()=>{
 root=mkdtempSync(join(tmpdir(),'abnahme-board-test-'));
 for(const d of ['.local/abnahme-journal','.local/rechnungsmeister-jobs','gutachter','fixtures','plan'])mkdirSync(join(root,d),{recursive:true});
 cpSync(new URL('journals/',FX),join(root,'.local/abnahme-journal'),{recursive:true});
 cpSync(new URL('rm-jobs/',FX),join(root,'.local/rechnungsmeister-jobs'),{recursive:true});
 cpSync(new URL('sent-ledger.json',FX),join(root,'.local/sent-ledger.json'));
 cpSync(new URL('abnahmen.json',FX),join(root,'.local/abnahmen.json'));
 cpSync(new URL('task-01a18d10-ee72-75f4-9c95-e26eaaa5eb60.json',FX),join(root,'.local/01a18d10-ee72-75f4-9c95-e26eaaa5eb60.json'));
 cpSync(new URL('payments.log.json',FX),join(root,'gutachter/payments.log.json'));
 cpSync(new URL('../../fixtures/b-abschlag-13b-bau-isar.txt',FX),join(root,'fixtures/b-abschlag-13b-bau-isar.txt'));
 writeFileSync(join(root,'plan/EVIDENCE.md'),`## Run\n| FundsLocked | 2026-10-30T09:08:47.000Z | \`${'1'.repeat(64)}\` | x |\n`);
 writeFileSync(join(root,'README.md'),'# none\n');
 const fetchImpl=async(url,opts={})=>{
  calls.push({url:String(url),method:opts.method??'GET',headers:opts.headers??{}});
  if(String(url).startsWith('http://mailpit.test/'))return Response.json({messages:[{MessageID:'ad5d99a0-21e9-40eb-b5c5-f5f3ca11aee3@abnahme.local',To:[{Address:'eingangsrechnungen@bau-isar.example'}],Subject:'XRechnung AR-2026-1101',Created:'2026-10-30T14:03:04.577Z'}]});
  return new Response('{}',{status:503});
 };
 const runDemo=({file})=>{const child=new EventEmitter();child.pid=null;runs.push({file,text:readFileSync(file,'utf8'),child});return child;};
 server=createServer((q,r)=>board.handler(q,r));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 port=server.address().port;
 board=createBoard({root,port,env:{MPS_READ_TOKEN:READ,BLOCKFROST_API_KEY_PREPROD:BF},fetchImpl,runDemo,mailpitUrl:'http://mailpit.test',mpsUrl:'http://mps.test'});
 board.start();
 await new Promise(r=>setTimeout(r,300));
 board.build();
});
after(()=>{board.stop();server.close();});

test('the page carries the demo nonce and a strict CSP; static files only from the whitelist', async()=>{
 const r=await call('GET','/');
 assert.equal(r.status,200);
 assert.ok(r.text.includes(`<meta name="board-nonce" content="${board.nonce}">`));
 assert.match(r.headers['content-security-policy'],/default-src 'none'; script-src 'self'/);
 assert.equal((await call('GET','/app.js')).status,200);
 for(const p of ['/../server.mjs','/public/app.js','/api/jobs/..%2F..%2Fetc%2Fpasswd','/.local/env/board.env'])assert.equal((await call('GET',p)).status,404,p);
});

test('state: every fixture job, the Sokosumi origin, and the e-mail only on the job whose purchase accepted the mailed XML', async()=>{
 const s=(await call('GET','/api/state')).json();
 assert.equal(s.jobs.length,5);assert.equal(s.network,'preprod');
 const byNo=Object.fromEntries(s.jobs.map(j=>[j.invoice.number,j]));
 assert.equal(byNo['AR-2026-1101'].origin.kind,'sokosumi');assert.equal(byNo['AR-2026-1101'].origin.taskId,'01a18d10-ee72-75f4-9c95-e26eaaa5eb60');
 assert.deepEqual(s.jobs.filter(j=>j.mailed).map(j=>j.invoice.number),['AR-2026-1101']);
 // byte-identical XML was mailed from a local PRÜFEN before this escrow run: not this job's e-mail
 assert.equal(byNo['AR-2026-0087'].mailed,false);
 const t=(await call('GET','/api/jobs/2026-10-30T13-47-45-967Z-28273e')).json();
 assert.equal(t.mail.inMailpit,true);assert.equal(t.steps.at(-1).status,'done');
 assert.equal(s.sources.mailpit,'ok');assert.equal(s.sources.mps,'down');assert.equal(s.sources.blockfrost,'down');
});

test('requests with a foreign Host header (DNS rebinding) or a write method are refused', async()=>{
 assert.equal((await call('GET','/api/state',{host:'evil.example:8787'})).status,421);
 assert.equal((await call('PUT','/api/state')).status,405);
 assert.equal((await call('DELETE','/api/jobs/x')).status,405);
});

test('demo: same origin + nonce + JSON only, one run at a time, a fresh invoice number each time', async()=>{
 const origin=`http://127.0.0.1:${port}`;
 assert.equal((await demo({})).status,403,'no Origin');
 assert.equal((await demo({origin:'http://evil.example'})).status,403,'foreign Origin');
 assert.equal((await demo({origin,'sec-fetch-site':'cross-site','x-board-nonce':board.nonce})).status,403,'cross-site fetch');
 assert.equal((await demo({origin,'x-board-nonce':'0'.repeat(48)})).status,403,'wrong nonce');
 assert.equal((await call('POST','/api/demo',{origin,'x-board-nonce':board.nonce,'content-type':'text/plain'},'{}')).status,415,'form-like body');
 assert.equal(runs.length,0,'nothing started so far');

 const ok=await demo({origin,'sec-fetch-site':'same-origin','x-board-nonce':board.nonce});
 assert.equal(ok.status,202);
 const {invoiceNumber}=ok.json();
 assert.match(invoiceNumber,/^AR-2026-D\d{6}$/);
 assert.equal(runs.length,1);
 assert.ok(runs[0].text.includes(`Abschlagsrechnung Nr.: ${invoiceNumber}`));assert.ok(!runs[0].text.includes('AR-2026-0087'));
 assert.equal((await call('GET','/api/state')).json().demo.running,true);
 assert.equal((await demo({origin,'x-board-nonce':board.nonce})).status,409,'second run refused while the first runs');
 assert.equal(runs.length,1);
 assert.ok(existsSync(join(root,'.local/board-demo.json')),'the lock survives a board restart');

 runs[0].child.emit('exit',0);
 const s=(await call('GET','/api/state')).json();
 assert.equal(s.demo.running,false);assert.equal(s.demo.exitCode,0);
});

test('keys leave the process only as GETs to their own service, and never appear in a response', async()=>{
 assert.ok(calls.length>0);
 for(const c of calls){
  assert.equal(c.method,'GET',c.url);
  const sent=JSON.stringify(c.headers)+c.url;
  if(sent.includes(READ))assert.ok(c.url.startsWith('http://mps.test/api/v1/purchase?')||c.url.startsWith('http://mps.test/api/v1/payment?'),c.url);
  if(sent.includes(BF))assert.ok(c.url.startsWith('https://cardano-preprod.blockfrost.io/'),c.url);
  if(c.url.startsWith('http://mailpit.test/'))assert.ok(!sent.includes(READ)&&!sent.includes(BF));
 }
 const bodies=await Promise.all(['/','/api/state','/api/evidence','/api/jobs/2026-10-30T13-47-45-967Z-28273e'].map(p=>call('GET',p).then(r=>r.text)));
 for(const b of bodies){assert.ok(!b.includes(READ)&&!b.includes(BF));assert.doesNotMatch(b,/job_token|Lindwurmstraße/);}
});

// ---- Fix round 5 (delta review).
function rootCopy(){
 const r=mkdtempSync(join(tmpdir(),'abnahme-board-test-'));
 for(const d of ['.local/abnahme-journal','.local/rechnungsmeister-jobs','gutachter','fixtures','plan'])mkdirSync(join(r,d),{recursive:true});
 cpSync(new URL('journals/',FX),join(r,'.local/abnahme-journal'),{recursive:true});
 cpSync(new URL('rm-jobs/',FX),join(r,'.local/rechnungsmeister-jobs'),{recursive:true});
 cpSync(new URL('sent-ledger.json',FX),join(r,'.local/sent-ledger.json'));
 cpSync(new URL('abnahmen.json',FX),join(r,'.local/abnahmen.json'));
 cpSync(new URL('payments.log.json',FX),join(r,'gutachter/payments.log.json'));
 return r;
}
const offline=async()=>new Response('{}',{status:503});
test('DELTA-BOARD-1: wrong-typed fields in the source files make one job "unreadable"; the board keeps building and serving',async()=>{
 const r=rootCopy();
 const rmPath=join(r,'.local/rechnungsmeister-jobs/3676f1ca-de40-44b3-8136-08102e381baf.json'),rm=JSON.parse(readFileSync(rmPath,'utf8'));
 rm.refundReasons='not a list';writeFileSync(rmPath,JSON.stringify(rm));  // the refused run: rm.refundReasons.join threw in the model
 writeFileSync(join(r,'.local/sent-ledger.json'),JSON.stringify({entries:'not a list'}));
 writeFileSync(join(r,'gutachter/payments.log.json'),'{}');
 let b;const srv=createServer((q,s)=>b.handler(q,s));await new Promise(ok=>srv.listen(0,'127.0.0.1',ok));
 try{
  b=createBoard({root:r,port:srv.address().port,env:{},fetchImpl:offline,runDemo:()=>{throw new Error('no demo in this test')}});
  const {state}=b.build();
  assert.equal(state.jobs.length,5);
  assert.deepEqual(state.jobs.filter(j=>j.status.code==='unreadable').map(j=>j.id),['2026-10-30T13-49-02-329Z-74c5a8']);
  assert.ok(state.jobs.some(j=>j.status.code==='paid'),'the other jobs are still read');
  const base=`http://127.0.0.1:${srv.address().port}`;
  assert.equal((await fetch(`${base}/api/state`)).status,200);
  const job=await (await fetch(`${base}/api/jobs/2026-10-30T13-49-02-329Z-74c5a8`)).json();
  assert.equal(job.status.tone,'amber');assert.match(job.alarm,/cannot read this job/);assert.doesNotMatch(JSON.stringify(job),/not a list|\/Users\/|\/tmp\//);
 }finally{srv.close();}
});
test('DELTA-BOARD-1: an exception in a timer tick is logged and never becomes an unhandled rejection that ends the process',async()=>{
 let boom=false;const b=createBoard({root:rootCopy(),port:0,env:{},fetchImpl:offline,runDemo:()=>{throw new Error('no demo in this test')},now:()=>{if(boom)throw new Error('clock failed');return Date.parse('2026-10-30T16:00:00Z');}});
 const rejected=[],on=e=>rejected.push(e);process.on('unhandledRejection',on);
 boom=true;
 try{b.start();await new Promise(ok=>setTimeout(ok,50));}finally{b.stop();process.off('unhandledRejection',on);}
 assert.deepEqual(rejected.map(e=>e.message),[]);
});
