import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {extractLlm} from './extract.mjs';
import {parseFixed} from './parse-fixed.mjs';

const fixture=name=>readFileSync(new URL(`../fixtures/${name}`,import.meta.url),'utf8');
const skip=process.env.RUN_LLM_TESTS==='1'?false:'live Claude call; set RUN_LLM_TESTS=1 (needs ANTHROPIC_API_KEY)';

test('Claude extracts the free-text § 13b progress invoice like the fixed-layout version',{skip,timeout:180000},async()=>{
 const llm=await extractLlm(fixture('b-abschlag-13b-bau-isar.txt'));
 const fixed=parseFixed(fixture('b-abschlag-13b-bau-isar.fixed.txt'));
 for(const key of ['invoiceNumber','invoiceDate','invoiceType','serviceDate','sellerName','sellerPostcode','sellerCity','sellerVatId','sellerContactName','sellerEmail','buyerName','buyerPostcode','buyerVatId','buyerEmail','buyerReference','netTotal','vatTotal','grossTotal','reverseCharge'])
  assert.deepEqual(llm[key],fixed[key],key);
 assert.equal(llm.sellerIban.replace(/\s/g,''),fixed.sellerIban);
 assert.deepEqual(llm.lines.map(({quantity,unit,unitPrice,vatCategory,vatRate})=>({quantity,unit,unitPrice,vatCategory,vatRate})),fixed.lines.map(({quantity,unit,unitPrice,vatCategory,vatRate})=>({quantity,unit,unitPrice,vatCategory,vatRate})));
});

// Fake Anthropic client: records calls, answers with the given response.
const fakeClient=response=>{const calls=[];return {calls,beta:{messages:{parse:async body=>{calls.push(body);return response;}}}};};

test('extraction refuses text over 16.000 characters before any model call',async()=>{
 const client=fakeClient({stop_reason:'end_turn',parsed_output:{}});
 await assert.rejects(extractLlm('x'.repeat(16001),client),/zu lang \(16\.001 Zeichen, höchstens 16\.000\)/);
 assert.equal(client.calls.length,0);
 await extractLlm('x'.repeat(16000),client);
 assert.equal(client.calls.length,1);
});

test('a refusal, a cut-off or an unparsed answer fails closed, never a half-built invoice',async()=>{
 for(const response of [{stop_reason:'refusal',parsed_output:null},{stop_reason:'max_tokens',parsed_output:{invoiceNumber:'1'}},{stop_reason:'end_turn',parsed_output:null}])
  await assert.rejects(extractLlm('Rechnung',fakeClient(response)),/Claude extraction stopped/);
});

test('the default client asks for a 120 s timeout and retries a failing API once, not twice (no 30-min stall)',async()=>{
 const seen=[];
 const server=createServer((req,res)=>{req.resume();req.on('end',()=>{seen.push({timeout:req.headers['x-stainless-timeout'],retry:req.headers['x-stainless-retry-count']});res.writeHead(500,{'content-type':'application/json','retry-after-ms':'1'});res.end('{"type":"error","error":{"type":"api_error","message":"fake"}}');});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const saved={ANTHROPIC_BASE_URL:process.env.ANTHROPIC_BASE_URL,ANTHROPIC_API_KEY:process.env.ANTHROPIC_API_KEY,ANTHROPIC_AUTH_TOKEN:process.env.ANTHROPIC_AUTH_TOKEN};
 Object.assign(process.env,{ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,ANTHROPIC_API_KEY:'sk-ant-test-not-a-key'});delete process.env.ANTHROPIC_AUTH_TOKEN;
 try{await assert.rejects(extractLlm('Rechnung'));}
 finally{server.close();for(const [k,v] of Object.entries(saved))v===undefined?delete process.env[k]:process.env[k]=v;}
 assert.deepEqual(seen,[{timeout:'120',retry:'0'},{timeout:'120',retry:'1'}]);
});
