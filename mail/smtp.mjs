// Minimal SMTP client (node:net, no dependency) for the local Mailpit inbox. Plain SMTP, no TLS, no AUTH:
// it only talks to 127.0.0.1. One message per connection: EHLO, MAIL, RCPT, DATA, QUIT.
import {connect} from 'node:net';
import {randomUUID} from 'node:crypto';

const CRLF='\r\n';
const b64=text=>Buffer.from(text,'utf8').toString('base64');
const wrap=text=>text.replace(/.{1,76}/g,'$&'+CRLF);
const header=text=>/^[\x20-\x7e]*$/.test(text)?text:`=?UTF-8?B?${b64(text)}?=`;
const address=text=>{if(!/^[^\s<>@]+@[^\s<>@]+$/.test(text))throw new Error(`Invalid e-mail address: ${text}`);return text;};

export function buildMessage({from,to,subject,text,attachment,messageId,date=new Date()}){
 const boundary=`abnahme-${randomUUID()}`;
 return [
  `From: ${address(from)}`,`To: ${address(to)}`,`Subject: ${header(subject)}`,`Date: ${date.toUTCString()}`,
  `Message-ID: ${messageId}`,'MIME-Version: 1.0',`Content-Type: multipart/mixed; boundary="${boundary}"`,'',
  `--${boundary}`,'Content-Type: text/plain; charset=utf-8','Content-Transfer-Encoding: base64','',wrap(b64(text)),
  `--${boundary}`,`Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,'Content-Transfer-Encoding: base64',
  `Content-Disposition: attachment; filename="${attachment.filename}"`,'',wrap(b64(attachment.content)),
  `--${boundary}--`,''
 ].join(CRLF);
}

// Resolves {messageId, smtpReply} after the server's 250 for DATA. A thrown error carries dataSent=true when the
// message body was already handed over: then delivery is uncertain and must be inspected, never retried blindly.
export async function sendMail({from,to,subject,text,attachment,host='127.0.0.1',port=Number(process.env.MAIL_SMTP_PORT||1025),timeoutMs=15000}){
 const messageId=`<${randomUUID()}@abnahme.local>`;
 const message=buildMessage({from,to,subject,text,attachment,messageId}).replace(/^\./gm,'..');
 return new Promise((resolve,reject)=>{
  const socket=connect({host,port});
  let buffer='',dataSent=false,waiting=null;
  const fail=error=>{socket.destroy();error.dataSent=dataSent;reject(error);};
  socket.setTimeout(timeoutMs,()=>fail(new Error('SMTP timeout')));
  socket.on('error',fail);
  socket.on('data',chunk=>{
   buffer+=chunk.toString('utf8');
   let end;
   while((end=buffer.indexOf(CRLF))>=0){
    const line=buffer.slice(0,end);buffer=buffer.slice(end+2);
    if(/^\d{3} /.test(line)||/^\d{3}$/.test(line)){const w=waiting;waiting=null;w?.(line);}
   }
  });
  const expect=(codes,command)=>new Promise(done=>{
   waiting=line=>codes.includes(line.slice(0,3))?done(line):fail(new Error(`SMTP ${command??'greeting'} refused: ${line}`));
   if(command!==undefined)socket.write(command+CRLF);
  });
  (async()=>{
   await expect(['220']);
   await expect(['250'],'EHLO abnahme.local');
   await expect(['250'],`MAIL FROM:<${address(from)}>`);
   await expect(['250','251'],`RCPT TO:<${address(to)}>`);
   await expect(['354'],'DATA');
   dataSent=true;
   const smtpReply=await expect(['250'],`${message}${CRLF}.`);
   socket.end(`QUIT${CRLF}`);
   resolve({messageId,smtpReply});
  })().catch(fail);
 });
}
