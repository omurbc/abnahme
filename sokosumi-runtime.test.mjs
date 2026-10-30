import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sokosumiRoot} from './sokosumi-runtime.mjs';
import {SECRETS} from './scripts/env-split.mjs';

test('DELTA-SECRETS-1: `sokosumi skills path` runs with PATH and HOME only, none of the caller\'s secrets',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sokosumi-runtime-'));mkdirSync(join(dir,'bin'));
 const seen=join(dir,'env-names.json');
 writeFileSync(join(dir,'bin/sokosumi'),`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(seen)},JSON.stringify(Object.keys(process.env)));\nprocess.stdout.write(${JSON.stringify(`${dir}/pkg/skills`)}+'\\n');\n`);
 chmodSync(join(dir,'bin/sokosumi'),0o755);
 const saved={...process.env};
 Object.assign(process.env,{PATH:`${dir}/bin:${saved.PATH}`,ABNAHME_ENV_PROFILE:'buero',...Object.fromEntries(SECRETS.map(name=>[name,`sentinel-${name}`]))});
 try{
  assert.equal(sokosumiRoot(),`${dir}/pkg/dist/src`);
  const names=JSON.parse(readFileSync(seen,'utf8'));
  assert.deepEqual(names.filter(name=>SECRETS.includes(name)),[]);
  assert.deepEqual(names.filter(name=>name!=='__CF_USER_TEXT_ENCODING').sort(),['HOME','PATH'],'macOS adds __CF_USER_TEXT_ENCODING to every process');
 }finally{for(const name of Object.keys(process.env))if(!Object.hasOwn(saved,name))delete process.env[name];Object.assign(process.env,saved);}
});
