// buero/resolve.mjs, the operator CLI for buero.resolve() (QA-16), run as a child process in a temporary repo root.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const CLI=fileURLToPath(new URL('./resolve.mjs',import.meta.url));
const entry={invoiceNumber:'AR-2026-0087',xmlSha256:'a'.repeat(64),taskId:'s1',to:'eingangsrechnungen@bau-isar.example',status:'uncertain',messageId:'<m1@abnahme.local>',sendingAt:'2026-10-30T10:00:00.000Z'};
function root(entries=[entry]){const dir=mkdtempSync(join(tmpdir(),'resolve-'));mkdirSync(join(dir,'.local'),{mode:0o700});writeFileSync(join(dir,'.local/sent-ledger.json'),JSON.stringify({entries}));return dir;}
const run=(dir,...args)=>spawnSync(process.execPath,[CLI,...args],{cwd:dir,encoding:'utf8'});
const ledger=dir=>JSON.parse(readFileSync(join(dir,'.local/sent-ledger.json'),'utf8')).entries;

test('QA-16: node buero/resolve.mjs <nr> sent|not-sent settles an uncertain send and says what it did',()=>{
 const a=root(),sent=run(a,'AR-2026-0087','sent');
 assert.equal(sent.status,0,sent.stderr);assert.match(sent.stdout,/AR-2026-0087.*s1.*<m1@abnahme\.local>.*versendet/su);
 assert.equal(ledger(a)[0].status,'sent');assert.equal(existsSync(join(a,'.local/worker.lock')),false,'the lock is released');
 const b=root(),freed=run(b,'AR-2026-0087','not-sent');
 assert.equal(freed.status,0,freed.stderr);assert.match(freed.stdout,/neues SENDEN/);assert.deepEqual(ledger(b),[]);
});
test('QA-16: the CLI refuses while a worker holds the lock, on an unknown number and on bad arguments, and changes nothing',()=>{
 const dir=root();writeFileSync(join(dir,'.local/worker.lock'),String(process.pid));
 const locked=run(dir,'AR-2026-0087','not-sent');
 assert.equal(locked.status,1);assert.match(locked.stderr,/Worker already running.*Stop the worker/su);assert.equal(ledger(dir)[0].status,'uncertain');
 const free=root(),unknown=run(free,'AR-2026-9999','sent');
 assert.equal(unknown.status,1);assert.match(unknown.stderr,/Kein ungeklärter Versand/);assert.equal(ledger(free)[0].status,'uncertain');
 for(const args of [[],['AR-2026-0087'],['AR-2026-0087','maybe']]){const r=run(free,...args);assert.equal(r.status,2,args.join(' '));assert.match(r.stderr,/Usage: node buero\/resolve\.mjs/);}
});
