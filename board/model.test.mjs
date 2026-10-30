// board/model.mjs against real journals of recorded preprod runs (board/fixtures/, copied from .local/ with job_token,
// the RechnungsMeister token/response and the large KoSIT report XML dropped). Running states are cut from the same
// journals, so every step a live run passes through is checked.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {safeJournal,safeRmJob,timeline,summary,evidence,parseEvidenceMd,explorerUrl} from './model.mjs';

const fx=p=>JSON.parse(readFileSync(new URL(`./fixtures/${p}`,import.meta.url),'utf8'));
const payments=fx('payments.log.json');
const NOW=Date.parse('2026-10-30T16:00:00Z');
const RUNS={
 cure:['2026-10-30T13-47-45-967Z-28273e','87ceacd7-9e14-471e-ab64-fcb159460c38'],
 deemed:['2026-10-30T11-46-39-564Z-4debad','84f3bd78-70d7-4e88-ad75-4e4d241ff5c2'],
 refused:['2026-10-30T13-49-02-329Z-74c5a8','3676f1ca-de40-44b3-8136-08102e381baf'],
 protective:['2026-10-30T13-48-25-176Z-c7699f','85723833-7968-4510-bf1a-fc271ea37272'],
 cheat:['2026-10-30T09-17-08-516Z-a0d3cb','5bc49a2c-617a-4b3a-b4ef-687e50b37a1c'],
};
const raw=name=>fx(`journals/${RUNS[name][0]}.json`);
const rmJob=name=>safeRmJob(fx(`rm-jobs/${RUNS[name][1]}.json`));
const build=(name,ctx={},j=raw(name))=>timeline(safeJournal(j),{rmJob:rmJob(name),payments,now:j.cutAt??NOW,...ctx});
const keys=t=>t.steps.map(s=>s.key);
const st=(t,key)=>t.steps.find(s=>s.key===key);

// A journal as it was while running: the log up to (excluding) the first line matching `until`, the attempts made by then,
// seen at the moment of that line (cutAt is the clock for the model, ignored by safeJournal).
function cut(j,until,{stage,attempts=0,round=0,disputes=0,extra={}}){
 const i=j.log.findIndex(l=>until.test(l.line));
 return {...j,cutAt:Date.parse(j.log[i].at),log:j.log.slice(0,i),attempts:j.attempts.slice(0,attempts),inspectionTxs:j.inspectionTxs.slice(0,attempts),txs:[],stage,status:undefined,round,disputes,
  escrowState:undefined,withdrawAuthorizedSeen:false,lastXml:attempts?j.lastXml:undefined,...extra};
}

test('dispute → cure → accept with two paid x402 inspections: every step done, with time, tx link and law', ()=>{
 const t=build('cure',{mail:{to:'eingangsrechnungen@bau-isar.example',sentAt:'2026-10-30T14:03:04.579Z',messageId:'<ad5d99a0-21e9-40eb-b5c5-f5f3ca11aee3@abnahme.local>',inMailpit:true}});
 assert.deepEqual(keys(t),['locked','delivered','inspection1','disputed','cure','inspection2','accepted','paid','mail']);
 assert.deepEqual(t.steps.map(s=>s.status),['done','done','failed','done','done','done','done','done','done']);
 assert.equal(t.status.code,'paid');assert.equal(t.running,false);assert.equal(t.path,'cure');assert.equal(t.stamp,'abgenommen');
 assert.equal(t.invoice.number,'AR-2026-1101');assert.equal(t.invoice.recipientName,'Bau Isar Generalunternehmer GmbH');assert.equal(t.invoice.amount,18400);
 assert.deepEqual(t.steps.map(s=>[s.title,s.term,s.law]).filter(([,,law])=>law),[['Funds locked',null,'§ 631 BGB'],['Defect notice','Mängelrüge','§ 640(2) BGB'],
  ['Cure','Nachbesserung','§ 635 BGB'],['Acceptance','Abnahme','§ 640(1) BGB'],['Paid','Vergütung fällig','§ 641(1) BGB']]);
 for(const k of ['locked','delivered','disputed','cure','accepted','paid']){
  const s=st(t,k);
  assert.match(s.tx.hash,/^[0-9a-f]{64}$/,k);assert.equal(s.tx.url,`https://preprod.cardanoscan.io/transaction/${s.tx.hash}`,k);assert.ok(s.at,k);
 }
 assert.deepEqual(['disputed','cure','accepted','paid'].map(k=>st(t,k).tx.label),['Disputed','ResultSubmitted (cure)','AuthorizeWithdrawal','Withdrawn']);
 // Both inspections were paid over x402 (1 tADA each), the first found the seeded §13b defect in German.
 assert.deepEqual(t.inspections.map(r=>[r.x402,r.passed,r.httpStatus]),[[true,false,406],[true,true,200]]);
 assert.deepEqual(t.inspections.map(r=>r.tx.hash.slice(0,8)),['06203bd1','c0d8679b']);
 assert.equal(st(t,'inspection1').amount,'1 tADA');
 assert.deepEqual(t.defects.map(d=>[d.code,d.kind,d.en]),[['BR-AE-02','KoSIT rule (EN 16931)','Buyer VAT ID missing (§13b reverse charge)'],
  ['ABN-BT48','Recipient profile','Buyer VAT ID (BT-48) missing or wrong under §13b']]);
 assert.match(t.defects[0].textDe,/USt-IdNr\. \(BT-48\)/,'the German KoSIT text stays next to the English line');
 assert.deepEqual(t.cure.patch.map(p=>[p.bt,p.label,p.from,p.to,p.sourceText]),[['BT-48','Buyer VAT ID',null,'DE287654321','from the invoice text']]);
 assert.equal(st(t,'cure').note,'BT-48: empty → DE287654321');
 assert.deepEqual(t.demo,{seedDefect:true,seedSwitch:true,cheat:false});
 assert.equal(st(t,'mail').status,'done');
 // 14:47:45 → Withdrawn at 14:59:40 (block time), all within the run
 assert.ok(t.durationMs>11*60000&&t.durationMs<16*60000,String(t.durationMs));
 assert.equal(summary(t).pathLabel,'Defect → cure → accepted');assert.equal(summary(t).inspection.x402,2);
 assert.deepEqual([t.status.label,t.status.de],['Paid','bezahlt']);
});

test('a live run lights up step by step: active → done, MANGEL before the cure, ABGENOMMEN after', ()=>{
 const j=raw('cure');
 const locking=build('cure',{},cut(j,/^Geld gesperrt/,{stage:'wait-locked'}));
 assert.equal(locking.status.code,'running');assert.equal(locking.running,true);assert.equal(locking.path,'pending');
 assert.deepEqual(locking.steps.map(s=>s.status),['active','pending','pending','pending','pending','pending','pending','pending','pending']);
 assert.deepEqual(locking.steps.filter(s=>s.conditional).map(s=>s.key),['disputed','cure','inspection2'],'dispute and cure only on a defect');

 const delivering=build('cure',{},cut(j,/^Ergebnis auf Cardano/,{stage:'wait-result'}));
 assert.deepEqual(delivering.steps.slice(0,3).map(s=>s.status),['done','active','pending']);

 const inspecting=build('cure',{},cut(j,/^Prüfung 1/,{stage:'inspect'}));
 assert.equal(st(inspecting,'inspection1').status,'active');assert.equal(inspecting.stamp,null);

 const disputing=build('cure',{},cut(j,/^Streitfall bestätigt/,{stage:'wait-disputed',attempts:1}));
 assert.equal(st(disputing,'inspection1').status,'failed');assert.equal(st(disputing,'disputed').status,'active');
 assert.equal(disputing.stamp,'mangel');assert.equal(disputing.path,'cure');
 assert.equal(st(disputing,'cure').conditional,false);

 const curing=build('cure',{},cut(j,/^Nachbesserung 1 auf Cardano/,{stage:'wait-result',attempts:1,round:1,disputes:1}));
 assert.equal(st(curing,'disputed').status,'done');assert.equal(st(curing,'cure').status,'active');
 assert.equal(curing.cure.patch[0].to,'DE287654321','the diff shows as soon as the seller answers the dispute');

 const releasing=build('cure',{},cut(j,/^ABGENOMMEN/,{stage:'wait-withdrawn',attempts:2,round:1,disputes:1,extra:{withdrawAuthorizedSeen:true}}));
 assert.equal(st(releasing,'accepted').status,'done');assert.equal(st(releasing,'paid').status,'active');
 assert.equal(releasing.stamp,'abgenommen');assert.equal(releasing.status.code,'running');
});

test('live MPS history adds tx hashes before the journal has them, with confirmations from the chain tip', ()=>{
 const j=cut(raw('cure'),/^Streitfall bestätigt/,{stage:'wait-disputed',attempts:1});
 const chainTxs=[
  {label:'FundsLocked',txHash:'a'.repeat(64),status:'Confirmed',at:'2026-10-30T13:49:51.000Z',blockHeight:100},
  {label:'ResultSubmitted',txHash:'b'.repeat(64),status:'Confirmed',at:'2026-10-30T13:51:17.000Z',blockHeight:104},
  {label:'Disputed',txHash:'c'.repeat(64),status:'Pending',at:null,blockHeight:null},
 ];
 const t=build('cure',{chainTxs,tip:110,escrowState:'ResultSubmitted'},j);
 assert.equal(st(t,'locked').tx.confirmations,11);assert.equal(st(t,'delivered').tx.confirmations,7);
 assert.equal(st(t,'disputed').status,'active','a pending dispute tx is shown, but not as done');
 assert.equal(st(t,'disputed').tx.hash,'c'.repeat(64));
 assert.equal(st(t,'locked').tx.url,explorerUrl('a'.repeat(64)));
});

test('a run without progress for 45 min is shown as stalled, not as running', ()=>{
 const j=cut(raw('cure'),/^Prüfung 1/,{stage:'inspect'});
 const t=build('cure',{now:j.cutAt+46*60000},j);
 assert.equal(t.status.code,'stale');assert.equal(t.running,false);
 assert.ok(!t.steps.some(s=>s.status==='active'));
});

test('deemed acceptance: no dispute, the escrow pays after unlock_time (§ 640 Abs. 2)', ()=>{
 const t=build('deemed');
 assert.deepEqual(keys(t),['locked','delivered','inspection1','deemed','paid','mail']);
 assert.equal(t.path,'deemed');assert.equal(t.status.code,'paid');
 assert.equal(st(t,'deemed').law,'§ 640(2) BGB');assert.equal(st(t,'paid').tx.label,'Withdrawn (deemed acceptance)');
 assert.equal(st(t,'inspection1').amount,'0 tADA','local KoSIT, no x402 payment');
 // the seed switch was on, but a hv-giesing invoice has no §13b BT-48 to drop
 assert.deepEqual(t.demo,{seedDefect:false,seedSwitch:true,cheat:false});
 assert.equal(st(t,'mail').status,'pending');
 assert.equal(summary(t).pathLabel,'Accepted, no defect');
});

test('refusal: an incurable defect ends in AuthorizeRefund and the money goes back, no e-mail step', ()=>{
 const t=build('refused');
 assert.deepEqual(keys(t),['locked','delivered','inspection1','disputed','cure','refundAuthorized','refunded']);
 assert.deepEqual(t.steps.map(s=>s.status),['done','done','failed','done','failed','done','done']);
 assert.equal(t.status.code,'refunded');assert.equal(t.stamp,'abgelehnt');
 assert.deepEqual(t.defects.map(d=>d.code),['ABN-BETRAG']);
 assert.match(st(t,'cure').note,/^not curable: Mangel ABN-BETRAG ist nicht heilbar/);
 assert.equal(st(t,'refunded').amount,'1 tUSDM → buyer');
 assert.equal(t.defects[0].en,'Payable amount differs from the agreed total');
 assert.equal(summary(t).pathLabel,'Defect → refused');
});

test('protective Mängelrüge (ESCROW-1): the dispute comes before the first inspection', ()=>{
 const t=build('protective');
 assert.deepEqual(keys(t),['locked','delivered','disputed','inspection1','cure','inspection2','accepted','paid','mail']);
 assert.deepEqual([st(t,'disputed').title,st(t,'disputed').term],['Protective defect notice','vorsorgliche Mängelrüge']);
 assert.deepEqual([t.protective.code,t.protective.en,t.protective.textDe],['ABN-LIEFERUNG','Seller did not deliver the result','Der RechnungsMeister liefert das Ergebnis nicht aus (HTTP 500).']);
 assert.equal(t.status.code,'paid');assert.equal(t.alarm,null);
});

test('CHEAT refusal: both deliveries fail the on-chain hash check; the refund shows as done once MPS reports it', ()=>{
 const stuck=build('cheat');
 assert.deepEqual(stuck.inspections.map(r=>[r.passed,r.hashOk]),[[false,false],[false,false]]);
 assert.equal(stuck.demo.cheat,true);
 assert.deepEqual(keys(stuck),['locked','delivered','inspection1','disputed','cure','inspection2','refundAuthorized','refunded']);
 assert.equal(st(stuck,'refunded').status,'active');assert.match(st(stuck,'refunded').note,/#1327/);
 assert.equal(stuck.status.code,'refused');
 const repaired=build('cheat',{escrowState:'RefundWithdrawn'});
 assert.equal(st(repaired,'refunded').status,'done');assert.equal(repaired.status.code,'refunded');
});

test('no token, nonce, invoice text or delivered XML leaves the model', ()=>{
 const j=raw('cure');
 j.startJob.job_token='f00d'.repeat(16);
 const t=build('cure',{},j);
 const out=JSON.stringify([t,summary(t)]);
 for(const secret of [j.startJob.job_token,j.nonce,j.startJob.sellerVKey,j.startJob.blockchainIdentifier,j.inputHash])assert.ok(!out.includes(secret));
 assert.doesNotMatch(out,/Lindwurmstraße|<cbc:|job_token/);
 const rm=JSON.stringify(rmJob('cure'));
 assert.doesNotMatch(rm,/"invoiceText"|Lindwurmstraße|token|"result"/);
});

test('evidence: run tables, numbered README rows and journals merge into one row per tx hash', ()=>{
 const md=['## Escrow run 2026-10-30T09-06-44-587Z-90ef74: ACCEPTED','| Step | Time (UTC) | Tx | Explorer |','|---|---|---|---|',
  `| FundsLocked | 2026-10-30T09:08:47.000Z | \`${'1'.repeat(64)}\` | https://preprod.cardanoscan.io/transaction/${'1'.repeat(64)} |`,
  `| x402 inspection 1 |  | \`${'2'.repeat(64)}\` | x |`,'## Audit','| 7 | Deemed | Round 0 | FundsLocked `'+'3'.repeat(64)+'`, Withdrawn `'+'4'.repeat(64)+'` | PASS |'].join('\n');
 const entries=parseEvidenceMd(md,'plan/EVIDENCE.md');
 assert.deepEqual(entries.map(e=>[e.hash[0],e.label,e.at]),[['1','FundsLocked','2026-10-30T09:08:47.000Z'],['2','x402 inspection 1',null],['3','Deemed',null],['4','Deemed',null]]);
 const readme=parseEvidenceMd(`| 2 | RechnungsMeister registration (agent NFT mint) | Masumi registry | Seller | [\`8548…\`](https://preprod.cardanoscan.io/transaction/${'5'.repeat(64)}) |`,'README.md');
 assert.equal(readme[0].label,'RechnungsMeister registration (agent NFT mint)');
 const t=build('cure');
 const ev=evidence({timelines:[t],payments,docs:[{name:'README.md',entries:readme},{name:'plan/EVIDENCE.md',entries:[{hash:st(t,'locked').tx.hash,label:'FundsLocked',section:'x',at:null,source:'plan/EVIDENCE.md'}]}]});
 const locked=ev.find(e=>e.hash===st(t,'locked').tx.hash);
 assert.deepEqual(locked.sources,['Journal','plan/EVIDENCE.md']);assert.equal(locked.rail,'escrow');assert.equal(locked.invoiceNumber,'AR-2026-1101');
 assert.equal(ev.find(e=>e.hash==='5'.repeat(64)).rail,'registry');
 assert.equal(ev.find(e=>e.hash===t.inspections[0].tx.hash).rail,'x402');
 assert.equal(new Set(ev.map(e=>e.hash)).size,ev.length);
 assert.ok(!ev.some(e=>e.hash==='1482258bad80ee9f5432465174ae0e545511f6c6758572168c5c820dcda66dd0'),'a not-charged x402 attempt is no evidence');
});

test('CAMPAIGN2-5: an x402 payment that never settled is listed as not charged, without a link; settled ones (also the first log format without a status) keep theirs',()=>{
 const h=c=>c.repeat(64);
 const pays=[{time:'2026-10-30T16:04:27.725Z',id:'d4',txHash:h('7'),verdict:null,status:'unknown',httpStatus:402,sends:9,error:'invalid_exact_cardano_payload_nonce_not_on_chain'},
  {time:'2026-10-30T16:30:00.000Z',id:'s1',txHash:h('8'),verdict:null,status:'sent'},
  {time:'2026-10-30T08:58:42.481Z',txHash:h('9'),verdict:'ACCEPTABLE'},
  {time:'2026-10-30T16:37:20.935Z',id:'01',txHash:h('a'),verdict:'REJECT',status:'settled'}];
 // a run table elsewhere that still lists the unsettled hash does not bring its link back
 const docs=[{name:'plan/EVIDENCE.md',entries:[{hash:h('7'),label:'x402 inspection 1',section:'x',at:null,source:'plan/EVIDENCE.md'}]}];
 const ev=evidence({timelines:[],payments:pays,docs}),by=c=>ev.find(e=>e.hash===h(c));
 assert.deepEqual([by('7').url,by('7').name,by('7').rail],[null,'x402 (not charged, local KoSIT)','x402']);
 assert.deepEqual([by('8').url,by('8').name],[null,'x402 (payment pending)']);
 assert.equal(by('9').url,explorerUrl(h('9')));assert.equal(by('a').url,explorerUrl(h('a')));
});

// D1-2, D3, D4 in campaign 2: AuthorizeWithdrawal on chain, the seller's MPS payment record in WaitingForManualAction.
const stuckPayout=()=>{const j=raw('cure');return {...j,escrowState:'WithdrawAuthorized',txs:j.txs.filter(t=>t.label!=='Withdrawn'),
 log:[...j.log.slice(0,-1),{at:'2026-10-30T14:22:06.000Z',line:'ABGENOMMEN. Zahlung freigegeben (WithdrawAuthorized); die Auszahlung an den RechnungsMeister steht noch aus.'}]};};
test('CAMPAIGN2-4: an accepted job whose payout is stuck at MPS is an amber alert, not a green "payout pending"',()=>{
 const authorizedAt=Date.parse('2026-10-30T13:56:49.000Z'),MIN=60000;
 const fresh=build('cure',{now:authorizedAt+8*MIN},stuckPayout());
 assert.deepEqual([fresh.status.code,fresh.status.tone,fresh.alarm,summary(fresh).next],['accepted','green',null,'payout pending'],'right after the release the payout is just pending');
 for(const [why,t] of [['WithdrawAuthorized for more than 15 min without a Withdraw',build('cure',{now:authorizedAt+16*MIN},stuckPayout())],
  ['the seller payment record waits for an operator',build('cure',{now:authorizedAt+8*MIN,sellerAction:'WaitingForManualAction'},stuckPayout())]]){
  assert.equal(t.status.code,'payout-stuck',why);assert.equal(t.status.tone,'amber',why);
  assert.match(t.alarm,/^Payout stuck at Masumi Payment Service, operator repair pending/,why);
  assert.notEqual(summary(t).next,'payout pending',why);assert.equal(t.stamp,'abgenommen',why);
 }
 const paid=build('cure',{now:authorizedAt+60*MIN,escrowState:'Withdrawn'},stuckPayout());
 assert.deepEqual([paid.status.code,paid.alarm],['paid',null],'once MPS reports the Withdraw, the alert is gone');
});
