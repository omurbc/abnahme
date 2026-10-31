// Abnahme-Board client, static snapshot: renders state, jobs and evidence from the JSON files in data/, loaded once.
// No framework, no external assets. English first, German legal and product terms in parentheses.
// Views: #live (newest job, or #live/<journal id>), #history, #evidence.
'use strict';
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const TZ='Europe/Berlin';
const fmt=(iso,o)=>iso?new Intl.DateTimeFormat('en-GB',{timeZone:TZ,hourCycle:'h23',...o}).format(new Date(iso)):'';
const fmtTime=iso=>fmt(iso,{hour:'2-digit',minute:'2-digit',second:'2-digit'});
const fmtHm=iso=>fmt(iso,{hour:'2-digit',minute:'2-digit'});
const fmtDay=iso=>iso?`${fmt(iso,{day:'numeric',month:'short'})} ${fmtHm(iso)}`:'';
const fmtDur=ms=>ms==null||ms<0?'–':ms<60000?`${Math.round(ms/1000)} s`:ms<3600000?`${Math.floor(ms/60000)} min ${String(Math.floor(ms%60000/1000)).padStart(2,'0')} s`:`${Math.floor(ms/3600000)} h ${String(Math.floor(ms%3600000/60000)).padStart(2,'0')} min`;
const eur=n=>n==null?'–':new Intl.NumberFormat('en-GB',{style:'currency',currency:'EUR'}).format(n);
const short=h=>h?`${h.slice(0,6)}…${h.slice(-4)}`:'';
const TONE={blue:'chip-blue',green:'chip-green',red:'chip-red',amber:'chip-amber',grey:'chip-grey'};

const I={
 check:'<path d="M5 12.5l4.2 4.2L19 7" />',x:'<path d="M6 6l12 12M18 6L6 18" />',
 lock:'<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
 upload:'<path d="M12 16V4m0 0l-4.5 4.5M12 4l4.5 4.5"/><path d="M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15"/>',
 search:'<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
 alert:'<path d="M12 4l9 16H3z"/><path d="M12 10v4.5M12 17.5v.01"/>',
 wrench:'<path d="M14.5 6.5a4 4 0 0 0-5.3 5.3L4 17l3 3 5.2-5.2a4 4 0 0 0 5.3-5.3l-2.6 2.6-2.4-.6-.6-2.4z"/>',
 stamp:'<path d="M9 13V9a3 3 0 1 1 6 0v4"/><path d="M5 13h14v4H5zM7 20h10"/>',
 coin:'<circle cx="12" cy="12" r="8"/><path d="M12 7.5v9M9.5 9.5h3.75a1.75 1.75 0 0 1 0 3.5h-2.5a1.75 1.75 0 0 0 0 3.5H14.5"/>',
 mail:'<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/>',
 undo:'<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
 hourglass:'<path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9"/>',
 person:'<circle cx="12" cy="8" r="3.6"/><path d="M5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6"/>',
 office:'<rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="M8 8h2M14 8h2M8 12h2M14 12h2M10 20.5v-4h4v4"/>',
 doc:'<path d="M7 3.5h7l4 4v13H7z"/><path d="M14 3.5v4h4M10 12h5M10 15.5h5"/>',
 seal:'<circle cx="12" cy="10" r="6"/><path d="M9.5 10l1.8 1.8L15 8.3M8.5 15l-1.5 6 5-2.5 5 2.5-1.5-6"/>',
 out:'<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
};
const svg=(name,extra='')=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${I[name]}</svg>`;
const STEP_ICON={locked:'lock',delivered:'upload',inspection1:'search',inspection2:'search',disputed:'alert',cure:'wrench',accepted:'stamp',deemed:'stamp',paid:'coin',mail:'mail',refundAuthorized:'undo',refunded:'coin'};
const txLink=(tx,cls='txl')=>tx?`<a class="${cls}" href="${esc(tx.url)}" target="_blank" rel="noopener noreferrer" title="${esc(tx.hash)} on Cardanoscan (preprod)">${esc(short(tx.hash))}${svg('out')}</a>`:'';
const confLine=tx=>tx?.confirmations!=null?`<div class="step-cf" title="Blocks since the transaction (Blockfrost)">${tx.confirmations>=1?'✓ ':''}${tx.confirmations} confirmation${tx.confirmations===1?'':'s'}</div>`:'';
const VIEWS=['live','history','evidence'];

// ---------- state ----------
let state=null,view='live',pinnedId=null,pinned=null,evidence=null,evFilter='all';
const seen={steps:{},stamp:{},mail:{}};

function route(){
 const [v,id]=location.hash.replace(/^#/,'').split('/');
 view=VIEWS.includes(v)?v:'live';
 pinnedId=view==='live'&&id?decodeURIComponent(id):null;
 if(!pinnedId)pinned=null;
 for(const a of document.querySelectorAll('.tabs a')){if(a.dataset.view===view)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}
 for(const name of VIEWS)$(`#view-${name}`).hidden=name!==view;
 render();
 if(pinnedId)loadPinned();
 if(view==='evidence')loadEvidence();
}
async function loadPinned(){
 if(!pinnedId||pinnedId===state?.liveId)return render();
 try{const r=await fetch(`data/jobs/${encodeURIComponent(pinnedId)}.json`);pinned=r.ok?await r.json():null;}catch{pinned=null;}
 render();
}
let evTimer=null;
async function loadEvidence(){
 try{const r=await fetch('data/evidence.json');evidence=r.ok?await r.json():evidence;}catch{}
 if(view==='evidence')renderEvidence();
}

// ---------- live ----------
function agentsOf(t){
 const st=k=>t.steps.find(s=>s.key===k)?.status;
 const act=t.steps.find(s=>s.status==='active')?.key??null;
 const done=k=>st(k)==='done';
 const inspecting=act==='inspection1'||act==='inspection2';
 const x402=t.inspections.filter(r=>r.x402).length,local=t.inspections.length-x402;
 const final=t.status.code;
 const buero={
  locked:'buys from the RechnungsMeister, locks 1 tUSDM',delivered:'waits for the delivery',inspection1:'has the delivery inspected',inspection2:'inspects the cure',
  disputed:'files the defect notice on Cardano',cure:'sends the inspection report to the seller',accepted:'releases the payment (Abnahme)',paid:'waits for the payout',
  refundAuthorized:'waits for the refund',refunded:'waits for the refund',
 }[act]??(final==='paid'||final==='accepted'?'invoice accepted':final==='payout-stuck'?'invoice accepted, payout stuck at MPS':final.startsWith('ref')?'invoice refused':final==='alarm'?'alarm: operator needed':'ready');
 const rm=act==='locked'?'waits for the escrow payment':act==='delivered'?'builds the XRechnung (KoSIT self-check)':act==='disputed'?'cannot withdraw: the money is disputed':act==='cure'?'cures the defect (§ 635 BGB)'
  :done('paid')?'received 1 tUSDM from the escrow':done('refundAuthorized')?'refunds 1 tUSDM':done('cure')?'cure submitted':done('delivered')?'delivery submitted':'waits for an order';
 const gut=inspecting?'checks against KoSIT 1.6.3 …':t.inspections.length?[x402?`${x402} inspection${x402>1?'s':''} paid · ${x402} tADA`:'',local?`${local}× local KoSIT`:''].filter(Boolean).join(' · '):'waits for a delivery';
 const origin=t.origin?.kind==='sokosumi'?`Sokosumi Task ${t.origin.taskId.slice(0,8)}… (PRÜFEN)`:t.origin?.kind==='board'?'started from this board (no Sokosumi)':'command line, buero/run.mjs (no Sokosumi)';
 const frozen=done('disputed')&&!done('accepted')&&!done('refundAuthorized')&&!done('paid');
 const escrow=done('paid')?['paid out','is-paid']:done('refunded')?['back to the buyer','is-back']:done('accepted')?['released','is-on']:done('refundAuthorized')?['refund authorized','is-frozen']
  :frozen?['frozen','is-frozen']:done('locked')?['locked',t.running?'is-on':'']:act==='locked'?['being locked','is-on']:['',''];
 return {act,buero,rm,gut,origin,escrow,inspecting,x402,
  busy:{buero:!!act&&t.running,rm:t.running&&(act==='delivered'||act==='cure'||act==='disputed'),gut:inspecting}};
}

function renderAgents(t){
 const a=agentsOf(t);
 const card=(cls,icon,name,role,act,state)=>`<div class="agent ${cls} ${state}"><span class="agent-ic">${svg(icon)}</span><b>${name}</b><span class="role">${role}</span><span class="act"><i class="dot"></i><span>${esc(act)}</span></span></div>`;
 const ok=t.status.tone==='green',bad=t.status.tone==='red';
 return `<article class="card agents" aria-label="Agents and money flow">
  <div class="card-h"><h3>Agents and money flow<small>who hires whom, who pays whom</small></h3></div>
  <div class="agents-grid">
  ${card('a-berger','person','Frau Berger','Office · Toni Huber Elektrotechnik',a.origin,t.origin?.kind==='sokosumi'?'':'is-dim')}
  <div class="flow flow-1 ${t.running?'is-on':''}"><label>Order<small>${t.origin?.kind==='sokosumi'?'Sokosumi credits':'no Sokosumi'}</small></label><div class="line"></div></div>
  ${card('a-buero','office','Büro-Agent','Buyer · Abnahme-Büro',a.buero,a.busy.buero?'is-busy':ok?'is-ok':bad?'is-bad':'')}
  <div class="flow flow-rm money ${a.escrow[1]}"><label>Masumi escrow<small>1 tUSDM${a.escrow[0]?` · ${esc(a.escrow[0])}`:''}</small></label><div class="line"></div></div>
  ${card('a-rm','doc','RechnungsMeister','Seller · MIP-003, XRechnung',a.rm,a.busy.rm?'is-busy':t.steps.some(s=>s.key==='paid'&&s.status==='done')?'is-ok':'')}
  <div class="flow flow-gut x402 ${a.inspecting?'is-on':''}"><label>x402<small>1 tADA per inspection${a.x402?` · ${a.x402}× paid`:''}</small></label><div class="line"></div></div>
  ${card('a-gut','seal','Gutachter','Inspector · KoSIT over x402',a.gut,a.busy.gut?'is-busy':'')}
  </div>
  <p class="agents-legend"><span><i class="lg lg-money"></i>1 tUSDM in the Masumi V2 escrow, released only on acceptance</span><span><i class="lg lg-x402"></i>1 tADA per inspection over x402, no account</span><span><i class="lg lg-credit"></i>Frau Berger pays Sokosumi credits only, no wallet</span></p>
 </article>`;
}

function renderJob(t){
 const x402=t.inspections.filter(r=>r.x402).length,local=t.inspections.length-x402;
 const insp=t.inspections.length?[x402?`x402 ×${x402}`:'',local?`local ×${local}`:''].filter(Boolean).join(' · '):'–';
 const origin=t.origin?.kind==='sokosumi'?`Sokosumi <small>Task ${esc(t.origin.taskId.slice(0,8))}…</small>`:t.origin?.kind==='board'?'Board <small>demo start</small>':'CLI <small>buero/run.mjs</small>';
 const notes=[];
 if(t.demo.seedDefect)notes.push(`<div class="note">Demo mode: the first defect is seeded on purpose (DEMO_SEED_DEFECT=1, BT-48 left out of delivery 1).</div>`);
 else if(t.demo.seedSwitch)notes.push(`<div class="note note-blue">RechnungsMeister ran with DEMO_SEED_DEFECT=1; no effect on this job.</div>`);
 if(t.demo.cheat)notes.push(`<div class="note">Demo mode: wrong result hash on purpose (CHEAT=1).</div>`);
 if(t.protective)notes.push(`<div class="note" title="${esc(t.protective.textDe)}">Protective defect notice (vorsorgliche Mängelrüge) [${esc(t.protective.code)}]: ${esc(t.protective.en??t.protective.textDe)}. No passed inspection yet, so the money waits in Disputed.</div>`);
 if(t.alarm)notes.push(`<div class="note note-red"><b>Alarm, operator needed:</b> ${esc(t.alarm.length>200?`${t.alarm.slice(0,200).replace(/\s+\S*$/,'')} …`:t.alarm)}</div>`);
 const isPinned=pinnedId&&pinnedId!==state?.liveId;
 return `<article class="card job">
  <div class="job-row"><p class="eyebrow">Invoice</p><span class="chip ${TONE[t.status.tone]} job-status ${t.running?'is-running':''}" title="${esc(t.status.de)}"><i class="dot"></i>${esc(t.status.label)}</span></div>
  <div><p class="job-no">${esc(t.invoice.number??'being read …')}</p><p class="job-to">to ${esc(t.invoice.recipientName??'–')}</p></div>
  <dl class="job-meta">
   <div><dt>Invoice amount</dt><dd>${esc(eur(t.invoice.amount))}</dd></div>
   <div><dt>Price</dt><dd>1 tUSDM <small>escrow</small></dd></div>
   <div><dt>Started</dt><dd class="mono">${esc(fmtTime(t.createdAt))}</dd></div>
   <div><dt>Duration</dt><dd class="mono" ${t.running?`data-since="${esc(t.createdAt)}"`:''}>${esc(fmtDur(t.durationMs))}</dd></div>
   <div><dt>Origin</dt><dd>${origin}</dd></div>
   <div><dt>Inspection</dt><dd>${esc(insp)}</dd></div>
  </dl>
  ${notes.join('')}
  ${isPinned?'<div class="job-pick"><span>Job picked from the history</span><a href="#live">Back to the current job →</a></div>':''}
 </article>`;
}

function renderSteps(t){
 const was=seen.steps[t.id]??{};
 const items=t.steps.map(s=>{
  const just=was[s.key]&&was[s.key]!==s.status&&(s.status==='done'||s.status==='failed');
  const icon=s.status==='failed'?'x':s.status==='done'&&!['paid','mail','disputed'].includes(s.key)?'check':STEP_ICON[s.key]??'check';
  const showNote=s.note&&(s.status==='active'||s.status==='failed'||s.conditional||s.key==='cure'||s.key.startsWith('inspection')||/Demo/.test(s.note)||(s.key==='disputed'&&t.protective));
  return `<li class="step k-${s.key} s-${s.status} ${s.tone?`t-${s.tone}`:''} ${s.conditional?'conditional':''} ${just?'just':''}">
   <div class="dotc" title="${esc(s.status)}">${svg(icon)}</div>
   <div class="step-t">${esc(s.title)}</div>
   ${s.term?`<div class="step-de">(${esc(s.term)})</div>`:''}
   <div class="step-en">${esc(s.tech)}</div>
   ${s.law?`<span class="step-law">${esc(s.law)}</span>`:''}
   <div class="step-time">${s.at?esc(fmtTime(s.at)):s.status==='active'?'running …':''}</div>
   ${s.amount&&s.status!=='pending'?`<div class="step-amt">${esc(s.amount)}</div>`:''}
   ${txLink(s.tx)}${confLine(s.tx)}
   ${showNote?`<div class="step-note">${esc(s.note)}</div>`:''}
  </li>`;
 });
 seen.steps[t.id]=Object.fromEntries(t.steps.map(s=>[s.key,s.status]));
 const d=t.deadlines;
 return `<article class="card stepper" aria-label="Escrow state machine">
  <div class="card-h"><h3>Escrow on Cardano<small>Masumi V2 · every step is a preprod transaction</small></h3>${t.escrowState?`<span class="chip chip-blue">Escrow: ${esc(t.escrowState)}</span>`:''}</div>
  <ol class="steps">${items.join('')}</ol>
  ${d.unlockTime?`<div class="deadlines"><span>Result due <b>${esc(fmtHm(d.submitResultTime))}</b></span><span>Unlock time <b>${esc(fmtHm(d.unlockTime))}</b>: without a defect notice the escrow pays out</span><span>Arbitration from <b>${esc(fmtHm(d.externalDisputeUnlockTime))}</b></span><span>Times: Munich</span></div>`:''}
 </article>`;
}

// Stamp: double hairline frame, German verdict, English caption below.
function stampHtml(t,kind,label,caption){
 const key=`${t.id}:${kind}`;
 const animate=seen.stamp[t.id]!==undefined&&seen.stamp[t.id]!==key;
 return {key,html:`<div class="stamp stamp-${kind} ${animate?'stamp-in':''}" role="img" aria-label="${esc(label)} (${esc(caption)})"><b aria-hidden="true">${esc(label)}</b><span aria-hidden="true">${esc(caption)}</span></div>`};
}
const panelTop=(title,small,sub,stamp,chip='')=>`<div class="panel-top"><div class="panel-hd"><div class="card-h"><h3>${title}<small>${small}</small></h3>${chip}</div>${sub?`<p class="sub">${sub}</p>`:''}</div>${stamp?stamp.html:''}</div>`;
const defectLi=f=>`<li><code>${esc(f.code)}</code><span class="kind">${esc(f.kind??'')}</span>${f.en?`<p class="en">${esc(f.en)}</p>`:''}<p lang="de">${esc(f.textDe)}</p></li>`;

function renderPanels(t){
 const r2=t.inspections[1];
 const failed=t.inspections.find(r=>!r.passed);
 const focus=failed??t.inspections[0];
 const stampKeys=[];
 // panel 1: the inspection that found the defect (else the first)
 let p1;
 if(!focus){
  const active=t.steps.some(s=>s.key==='inspection1'&&s.status==='active');
  p1=`<article class="card panel">${panelTop('Inspection 1','(Prüfung) KoSIT + recipient profile',active?'The delivery is being inspected now: the Gutachter over x402 (1 tADA) or the local KoSIT.':'Once the RechnungsMeister delivers, the buyer agent checks the XRechnung against KoSIT and the recipient profile.')}
   <dl class="kv"><dt>Validator</dt><dd>KoSIT 1.6.3, XRechnung 3.0.2</dd><dt>Test</dt><dd>pinned in the escrow datum (input_hash) before any money moved</dd></dl></article>`;
 }else{
  const st=focus.passed?null:stampHtml(t,'mangel','MANGEL','DEFECT');
  if(st)stampKeys.push(st.key);
  const defects=t.defects.length&&!focus.passed?t.defects:focus.failures;
  p1=`<article class="card panel">${panelTop(`Inspection ${focus.n}`,focus.x402?'(Prüfung) Gutachter over x402':'(Prüfung) local KoSIT',`KoSIT HTTP ${esc(focus.httpStatus??'?')} · ${esc(focus.scenario??'')}${focus.note?` · ${esc(focus.note)}`:''}`,st)}
   ${focus.passed?`<p class="okline">${svg('check')}No defects: KoSIT and every recipient-profile check passed.</p>`:`<ul class="defects">${defects.map(defectLi).join('')}</ul>`}
   <dl class="kv"><dt>Paid</dt><dd>${focus.x402?`1 tADA over x402 ${txLink(focus.tx)}`:'0 tADA (local, no x402)'}</dd><dt>Hash</dt><dd>${focus.hashOk?'delivery = result hash in the escrow datum':'<span class="bad">does not match the hash on Cardano</span>'}</dd></dl>
  </article>`;
 }
 // panel 2: the cure
 let body;
 const cureStep=t.steps.find(s=>s.key==='cure');
 if(t.cure&&t.cure.patch.length)body=`<div class="diff">${t.cure.patch.map(p=>`<div class="diff-row"><div class="diff-field"><code>${esc(p.bt??p.field)}</code>${esc(p.label)}</div>
   <div class="diff-vals"><span class="diff-from ${p.from?'':'is-empty'}">${esc(p.from??'empty')}</span><span class="diff-arrow">→</span><span class="diff-to">${esc(p.to)}</span></div>
   <div class="diff-src">Source: ${esc(p.sourceText??p.source??'–')}, verbatim, not invented</div></div>`).join('')}</div>`;
 else if(t.cure)body=`<p class="sub">Delivery retransmitted (attempt ${esc(t.cure.attempt)}), no field changed.</p>`;
 else if(t.path==='deemed')body=`<p class="okline">${svg('check')}No cure needed: delivery 1 passed the acceptance test.</p>`;
 else if(cureStep?.status==='failed')body=`<div class="note note-red">${esc(cureStep.note??'No cure')}</div>`;
 else if(cureStep?.status==='active')body=`<p class="sub">The RechnungsMeister has the inspection report and cures now. It may only use values that appear verbatim in the invoice text or the recipient profile.</p>`;
 else body=`<p class="sub">Only on a defect: the RechnungsMeister may cure while the escrow is Disputed, using only values that appear verbatim in the invoice text or the recipient profile.</p>`;
 const p2=`<article class="card panel">${panelTop('Cure','(Nachbesserung) § 635 BGB','',null,t.cure?`<span class="chip chip-blue">attempt ${esc(t.cure.attempt)}</span>`:'')}
  ${body}
  ${r2?`<dl class="kv"><dt>Inspection 2</dt><dd>${r2.passed?'<span class="ok">passed</span>':'<span class="bad">defective again</span>'} · KoSIT ${esc(r2.httpStatus)} · ${r2.x402?`x402 ${txLink(r2.tx)}`:'local'}</dd></dl>`:''}
 </article>`;
 // panel 3: result, payment, e-mail
 const step=k=>t.steps.find(s=>s.key===k);
 const paid=step('paid'),refunded=step('refunded');
 let st=null;
 if(t.stamp==='abgenommen'&&(step('accepted')?.status==='done'||step('deemed')?.status==='done'))st=stampHtml(t,'ok','ABGENOMMEN','ACCEPTED');
 else if(t.stamp==='abgelehnt')st=stampHtml(t,'abgelehnt','ABGELEHNT','REFUSED');
 if(st)stampKeys.push(st.key);
 let pay;
 if(paid?.status==='done')pay=`<div class="result-pay">${svg('coin')}<div>Paid · 1 tUSDM to the RechnungsMeister<small>Withdrawn · payment due on acceptance, § 641(1) BGB · ${esc(fmtTime(paid.at))}</small></div></div>${txLink(paid.tx)}`;
 else if(paid?.status==='active')pay=`<div class="result-pay is-wait">${svg('hourglass')}<div>${t.path==='deemed'?'Accepted · payout after the unlock time':'Accepted · payout in progress'}<small>${t.path==='deemed'?`from ${esc(fmtHm(t.deadlines.unlockTime))} (unlock_time), then Withdraw`:'Withdraw to the RechnungsMeister'}</small></div></div>`;
 else if(refunded)pay=`<div class="result-pay is-bad">${svg('undo')}<div>${refunded.status==='done'?'Refused · 1 tUSDM back to the buyer':'Refused · refund authorized'}<small>${esc(refunded.note??'')} ${refunded.at?esc(fmtTime(refunded.at)):''}</small></div></div>${txLink(refunded.tx??step('refundAuthorized')?.tx)}`;
 else pay=`<div class="result-pay is-wait">${svg('lock')}<div>Still open: the escrow holds 1 tUSDM<small>no acceptance, no payment</small></div></div>`;
 const m=t.mail;
 const mailAnim=m&&seen.mail[t.id]===false;
 seen.mail[t.id]=!!m;
 const mail=m?`<div class="mailcard is-sent ${mailAnim?'stamp-in':''}"><span class="mi">${svg('mail')}</span><b>E-invoice sent (E-Rechnung versendet)</b><span>${esc(m.subject)} to ${esc(m.to)} · ${esc(fmtTime(m.sentAt))} · ${m.inMailpit?'in the inbox (Mailpit)':m.inMailpit===false?'no longer in Mailpit':'Mailpit not reachable'}</span></div>`
  :t.path==='refusal'?'':`<div class="mailcard"><span class="mi">${svg('mail')}</span><b>Not sent yet</b><span>SENDEN ${esc(t.invoice.number??'<no.>')} in Sokosumi (a separate paid Task)</span></div>`;
 const p3=`<article class="card panel">${panelTop('Result','acceptance, payment, sending',`${esc(t.status.label)} (${esc(t.status.de)})`,st)}${pay}${mail}</article>`;
 seen.stamp[t.id]=stampKeys.at(-1)??null;
 return `<div class="panels">${p1}${p2}${p3}</div>`;
}

function renderProtocol(t){
 const open=$('#protocol')?.open??false;
 return `<details class="card protocol" id="protocol" ${open?'open':''}><summary>Acceptance log (Abnahmeprotokoll) <small>the buyer agent's journal <span class="mono">${esc(t.id)}</span>, ${t.log.length} entries, in German as the agent wrote them</small></summary>
  <ol lang="de">${t.log.map(l=>`<li class="${/^ALARM/.test(l.line)?'is-alarm':''}"><time>${esc(fmtTime(l.at))}</time><span>${esc(l.line)}</span></li>`).join('')}</ol></details>`;
}

function renderLive(){
 const el=$('#view-live');
 const t=pinnedId&&pinnedId!==state?.liveId?pinned:state?.live;
 if(!state){el.innerHTML='<div class="card empty">Loading the snapshot …</div>';return;}
 if(!t){el.innerHTML=`<div class="card empty">${pinnedId?'Job not found.':'No job in the journal yet. Press "Start demo" or send a PRÜFEN Task in Sokosumi.'}</div>`;return;}
 el.innerHTML=`<div class="live-top">${renderJob(t)}${renderAgents(t)}</div>${renderSteps(t)}${renderPanels(t)}${renderProtocol(t)}`;
}

// ---------- history ----------
function renderHistory(){
 const el=$('#view-history');
 if(!state){el.innerHTML='';return;}
 const jobs=state.jobs,count=f=>jobs.filter(f).length;
 const kpi=(n,label,cls='')=>`<div class="card kpi ${cls}"><b>${n}</b><span>${label}</span></div>`;
 const origin=o=>o?.kind==='sokosumi'?'<span class="chip chip-violet">Sokosumi</span>':o?.kind==='board'?'<span class="chip chip-blue">Board</span>':'<span class="chip chip-grey">CLI</span>';
 el.innerHTML=`<div class="kpis">${kpi(jobs.length,'jobs in the journal')}${kpi(count(j=>['paid','accepted','payout-stuck'].includes(j.status.code)),'accepted (abgenommen)','k-green')}${kpi(count(j=>j.status.code.startsWith('ref')),'refused (abgelehnt)','k-red')}${kpi(count(j=>j.running),'running now','k-blue')}${kpi(jobs.reduce((n,j)=>n+j.inspection.x402,0),'x402 inspections paid','k-violet')}${kpi(count(j=>j.mailed),'e-invoices sent')}</div>
 <div class="card tablecard"><table><thead><tr><th>Status</th><th>Invoice</th><th>Recipient</th><th class="t-r">Amount</th><th>Path</th><th>Inspection</th><th>Origin</th><th>Started</th><th class="t-r">Duration</th></tr></thead><tbody>
 ${jobs.map(j=>`<tr class="rowlink" data-id="${esc(j.id)}" tabindex="0">
  <td class="nw"><span class="chip ${TONE[j.status.tone]} ${j.running?'is-running':''}" title="${esc(j.status.de)}"><i class="dot"></i>${esc(j.status.label)}</span>${j.next?`<small>${esc(j.next)}</small>`:''}</td>
  <td class="num">${esc(j.invoice.number??'–')}${j.demo.seedDefect?'<small>demo defect</small>':''}</td>
  <td class="c-to">${esc(j.invoice.recipientName??'–')}</td>
  <td class="t-r num">${esc(eur(j.invoice.amount))}</td>
  <td class="c-path">${esc(j.pathLabel)}${j.mailed?'<small>✉ e-invoice sent</small>':''}</td>
  <td class="nw">${j.inspection.x402?`<span class="chip chip-violet">x402 ×${j.inspection.x402}</span> `:''}${j.inspection.local?`<span class="chip chip-grey">local ×${j.inspection.local}</span>`:''}</td>
  <td>${origin(j.origin)}</td>
  <td class="mono">${esc(fmtDay(j.createdAt))}</td>
  <td class="t-r mono" ${j.running?`data-since="${esc(j.createdAt)}"`:''}>${esc(fmtDur(j.durationMs))}</td></tr>`).join('')}
 </tbody></table></div>`;
}

// ---------- evidence ----------
const RAIL={escrow:['Escrow','chip-blue'],x402:['x402','chip-violet'],registry:['Registry','chip-grey'],sokosumi:['Sokosumi','chip-grey'],funding:['Funding','chip-grey']};
const runTime=id=>fmtHm(`${id.slice(0,10)}T${id.slice(11,19).replaceAll('-',':')}Z`);
function renderEvidence(){
 const el=$('#view-evidence');
 if(!evidence){el.innerHTML='<div class="card empty">Loading transactions …</div>';return;}
 // A row without url is an x402 payment that never reached the chain: listed, but not counted as a transaction.
 const txs=evidence.txs,onChain=txs.filter(t=>t.url),by=r=>onChain.filter(t=>t.rail===r).length;
 const shown=evFilter==='all'?txs:txs.filter(t=>t.rail===evFilter);
 const kpi=(n,label,cls='')=>`<div class="card kpi ${cls}"><b>${n}</b><span>${label}</span></div>`;
 const f=(k,label)=>`<button type="button" data-filter="${k}" aria-pressed="${evFilter===k}">${label}</button>`;
 el.innerHTML=`<div class="kpis">${kpi(onChain.length,'transactions on Cardano preprod','k-blue')}${kpi(by('escrow'),'Masumi escrow')}${kpi(by('x402'),'x402 inspections','k-violet')}${kpi(by('registry')+by('sokosumi')+by('funding'),'registry, Sokosumi, funding')}</div>
 <div class="filters">${f('all','All')}${f('escrow','Escrow')}${f('x402','x402')}${f('registry','Registry')}${f('sokosumi','Sokosumi')}</div>
 <div class="card tablecard"><table><thead><tr><th>Time (Munich)</th><th>Type</th><th>Transaction</th><th>Rail</th><th>Invoice · run</th><th>Source</th></tr></thead><tbody>
 ${shown.map(t=>`<tr><td class="mono">${t.at?esc(fmtDay(t.at)):'<span class="muted">–</span>'}</td>
  <td><b>${esc(t.name??t.label)}</b>${t.name&&t.name!==t.label?`<small>${esc(t.label)}</small>`:t.section?`<small>${esc(t.section.slice(0,60))}</small>`:''}</td>
  <td class="nw">${t.url?`<a class="mono" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer" title="${esc(t.hash)}">${esc(t.hash.slice(0,14))}…${esc(t.hash.slice(-6))} ${svg('out','class="ext"')}</a>`:`<span class="mono muted" title="${esc(t.hash)}: not on chain">${esc(t.hash.slice(0,14))}…${esc(t.hash.slice(-6))}</span><small>not on chain</small>`}</td>
  <td><span class="chip ${RAIL[t.rail]?.[1]??'chip-grey'}">${esc(RAIL[t.rail]?.[0]??t.rail)}</span></td>
  <td class="nw">${esc(t.invoiceNumber??'')}${t.runs?.length?`<small>run ${esc(runTime(t.runs[0]))}${t.runs.length>1?` +${t.runs.length-1} more (batched tx)`:''}</small>`:''}</td>
  <td><small>${esc(t.sources.join(', '))}</small></td></tr>`).join('')}
 </tbody></table></div>`;
}

// ---------- shell ----------
function render(){
 if(view==='live')renderLive();else if(view==='history')renderHistory();else renderEvidence();
 renderDemo();renderFoot();
}
function renderDemo(){}
function renderFoot(){
 if(!state)return;
 const s=state.sources;
 $('#foot-sources').textContent=`Sources: ${s.journals} journals · MPS ${s.mps} · Mailpit ${s.mailpit} · Blockfrost ${s.blockfrost}${s.tip?` (block ${s.tip})`:''}`;
}
function setLive(s){
 const el=$('#live-indicator');el.dataset.state=s;
 el.querySelector('.live-label').textContent=s==='snapshot'?'Snapshot':s==='offline'?'Snapshot not loaded':'Loading …';
}
function connect(){
 fetch('data/state.json').then(r=>r.ok?r.json():Promise.reject(new Error(`HTTP ${r.status}`))).then(s=>{
  state=s;setLive('snapshot');
  if(pinnedId&&pinnedId!==state.liveId)loadPinned();else render();
 }).catch(()=>setLive('offline'));
}
function tick(){for(const el of document.querySelectorAll('[data-since]'))el.textContent=fmtDur(Date.now()-Date.parse(el.dataset.since));}
function theme(){
 let saved=null;try{saved=localStorage.getItem('abnahme-theme');}catch{}
 const q=new URLSearchParams(location.search).get('theme');
 if(q==='dark'||q==='light')saved=q;
 if(saved)document.documentElement.dataset.theme=saved;
 $('#theme-toggle').addEventListener('click',()=>{
  const dark=document.documentElement.dataset.theme?document.documentElement.dataset.theme==='dark':matchMedia('(prefers-color-scheme: dark)').matches;
  const next=dark?'light':'dark';document.documentElement.dataset.theme=next;
  try{localStorage.setItem('abnahme-theme',next);}catch{}
 });
}

document.addEventListener('DOMContentLoaded',()=>{
 theme();
 document.addEventListener('click',e=>{
  const row=e.target.closest('tr.rowlink');if(row&&!e.target.closest('a'))location.hash=`#live/${encodeURIComponent(row.dataset.id)}`;
  const fb=e.target.closest('[data-filter]');if(fb){evFilter=fb.dataset.filter;renderEvidence();}
 });
 document.addEventListener('keydown',e=>{const row=e.target.closest?.('tr.rowlink');if(row&&e.key==='Enter')location.hash=`#live/${encodeURIComponent(row.dataset.id)}`;});
 addEventListener('hashchange',route);
 route();connect();
});
