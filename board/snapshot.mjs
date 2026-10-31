// Abnahme-Board snapshot: a static, read-only copy of the running board for GitHub Pages (site/board/ → /abnahme/board/).
// Reads the same JSON the page reads from the running board (GET only, loopback), rewrites the client to load static
// files once (no SSE, no POST), checks every generated file for secrets, local paths, LAN addresses and e-mail
// addresses, and only then replaces site/board/. Any rewrite target that is missing fails the build.
//   node board/snapshot.mjs        (the board must be running on 127.0.0.1:8787, BOARD_PORT to change it)
import {cpSync,existsSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
const PUBLIC=join(ROOT,'board/public');
const OUT=join(ROOT,'site/board');
const BOARD=`http://127.0.0.1:${Number(process.env.BOARD_PORT||8787)}`;
const DEMO_URL='https://omurbc.github.io/abnahme/demo2/';
const JOURNAL_ID=/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9-]+Z-[0-9a-f]{6}$/;  // same as board/server.mjs
const fail=msg=>{console.error(`board/snapshot.mjs: ${msg}`);process.exit(1);};

// ---------- data, GET only ----------
async function get(path){
 let r;try{r=await fetch(`${BOARD}${path}`,{redirect:'error',signal:AbortSignal.timeout(15000)});}
 catch(e){fail(`board not reachable at ${BOARD}${path} (${e.message}). Start board/server.mjs first.`);}
 if(!r.ok)fail(`GET ${path}: HTTP ${r.status}`);
 return r.json();
}
const takenAt=new Date();
const state=await get('/api/state');
if(!Array.isArray(state.jobs)||!state.jobs.length)fail('state has no jobs');
const evidence=await get('/api/evidence');
if(!Array.isArray(evidence.txs))fail('evidence has no txs');
const jobs={};
for(const {id} of state.jobs){
 if(!JOURNAL_ID.test(id))fail(`unexpected job id ${JSON.stringify(id)}`);
 jobs[id]=await get(`/api/jobs/${encodeURIComponent(id)}`);
}

// Two things the page never needs leave the data: e-mail Message-IDs (local host name) and repo-relative .local/ paths
// in journal lines (replaced by a visible marker). Everything else is published as the board serves it.
const scrubbed={messageId:0,path:0};
function scrub(v){
 if(typeof v==='string')return v.replace(/\.local\/[^\s"'<>()]*/g,()=>{scrubbed.path++;return '[local path removed]';});
 if(Array.isArray(v))return v.map(scrub);
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>k!=='messageId'||!++scrubbed.messageId).map(([k,x])=>[k,scrub(x)]));
 return v;
}

// ---------- client rewrite ----------
// Each rewrite must match exactly once, so a changed app.js or index.html cannot silently yield a broken snapshot.
function rewrite(name,src,edits){
 for(const [from,to] of edits){
  const n=src.split(from).length-1;
  if(n!==1)fail(`${name}: expected exactly one ${JSON.stringify(from.slice(0,80))}, found ${n}`);
  src=src.replace(from,()=>to);
 }
 return src;
}
// Cut a whole function: from its first line up to (not including) the next marker.
function cut(name,src,start,next,to=''){
 const a=src.indexOf(start),b=src.indexOf(next);
 if(a<0||b<0||b<a||src.indexOf(start,a+1)>=0)fail(`${name}: cannot cut ${JSON.stringify(start)} before ${JSON.stringify(next)}`);
 return src.slice(0,a)+to+src.slice(b);
}

let app=readFileSync(join(PUBLIC,'app.js'),'utf8');
app=rewrite('app.js',app,[
 ['// Abnahme-Board client: renders the state the board server pushes over Server-Sent Events (/api/events).',
  '// Abnahme-Board client, static snapshot: renders state, jobs and evidence from the JSON files in data/, loaded once.'],
 ["const NONCE=document.querySelector('meta[name=\"board-nonce\"]')?.content??'';\n",''],
 ['fetch(`/api/jobs/${encodeURIComponent(pinnedId)}`)','fetch(`data/jobs/${encodeURIComponent(pinnedId)}.json`)'],
 ["fetch('/api/evidence')","fetch('data/evidence.json')"],
 ["'<div class=\"card empty\">Connecting to the board server …</div>'","'<div class=\"card empty\">Loading the snapshot …</div>'"],
 ["s==='live'?'Live':s==='offline'?'Offline · reconnecting':'Connecting …'","s==='snapshot'?'Snapshot':s==='offline'?'Snapshot not loaded':'Loading …'"],
 [" $('#demo-btn').addEventListener('click',onDemoClick);\n",''],
 // No running clock: durations stay as the snapshot measured them.
 [' route();connect();setInterval(tick,1000);',' route();connect();'],
]);
app=cut('app.js',app,'let armed=null;\nfunction renderDemo(){','function renderFoot(){','function renderDemo(){}\n');
app=cut('app.js',app,'async function onDemoClick(){','function setLive(s){');
app=cut('app.js',app,'function connect(){','function tick(){',
`function connect(){
 fetch('data/state.json').then(r=>r.ok?r.json():Promise.reject(new Error(\`HTTP \${r.status}\`))).then(s=>{
  state=s;setLive('snapshot');
  if(pinnedId&&pinnedId!==state.liveId)loadPinned();else render();
 }).catch(()=>setLive('offline'));
}
`);
for(const bad of ['EventSource','/api/','POST','NONCE','onDemoClick','setInterval(tick'])if(app.includes(bad))fail(`app.js still contains ${JSON.stringify(bad)}`);

const fmtTaken=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Berlin',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(takenAt);
const strip=`<div class="snapshot-strip" role="note"><div class="wrap"><span><b>Read-only snapshot of the live console</b> · taken <time datetime="${takenAt.toISOString()}">${fmtTaken}</time> Munich time · the live console runs locally at the booth</span><a href="${DEMO_URL}">Try the demo →</a></div></div>`;
let html=readFileSync(join(PUBLIC,'index.html'),'utf8');
html=rewrite('index.html',html,[
 ['<meta name="board-nonce" content="{{BOARD_NONCE}}">\n',
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'">\n`],
 ['<title>Abnahme-Board</title>','<title>Abnahme-Board · Snapshot</title>'],
 ['Live console on Cardano preprod.','Read-only snapshot of the live console on Cardano preprod.'],
 ['href="/favicon.svg"','href="favicon.svg"'],
 ['href="/fonts/fonts.css"','href="fonts/fonts.css"'],
 ['href="/styles.css"','href="styles.css"'],
 ['src="/app.js"','src="app.js"'],
 ['<body>\n',`<body>\n${strip}\n`],
 ['data-state="connecting" title="Server-Sent Events from the board server"><span class="dot"></span><span class="live-label">Connecting …</span>',
  'data-state="connecting" title="Static copy of the board state, no live updates"><span class="dot"></span><span class="live-label">Loading …</span>'],
 ['<button class="btn btn-demo" id="demo-btn" type="button" disabled>Start demo</button>',`<a class="btn btn-demo" id="demo-btn" href="${DEMO_URL}">Try the demo</a>`],
 ['<span class="demo-note" id="demo-note">real purchase on preprod: 1 tUSDM</span>','<span class="demo-note" id="demo-note">click-through demo, no purchase</span>'],
]);
if(/\{\{|="\/[^/]/.test(html))fail('index.html still has a placeholder or a root-absolute URL');

const css=readFileSync(join(PUBLIC,'styles.css'),'utf8')+`
/* ---------- snapshot strip (static copy only) ---------- */
.snapshot-strip{background:var(--ink);color:var(--on-ink);font:500 13px/1.4 var(--sans)}
.snapshot-strip .wrap{display:flex;flex-wrap:wrap;gap:4px 16px;align-items:center;justify-content:center;padding-top:9px;padding-bottom:9px;text-align:center}
.snapshot-strip a{color:var(--on-ink);font-weight:600;text-decoration:underline;text-underline-offset:3px}
`;

// ---------- output, checked before anything is written ----------
const files={'index.html':html,'app.js':app,'styles.css':css,'data/state.json':JSON.stringify(scrub(state)),'data/evidence.json':JSON.stringify(scrub(evidence))};
for(const [id,t] of Object.entries(jobs))files[`data/jobs/${id}.json`]=JSON.stringify(scrub(t));

const PATTERNS=[
 ['local filesystem path',/\/(Users|private|tmp|home|var\/folders)\//],
 ['.local path',/\.local\//],
 ['LAN or loopback address',/\b(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01])|127\.\d{1,3}|169\.254)\.\d{1,3}\.\d{1,3}\b/],
 ['localhost',/\blocalhost\b/i],
 ['private key block',/-----BEGIN [A-Z ]*PRIVATE KEY-----/],
 ['Cardano signing key',/\b(ed25519e?_sk|addr_xsk|acct_xsk|root_xsk|xprv)1?[0-9a-z]{20,}/],
 ['Blockfrost project id',/\b(preprod|preview|mainnet)[A-Za-z0-9]{32}\b/],
 ['API key',/\bsk-[A-Za-z0-9_-]{20,}/],
 ['bearer token',/\bBearer\s+[A-Za-z0-9._-]{16,}/i],
 ['credential field',/"(token|api_?key|secret|password|mnemonic|seed|private_?key|project_id|authorization)"\s*:/i],
];
const EMAIL=/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const emailOk=e=>e.toLowerCase().endsWith('.example')||e==='altunbeyomur36@gmail.com';
// Real secret values, compared without ever printing them; on a hit only the variable name is reported.
const secrets=[];
for(const f of ['.local/env/board.env','.local/secrets.env']){
 if(!existsSync(join(ROOT,f)))fail(`${f} missing: cannot check secret values`);
 for(const [name,value] of Object.entries(parseEnv(readFileSync(join(ROOT,f),'utf8')))){
  const v=String(value).trim();
  if(v.length>=8&&!/^\d+$/.test(v))secrets.push({name,file:f,values:[...new Set([v,v.replace(/\s+/g,' ')])]});
 }
}
const problems=[];
for(const [path,text] of Object.entries(files)){
 for(const [label,re] of PATTERNS)if(re.test(text))problems.push(`${path}: ${label}`);
 if(path.endsWith('.json')&&/\.local\b/.test(text))problems.push(`${path}: .local host name`);
 for(const e of new Set(text.match(EMAIL)??[]))if(!emailOk(e))problems.push(`${path}: e-mail address ${e}`);
 for(const s of secrets)if(s.values.some(v=>text.includes(v)))problems.push(`${path}: value of ${s.name} (${s.file})`);
}
if(problems.length)fail(`privacy check failed, nothing written:\n  ${[...new Set(problems)].join('\n  ')}`);

rmSync(OUT,{recursive:true,force:true});
mkdirSync(join(OUT,'data/jobs'),{recursive:true});
for(const [path,text] of Object.entries(files))writeFileSync(join(OUT,path),text);
writeFileSync(join(OUT,'favicon.svg'),readFileSync(join(PUBLIC,'favicon.svg')));
mkdirSync(join(OUT,'fonts'));
for(const f of readdirSync(join(PUBLIC,'fonts')))if(/^[A-Za-z0-9.-]+\.(woff2|css|txt)$/.test(f))cpSync(join(PUBLIC,'fonts',f),join(OUT,'fonts',f));
console.log(`site/board/: snapshot ${fmtTaken} Munich · ${state.jobs.length} jobs · ${evidence.txs.length} evidence rows · privacy check passed (${Object.keys(files).length} files, ${secrets.length} secret values compared; removed ${scrubbed.messageId} Message-IDs, ${scrubbed.path} local paths)`);
