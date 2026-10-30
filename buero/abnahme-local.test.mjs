import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {runAbnahme} from './abnahme-local.mjs';

test('QA-13: an unreachable KoSIT is reported in German with the failed step, not as "fetch failed"',async()=>{
 const closed=await new Promise(r=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>r(port));});});
 const env={KOSIT_URL:process.env.KOSIT_URL,EXTRACT_MODE:process.env.EXTRACT_MODE};
 process.env.KOSIT_URL=`http://127.0.0.1:${closed}/`;process.env.EXTRACT_MODE='fixed';
 try{
  const r=await runAbnahme({invoiceText:readFileSync(new URL('../fixtures/b-abschlag-13b-bau-isar.fixed.txt',import.meta.url),'utf8'),recipientProfileId:'bau-isar',expectedTotal:18400});
  assert.equal(r.status,'FAILED');assert.match(r.protocolDe,/KoSIT-Prüfung/);assert.match(r.protocolDe,/nicht erreichbar/);assert.doesNotMatch(r.protocolDe,/fetch failed/);
 }finally{for(const [k,v] of Object.entries(env))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});
