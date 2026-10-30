// buero/run.mjs appends one plan/EVIDENCE.md section per process run. A rerun of the same journal (B3: FAILED, then
// REFUSED after the resume) gets a section marked resumed with only the tx rows and protocol lines that are new (LB-4).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {evidenceSection,jobTotal} from './run.mjs';
import {parseFixed} from '../einvoice/parse-fixed.mjs';
import {buildXml} from '../einvoice/build.mjs';

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

const xmlB=await buildXml(parseFixed(readFileSync(new URL('../fixtures/b-abschlag-13b-bau-isar.fixed.txt',import.meta.url),'utf8')));
test('LB2-3: a section names the invoice by its number and file name, never by a local path, and states the job total across processes',()=>{
 const s=evidenceSection({...first,xml:xmlB},{...meta,file:'/private/tmp/lane-b-x1/scratch/d4.txt',elapsed:'2.9 min',jobTotal:'9.9 min'},'');
 assert.doesNotMatch(s,/\/private|\/tmp|lane-b|scratch|Fixture/);
 assert.match(s,/Invoice `AR-2026-0087` \(file `d4\.txt`\)/);assert.match(s,/2\.9 min in this process, job total 9\.9 min across processes/);
 const noXml=evidenceSection(first,{...meta,file:'/Users/someone/Desktop/omur/fixtures/b.txt'},'');
 assert.doesNotMatch(noXml,/\/Users|someone/);assert.match(noXml,/File `b\.txt`/);
 // the wall clock of the job: journal created → its last protocol line, also when the last process only resumed it
 assert.equal(jobTotal({createdAt:'2026-10-30T16:08:54.607Z',log:[{at:'2026-10-30T16:09:00.000Z'},{at:'2026-10-30T16:18:50.400Z'}]}),'9.9 min');
 assert.equal(jobTotal({createdAt:'2026-10-30T16:08:54.607Z',log:[]}),null);
});
test('LANE-A2-2: an x402 payment that never settled is a row without hash or link, also in a resumed section',()=>{
 const unsettled={label:'x402 inspection 1 (not charged, local KoSIT)',at:null,txHash:null,explorerUrl:null};
 const s=evidenceSection({...first,txs:[...first.txs,unsettled]},meta,'');
 assert.ok(s.includes('| x402 inspection 1 (not charged, local KoSIT) |  | – | – |'));assert.doesNotMatch(s,/undefined|`null`/);
 const again=evidenceSection({...later,purchaseId:null,txs:[...later.txs,unsettled]},meta,s);
 assert.deepEqual(again.split('\n').filter(l=>l.startsWith('| x402')),[],'listed once, not again in the resumed section');
});
