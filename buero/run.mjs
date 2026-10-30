// One Abnahme job end to end from a fixture, printed as a tx table and appended to plan/EVIDENCE.md.
// RechnungsMeister must be running (rechnungsmeister/server.mjs). Run from the repo root with the buyer's own env
// profile only (plan/MPS.md, SECRETS-1; no ADMIN_KEY):
//   PATH="/opt/homebrew/opt/node@24/bin:$PATH" node --env-file=.local/env/buero.env --import=./scripts/env-guard.mjs \
//     buero/run.mjs fixtures/b-abschlag-13b-bau-isar.txt bau-isar 18400.00 [--follow]
// Re-running the same command resumes an unfinished job from .local/abnahme-journal/.
// INSPECT_MODE=local skips the paid x402 Gutachter and uses the local KoSIT daemon.
import {appendFileSync,existsSync,readFileSync,realpathSync} from 'node:fs';
import {basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {runAbnahme} from './abnahme.mjs';
import {invoiceNumberOf} from './sokosumi.mjs';
import {requireProfile} from '../scripts/env-split.mjs';

// An x402 payment that did not settle has no hash or link (LANE-A2-2).
const row=t=>`| ${t.label} | ${t.at??''} | ${t.txHash?`\`${t.txHash}\``:'–'} | ${t.explorerUrl??'–'} |`;
// The job's wall clock across processes (a killed run and its resume): journal created → its last protocol line (LB2-3).
export function jobTotal(journal){
 const ms=Date.parse(journal.log?.at(-1)?.at)-Date.parse(journal.createdAt);
 return Number.isFinite(ms)?`${(ms/60000).toFixed(1)} min`:null;
}
// A journal that already has a section (a rerun resumed it, or answered from it) gets a section marked resumed with only
// the tx rows and protocol lines that are new since then; its status replaces the earlier one (LB-4).
// The invoice is named by its number (BT-1) and file name, never by a local path (LB2-3).
export function evidenceSection(result,{file,recipientProfileId,expectedTotal,mode,finishedAt,elapsed,jobTotal:total=null},evidence=''){
 const earlier=evidence.split('\n## ').filter(s=>s.startsWith(`Escrow run ${result.journalId}:`)).join('\n');
 const seen=new Set(earlier.split('\n'));
 let invoice=null;try{invoice=result.xml?invoiceNumberOf(result.xml):null}catch{}
 return [
  `\n## Escrow run ${result.journalId}: ${result.status}${earlier?' (resumed)':''}`,
  '',
  `${invoice?`Invoice \`${invoice}\` (file \`${basename(file)}\`)`:`File \`${basename(file)}\``}, recipient \`${recipientProfileId}\`, expected ${expectedTotal} EUR, ${mode}. Finished ${finishedAt}, ${total?`${elapsed} in this process, job total ${total} across processes`:elapsed}. Purchase \`${result.purchaseId}\`.`,
  ...earlier?['Resumed: the tx rows and protocol lines of the earlier section for this journal are not repeated; this status replaces it.']:[],
  'RechnungsMeister demo switches are in its job file (`.local/rechnungsmeister-jobs/`), reported by `/status` as `demo`.',
  '',
  '| Step | Time (UTC) | Tx | Explorer |','|---|---|---|---|',...result.txs.filter(t=>t.txHash?!earlier.includes(t.txHash):!seen.has(row(t))).map(row),
  '',
  '<details><summary>Abnahmeprotokoll</summary>','',...result.protocolDe.split('\n').map(l=>`- ${l}`).filter(l=>!seen.has(l)),'','</details>','',
 ].join('\n');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){
 try{requireProfile('buero');}catch(e){console.error(`buero/run.mjs: ${e.message}`);process.exit(1);}  // DELTA-SECRETS-5
 const args=process.argv.slice(2);
 const follow=args.includes('--follow');
 const [file,recipientProfileId,expectedTotal]=args.filter(a=>a!=='--follow');
 if(!file||!recipientProfileId||!expectedTotal){console.error('Aufruf: buero/run.mjs <rechnung.txt> <empfaenger-id> <betrag> [--follow]');process.exit(2);}

 const started=Date.now();
 const elapsed=()=>`${((Date.now()-started)/60000).toFixed(1).padStart(5)} min`;
 const result=await runAbnahme({invoiceText:readFileSync(file,'utf8'),recipientProfileId,expectedTotal,followSettlement:follow,onProgress:line=>console.log(`[${elapsed()}] ${line}`)});

 console.log(`\nErgebnis: ${result.status} (Journal ${result.journalId}, Purchase ${result.purchaseId})`);
 console.log(result.txs.map(row).join('\n')||'(keine Transaktionen)');

 const mode=[process.env.INSPECT_MODE==='local'?'INSPECT_MODE=local':'x402 inspection',follow?'--follow':null].filter(Boolean).join(', ');
 const evidence=existsSync('plan/EVIDENCE.md')?readFileSync('plan/EVIDENCE.md','utf8'):'';
 let total=null;try{total=jobTotal(JSON.parse(readFileSync(`.local/abnahme-journal/${result.journalId}.json`,'utf8')))}catch{}
 appendFileSync('plan/EVIDENCE.md',evidenceSection(result,{file,recipientProfileId,expectedTotal,mode,finishedAt:new Date().toISOString(),elapsed:elapsed().trim(),jobTotal:total},evidence));
 console.log('\nAngehängt an plan/EVIDENCE.md');
 process.exit(result.status==='ACCEPTED'?0:1);
}
