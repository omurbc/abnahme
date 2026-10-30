// .gitignore covers the secret-file names this project creates, inside and outside .local/ (audit SECRETS-6).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const ignored=path=>spawnSync('git',['check-ignore','--no-index','-q',path],{cwd:root}).status===0;

test('secret-file names are ignored anywhere in the tree',()=>{
 for(const path of ['.env','gutachter/.env','mps/mps-secrets.env','rechnungsmeister-runtime.env','secrets.env','backup.env',
  'mps-secrets.env.backup','env.backup.gutachter','.env.backup','wallet.mnemonic','key.pem','signing.key',
  '.local/env/buero.env','gutachter/.local/ledger.json','.DS_Store','gutachter/.DS_Store','.claude/scheduled_tasks.lock'])
  assert.ok(ignored(path),`${path} is not ignored`);
});
test('the example env file and the code stay tracked',()=>{
 for(const path of ['.env.example','scripts/env-split.mjs','gutachter/payments.log.json','mps/docker-compose.yml']) assert.ok(!ignored(path),`${path} is ignored`);
});
