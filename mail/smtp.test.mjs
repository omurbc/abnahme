import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {sendMail} from './smtp.mjs';

// Fake SMTP server: records commands and the DATA body, answers like Mailpit.
function fakeSmtp(){
 const seen={commands:[],data:''};
 const server=createServer(socket=>{
  let buffer='',inData=false;
  socket.write('220 fake ESMTP\r\n');
  socket.on('data',chunk=>{
   buffer+=chunk;
   if(inData){const end=buffer.indexOf('\r\n.\r\n');if(end<0)return;seen.data=buffer.slice(0,end);buffer=buffer.slice(end+5);inData=false;socket.write('250 2.0.0 Ok: queued as FAKE1\r\n');}
   let i;while(!inData&&(i=buffer.indexOf('\r\n'))>=0){
    const line=buffer.slice(0,i);buffer=buffer.slice(i+2);seen.commands.push(line);
    if(line.startsWith('EHLO'))socket.write('250-fake\r\n250 8BITMIME\r\n');
    else if(line==='DATA'){inData=true;socket.write('354 go ahead\r\n');}
    else if(line==='QUIT'){socket.end('221 bye\r\n');}
    else socket.write('250 OK\r\n');
   }
  });
 });
 return new Promise(r=>server.listen(0,'127.0.0.1',()=>r({server,seen,port:server.address().port})));
}
const decodePart=(data,marker)=>{const part=data.split(/--abnahme-[0-9a-f-]+/).find(p=>p.includes(marker));return Buffer.from(part.split('\r\n\r\n')[1].replace(/\s/g,''),'base64').toString('utf8');};

test('sendMail returns the Message-ID and the 250 reply, with the XML intact as an attachment',async()=>{
 const {server,seen,port}=await fakeSmtp();
 const xml='<?xml version="1.0"?>\n<Invoice><cbc:ID>AR-2026-0087</cbc:ID>Ä</Invoice>\n.\n';
 const r=await sendMail({port,from:'a@x.example',to:'b@y.example',subject:'XRechnung AR-2026-0087 Prüfung',text:'Grüße\n.\nEnde',attachment:{filename:'AR-2026-0087.xml',content:xml,contentType:'application/xml'}});
 server.close();
 assert.match(r.messageId,/^<[0-9a-f-]+@abnahme\.local>$/);assert.equal(r.smtpReply,'250 2.0.0 Ok: queued as FAKE1');
 assert.deepEqual(seen.commands.slice(0,3),['EHLO abnahme.local','MAIL FROM:<a@x.example>','RCPT TO:<b@y.example>']);
 assert.ok(seen.data.includes(`Message-ID: ${r.messageId}`));assert.match(seen.data,/Subject: =\?UTF-8\?B\?/);
 assert.equal(decodePart(seen.data,'filename="AR-2026-0087.xml"'),xml);
 assert.equal(decodePart(seen.data,'text/plain'),'Grüße\n.\nEnde');
});

test('a refused connection reports dataSent=false, so nothing was handed over',async()=>{
 const {server,port}=await fakeSmtp();await new Promise(r=>server.close(r));
 await assert.rejects(sendMail({port,from:'a@x.example',to:'b@y.example',subject:'s',text:'t',attachment:{filename:'f.xml',content:'<a/>',contentType:'application/xml'}}),e=>e.dataSent===false);
});

test('an invalid address is rejected before any SMTP traffic',async()=>{
 await assert.rejects(sendMail({port:1,from:'a@x.example',to:'evil@x.example>\r\nRCPT TO:<other@x.example',subject:'s',text:'t',attachment:{filename:'f.xml',content:'<a/>',contentType:'application/xml'}}),/Invalid e-mail address/);
});
