// Runs a copy of kosit/start.sh against docker, curl and shasum shims: no real container is ever touched.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,chmodSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const RULES='<rule>BR-AE-02</rule>';
function setup(){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'kosit-start-'))),kosit=join(dir,'kosit'),bin=join(dir,'bin'),cfg=join(dir,'cfg');
 for(const d of [join(kosit,'dist'),bin,join(cfg,'resources')])mkdirSync(d,{recursive:true});
 copyFileSync(new URL('./start.sh',import.meta.url),join(kosit,'start.sh'));
 writeFileSync(join(kosit,'dist/validator.jar'),'jar');
 writeFileSync(join(cfg,'scenarios.xml'),'<scenarios/>');writeFileSync(join(cfg,'resources/rules.xsl'),RULES);
 assert.equal(spawnSync('zip',['-qr',join(kosit,'dist/cfg.zip'),'.'],{cwd:cfg}).status,0);
 assert.equal(spawnSync('unzip',['-q',join(kosit,'dist/cfg.zip'),'-d',join(kosit,'dist/xrechnung')]).status,0);
 const shim=(name,body)=>{writeFileSync(join(bin,name),`#!/bin/sh\n${body}\n`);chmodSync(join(bin,name),0o755);};
 shim('docker',`echo "$*" >> "$SHIM_LOG"
case "$1" in
 inspect) [ "$SHIM_STATE" = none ] && { echo; echo "Error: No such object" >&2; exit 1; }
  case "$*" in *State.Running*) [ "$SHIM_STATE" = running ] && echo true || echo false;; *Mounts*) echo "$SHIM_MOUNT";; *Config.Image*) echo "$SHIM_IMAGE";; esac;;
 port) echo "$SHIM_PORT";;
esac`);
 shim('curl','exit 0');
 shim('shasum','cat >/dev/null; echo OK');
 const log=join(dir,'docker.log'),mount=join(kosit,'dist');
 const run=(args=[],{state='none',env={},...shimEnv}={})=>{
  writeFileSync(log,'');
  const base={...process.env};delete base.KOSIT_NAME;delete base.KOSIT_PORT;
  const r=spawnSync('bash',[join(kosit,'start.sh'),...args],{encoding:'utf8',env:{...base,PATH:`${bin}:${process.env.PATH}`,SHIM_LOG:log,SHIM_STATE:state,
   SHIM_MOUNT:shimEnv.mount??mount,SHIM_PORT:shimEnv.port??'127.0.0.1:8090',SHIM_IMAGE:shimEnv.image??'eclipse-temurin:21-jre',...env}});
  const calls=readFileSync(log,'utf8').split('\n').filter(Boolean);
  return {...r,calls,removed:calls.filter(c=>/^rm\b/.test(c)),started:calls.filter(c=>/^run\b/.test(c))};
 };
 return {kosit,mount,run};
}

test('a running validator with this checkout\'s port and rules is left alone',()=>{
 const {run}=setup(),r=run([],{state:'running'});
 assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/already running/);
 assert.deepEqual([r.removed,r.started],[[],[]]);
});
test('a running validator from another checkout or on another port is refused, never removed',()=>{
 const {run}=setup();
 for(const other of [{mount:'/elsewhere/kosit/dist'},{port:'127.0.0.1:18090'}]){
  const r=run([],{state:'running',...other});
  assert.notEqual(r.status,0);assert.match(r.stderr,/--replace/);assert.deepEqual([r.removed,r.started],[[],[]]);
 }
});
test('a running validator whose mounted rules differ from the verified zip is refused and left untouched',()=>{
 const {kosit,run}=setup();writeFileSync(join(kosit,'dist/xrechnung/resources/rules.xsl'),'<rule/>');
 const r=run([],{state:'running'});
 assert.notEqual(r.status,0);assert.deepEqual([r.removed,r.started],[[],[]]);
 assert.equal(readFileSync(join(kosit,'dist/xrechnung/resources/rules.xsl'),'utf8'),'<rule/>');
});
test('--replace recreates it from this checkout with the digest-pinned image, loopback only',()=>{
 const {mount,run}=setup(),r=run(['--replace'],{state:'running'});
 assert.equal(r.status,0,r.stderr);assert.deepEqual(r.removed,['rm -f abnahme-kosit']);assert.equal(r.started.length,1);
 const line=r.started[0];
 for(const part of ['--name abnahme-kosit ','-p 127.0.0.1:8090:8080 ',`-v ${mount}:/kosit:ro `])assert.ok(line.includes(part),part);
 assert.match(line,/ eclipse-temurin:21-jre@sha256:[0-9a-f]{64} java /);
});
test('KOSIT_NAME and KOSIT_PORT start a second validator without touching abnahme-kosit',()=>{
 const {run}=setup(),r=run([],{env:{KOSIT_NAME:'abnahme-kosit-ci',KOSIT_PORT:'18090'}});
 assert.equal(r.status,0,r.stderr);assert.deepEqual(r.removed,[]);
 assert.ok(r.started[0].includes('--name abnahme-kosit-ci ')&&r.started[0].includes('-p 127.0.0.1:18090:8080 '),r.started[0]);
 assert.ok(r.calls.every(c=>!/\babnahme-kosit\b(?!-ci)/.test(c)),r.calls.join('\n'));
 assert.match(r.stderr,/KOSIT_URL=http:\/\/127\.0\.0\.1:18090\//); // clients read KOSIT_URL, not KOSIT_PORT
});
test('a tampered or stale rules tree is re-extracted from the verified zip before a start',()=>{
 const {kosit,run}=setup();
 writeFileSync(join(kosit,'dist/xrechnung/resources/rules.xsl'),'<rule/>');writeFileSync(join(kosit,'dist/xrechnung/OLD-RELEASE.txt'),'old');
 const r=run([],{state:'stopped'});
 assert.equal(r.status,0,r.stderr);assert.equal(r.started.length,1);
 assert.equal(readFileSync(join(kosit,'dist/xrechnung/resources/rules.xsl'),'utf8'),RULES);
 assert.equal(existsSync(join(kosit,'dist/xrechnung/OLD-RELEASE.txt')),false);
});
