// buero/run.mjs appends one plan/EVIDENCE.md section per process run. A rerun of the same journal (B3: FAILED, then
// REFUSED after the resume) gets a section marked resumed with only the tx rows and protocol lines that are new (LB-4).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evidenceSection} from './run.mjs';

const tx=(label,c)=>({label,at:'2026-10-30T14:00:00.000Z',txHash:c.repeat(64),explorerUrl:`https://preprod.cardanoscan.io/transaction/${c.repeat(64)}`});
const meta={file:'fixtures/b.txt',recipientProfileId:'bau-isar',expectedTotal:'18400.00',mode:'x402 inspection',finishedAt:'2026-10-30T14:12:20.000Z',elapsed:'24.0 min'};
const first={status:'FAILED',journalId:'J1',purchaseId:'p1',txs:[tx('FundsLocked','a'),tx('Disputed','b')],protocolDe:'Auftrag J1: Rechnung für Bau Isar\nALARM: Abnahme J1 hängt'};
const later={status:'REFUSED',journalId:'J1',purchaseId:'p1',txs:[tx('FundsLocked','a'),tx('Disputed','b'),tx('AuthorizeRefund','c')],
 protocolDe:'Auftrag J1: Rechnung für Bau Isar\nALARM: Abnahme J1 hängt\nFortsetzung des Auftrags J1 ab Schritt „notify“.\nRechnung abgelehnt.'};
const txRows=s=>s.split('\n').filter(l=>/^\| .* \| `[0-9a-f]{64}` \|/.test(l)).map(l=>l.split(' | ')[0].slice(2));

test('LB-4: the first run of a journal appends its full section',()=>{
 const s=evidenceSection(first,meta,'# Evidence\n');
 assert.match(s,/^## Escrow run J1: FAILED$/m);assert.doesNotMatch(s,/resumed/i);
 assert.deepEqual(txRows(s),['FundsLocked','Disputed']);
 assert.ok(s.includes('- ALARM: Abnahme J1 hängt'));
});

test('LB-4: a rerun of the same journal is marked resumed and adds only the new tx rows and protocol lines; other journals do not count',()=>{
 const evidence='# Evidence\n'+evidenceSection(first,meta,'')+evidenceSection({...later,journalId:'J2'},meta,'');
 const s=evidenceSection(later,meta,evidence);
 assert.match(s,/^## Escrow run J1: REFUSED \(resumed\)$/m);
 assert.deepEqual(txRows(s),['AuthorizeRefund']);
 assert.ok(s.includes('- Fortsetzung des Auftrags J1 ab Schritt „notify“.'));assert.ok(s.includes('- Rechnung abgelehnt.'));
 assert.ok(!s.includes('- ALARM: Abnahme J1 hängt'));assert.ok(!s.includes('- Auftrag J1'));
});
