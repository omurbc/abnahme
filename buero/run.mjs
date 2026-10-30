// One Abnahme job end to end from a fixture, printed as a tx table and appended to plan/EVIDENCE.md.
// RechnungsMeister must be running (rechnungsmeister/server.mjs). Run from the repo root:
//   PATH="/opt/homebrew/opt/node@24/bin:$PATH" node --env-file=.env --env-file=.local/mps.env \
//     --env-file=.local/buero-buyer-runtime.env buero/run.mjs fixtures/b-abschlag-13b-bau-isar.txt bau-isar 18400.00 [--follow]
// Re-running the same command resumes an unfinished job from .local/abnahme-journal/.
// INSPECT_MODE=local skips the paid x402 Gutachter and uses the local KoSIT daemon.
import {appendFileSync,readFileSync} from 'node:fs';
import {runAbnahme} from './abnahme.mjs';

const args=process.argv.slice(2);
const follow=args.includes('--follow');
const [file,recipientProfileId,expectedTotal]=args.filter(a=>a!=='--follow');
if(!file||!recipientProfileId||!expectedTotal){console.error('Aufruf: buero/run.mjs <rechnung.txt> <empfaenger-id> <betrag> [--follow]');process.exit(2);}

const started=Date.now();
const elapsed=()=>`${((Date.now()-started)/60000).toFixed(1).padStart(5)} min`;
const result=await runAbnahme({invoiceText:readFileSync(file,'utf8'),recipientProfileId,expectedTotal,followSettlement:follow,onProgress:line=>console.log(`[${elapsed()}] ${line}`)});

console.log(`\nErgebnis: ${result.status} (Journal ${result.journalId}, Purchase ${result.purchaseId})`);
const rows=result.txs.map(t=>`| ${t.label} | ${t.at??''} | \`${t.txHash}\` | ${t.explorerUrl} |`);
console.log(rows.join('\n')||'(keine Transaktionen)');

const mode=[process.env.INSPECT_MODE==='local'?'INSPECT_MODE=local':'x402 inspection',follow?'--follow':null].filter(Boolean).join(', ');
appendFileSync('plan/EVIDENCE.md',[
 `\n## Escrow run ${result.journalId}: ${result.status}`,
 '',
 `Fixture \`${file}\`, recipient \`${recipientProfileId}\`, expected ${expectedTotal} EUR, ${mode}. Finished ${new Date().toISOString()}, ${elapsed().trim()}. Purchase \`${result.purchaseId}\`.`,
 'RechnungsMeister demo switches are in its job file (`.local/rechnungsmeister-jobs/`), reported by `/status` as `demo`.',
 '',
 '| Step | Time (UTC) | Tx | Explorer |','|---|---|---|---|',...rows,
 '',
 '<details><summary>Abnahmeprotokoll</summary>','',...result.protocolDe.split('\n').map(l=>`- ${l}`),'','</details>','',
].join('\n'));
console.log('\nAngehängt an plan/EVIDENCE.md');
process.exit(result.status==='ACCEPTED'?0:1);
