import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {inspect} from './inspect.mjs';

async function kosit(status){
 const server=createServer((req,res)=>{ let body=''; req.on('data',c=>body+=c); req.on('end',()=>{ res.writeHead(status,{'content-type':'application/xml'}); res.end(`<rep got="${body.length}"/>`); }); });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {url:`http://127.0.0.1:${server.address().port}/`,close:()=>server.close()};
}

test('KoSIT 200 is a paid ACCEPTABLE inspection',async()=>{
 const k=await kosit(200);
 const r=await inspect('<Invoice/>',{url:k.url}); k.close();
 assert.deepEqual(r,{status:200,body:{verdict:'ACCEPTABLE',httpStatus:200,report:'<rep got="10"/>'}});
});
test('KoSIT 406 is a paid REJECT inspection, still HTTP 200 to the buyer',async()=>{
 const k=await kosit(406);
 const r=await inspect('<Invoice/>',{url:k.url}); k.close();
 assert.equal(r.status,200); assert.equal(r.body.verdict,'REJECT'); assert.equal(r.body.httpStatus,406);
});
test('other KoSIT status is 502, so the middleware does not settle',async()=>{
 const k=await kosit(500);
 const r=await inspect('<Invoice/>',{url:k.url}); k.close();
 assert.equal(r.status,502); assert.equal(r.body.verdict,undefined);
});
test('unreachable KoSIT is 503, so the middleware does not settle',async()=>{
 const k=await kosit(200); const url=k.url; k.close();
 const r=await inspect('<Invoice/>',{url});
 assert.equal(r.status,503); assert.match(r.body.error,/unreachable/);
});
test('stub mode answers ACCEPTABLE without calling KoSIT',async()=>{
 const r=await inspect('<Invoice/>',{url:'http://127.0.0.1:1/',stub:true});
 assert.equal(r.status,200); assert.equal(r.body.verdict,'ACCEPTABLE');
});
