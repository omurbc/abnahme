import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
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
