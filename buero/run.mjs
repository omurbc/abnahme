// One Abnahme job end to end from a fixture, printed as a tx table and appended to plan/EVIDENCE.md.
// RechnungsMeister must be running (rechnungsmeister/server.mjs). Run from the repo root with the buyer's own env
// profile only (plan/MPS.md, SECRETS-1; no ADMIN_KEY):
//   PATH="/opt/homebrew/opt/node@24/bin:$PATH" node --env-file=.local/env/buero.env --import=./scripts/env-guard.mjs \
//     buero/run.mjs fixtures/b-abschlag-13b-bau-isar.txt bau-isar 18400.00 [--follow]
// Re-running the same command resumes an unfinished job from .local/abnahme-journal/.
// INSPECT_MODE=local skips the paid x402 Gutachter and uses the local KoSIT daemon.
import {appendFileSync,existsSync,readFileSync,realpathSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {runAbnahme} from './abnahme.mjs';

const row=t=>`| ${t.label} | ${t.at??''} | \`${t.txHash}\` | ${t.explorerUrl} |`;
// A journal that already has a section (a rerun resumed it, or answered from it) gets a section marked resumed with only
// the tx rows and protocol lines that are new since then; its status replaces the earlier one (LB-4).
export function evidenceSection(result,{file,recipientProfileId,expectedTotal,mode,finishedAt,elapsed},evidence=''){
 const earlier=evidence.split('\n## ').filter(s=>s.startsWith(`Escrow run ${result.journalId}:`)).join('\n');
 const seen=new Set(earlier.split('\n'));
 return [
  `\n## Escrow run ${result.journalId}: ${result.status}${earlier?' (resumed)':''}`,
  '',
  `Fixture \`${file}\`, recipient \`${recipientProfileId}\`, expected ${expectedTotal} EUR, ${mode}. Finished ${finishedAt}, ${elapsed}. Purchase \`${result.purchaseId}\`.`,
  ...earlier?['Resumed: the tx rows and protocol lines of the earlier section for this journal are not repeated; this status replaces it.']:[],
  'RechnungsMeister demo switches are in its job file (`.local/rechnungsmeister-jobs/`), reported by `/status` as `demo`.',
  '',
  '| Step | Time (UTC) | Tx | Explorer |','|---|---|---|---|',...result.txs.filter(t=>!earlier.includes(t.txHash)).map(row),
  '',
  '<details><summary>Abnahmeprotokoll</summary>','',...result.protocolDe.split('\n').map(l=>`- ${l}`).filter(l=>!seen.has(l)),'','</details>','',
 ].join('\n');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){
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
 appendFileSync('plan/EVIDENCE.md',evidenceSection(result,{file,recipientProfileId,expectedTotal,mode,finishedAt:new Date().toISOString(),elapsed:elapsed().trim()},evidence));
 console.log('\nAngehängt an plan/EVIDENCE.md');
 process.exit(result.status==='ACCEPTED'?0:1);
}
