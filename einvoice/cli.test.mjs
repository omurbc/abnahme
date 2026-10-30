import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {abnahme,summaryDe} from './cli.mjs';
import {kositAvailable} from '../verifier/kosit.mjs';
import {loadAcceptance} from '../verifier/profile.mjs';

const path=rel=>fileURLToPath(new URL(rel,import.meta.url));
const FIXTURE=path('../fixtures/b-abschlag-13b-bau-isar.fixed.txt');
const skip=await kositAvailable()?false:'KoSIT not running on 127.0.0.1:8090 (start it with kosit/start.sh)';
const cli=(...args)=>spawnSync(process.execPath,[path('./cli.mjs'),...args],{encoding:'utf8',env:{...process.env,EXTRACT_MODE:'fixed'}});
// Fixture b with Pos. 1 inflated 12.600 -> 112.600 and the printed totals kept consistent: the invoice agrees with
// itself, so only an independent expected total can catch it.
const inflated=readFileSync(FIXTURE,'utf8').replace('line: 1 | LS | 12600.00','line: 1 | LS | 112600.00').replace('netTotal: 18400.00','netTotal: 118400.00').replace('grossTotal: 18400.00','grossTotal: 118400.00');

test('abnahme() needs the expected total from outside the invoice',async()=>{
 await assert.rejects(abnahme(readFileSync(FIXTURE,'utf8'),'bau-isar',{mode:'fixed'}),/erwartete Bruttobetrag fehlt/);
 const r=cli(FIXTURE,'bau-isar');
 assert.equal(r.status,2);
 assert.match(r.stderr,/<betrag>/);
});

test('an internally consistent inflated invoice is refused against the independent expected total',{skip},async()=>{
 assert.notEqual(inflated,readFileSync(FIXTURE,'utf8'));
 const r=await abnahme(inflated,'bau-isar',{mode:'fixed',expectedTotal:18400});
 assert.equal(r.checks.passed,false);
 assert.deepEqual(r.checks.failures.map(f=>f.code),['ABN-BETRAG']);
 const ok=cli(FIXTURE,'bau-isar','18400.00');
 assert.equal(ok.status,0,ok.stdout+ok.stderr);
 assert.match(ok.stdout,/Zahlbetrag laut XRechnung: 18\.400,00 € \(erwartet: 18\.400,00 €\)/);
});

// Spawned as a script the CLI must run on every Node the engines field allows (import.meta.main is Node >= 24.2 only).
test('the CLI runs as a script: exit 1 and ABGELEHNT for fixture c, exit 2 without arguments',{skip},()=>{
 const c=cli(path('../fixtures/c-abschlag-13b-ohne-ustid.fixed.txt'),'bau-isar','18400.00');
 assert.equal(c.status,1,c.stderr);
 assert.match(c.stdout,/^Abnahme: ABGELEHNT/);
 const none=cli();
 assert.equal(none.status,2);
 assert.match(none.stderr,/^Aufruf/);
});

test('the summary of a document the checks cannot read still says ABGELEHNT with its defects, it does not throw',()=>{
 const out=summaryDe({acceptance:loadAcceptance(),recipient:{id:'bau-isar'},profileHash:'h',fields:{invoiceNumber:'1',invoiceDate:'2026-10-28',sellerName:'S',buyerName:'B'},xml:'<Invoice>&D;</Invoice>',
  kosit:{httpStatus:422,scenario:null},checks:{passed:false,failures:[{code:'ABN-XML',textDe:'Die gelieferte XML-Datei kann nicht sicher gelesen werden.'}],minor:[]},expectedTotal:18400});
 assert.match(out,/^Abnahme: ABGELEHNT/);
 assert.match(out,/Zahlbetrag laut XRechnung: unbekannt \(erwartet: 18\.400,00 €\)/);
 assert.match(out,/\[ABN-XML\]/);
});

test('importing the CLI module never throws, whatever argv[1] is (buero/abnahme-local.mjs imports summaryDe)',()=>{
 const r=spawnSync(process.execPath,['-e',`import(${JSON.stringify(path('./cli.mjs'))}).then(()=>console.log('import ok'))`,'not-a-file'],{encoding:'utf8'});
 assert.equal(r.stdout.trim(),'import ok',r.stderr);
});
