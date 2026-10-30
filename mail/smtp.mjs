// Minimal SMTP client (node:net, no dependency) for the local Mailpit inbox. Plain SMTP, no TLS, no AUTH:
// it only talks to 127.0.0.1. One message per connection: EHLO, MAIL, RCPT, DATA, QUIT.
import {connect} from 'node:net';
import {randomUUID} from 'node:crypto';

const CRLF='\r\n';
const b64=text=>Buffer.from(text,'utf8').toString('base64');
const wrap=text=>text.replace(/.{1,76}/g,'$&'+CRLF);
const header=text=>/^[\x20-\x7e]*$/.test(text)?text:`=?UTF-8?B?${b64(text)}?=`;
const address=text=>{if(!/^[^\s<>@]+@[^\s<>@]+$/.test(text))throw new Error(`Invalid e-mail address: ${text}`);return text;};
// MIME parameter (RFC 2045 quoted-string, RFC 2231 for non-ASCII). CR/LF would start a new header line: refused.
const param=(key,value)=>{
 if(/[\x00-\x1f\x7f]/.test(value))throw new Error(`Invalid MIME parameter ${key}: control character`);
 return /^[\x20-\x7e]*$/.test(value)?`${key}="${value.replace(/["\\]/g,'\\$&')}"`:`${key}*=UTF-8''${encodeURIComponent(value).replace(/['()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
};
const mediaType=text=>{if(!/^[\w.+-]+\/[\w.+-]+$/.test(text))throw new Error(`Invalid MIME type: ${text}`);return text;};

export function buildMessage({from,to,subject,text,attachment,messageId,date=new Date()}){
 const boundary=`abnahme-${randomUUID()}`;
 return [
  `From: ${address(from)}`,`To: ${address(to)}`,`Subject: ${header(subject)}`,`Date: ${date.toUTCString()}`,
  `Message-ID: ${messageId}`,'MIME-Version: 1.0',`Content-Type: multipart/mixed; boundary="${boundary}"`,'',
  `--${boundary}`,'Content-Type: text/plain; charset=utf-8','Content-Transfer-Encoding: base64','',wrap(b64(text)),
  `--${boundary}`,`Content-Type: ${mediaType(attachment.contentType)}; ${param('name',attachment.filename)}`,'Content-Transfer-Encoding: base64',
  `Content-Disposition: attachment; ${param('filename',attachment.filename)}`,'',wrap(b64(attachment.content)),
  `--${boundary}--`,''
 ].join(CRLF);
}

// Resolves {messageId, smtpReply} after the server's 250 for DATA. A thrown error carries dataSent=true when the
// message body was already handed over: then delivery is uncertain and must be inspected, never retried blindly.
// The caller may choose the Message-ID, so it can be journaled before DATA and searched for in the inbox.
export async function sendMail({from,to,subject,text,attachment,messageId=`<${randomUUID()}@abnahme.local>`,host='127.0.0.1',port=Number(process.env.MAIL_SMTP_PORT||1025),timeoutMs=15000}){
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
  // Any reply is definitive, also after DATA (RFC 5321 4.2.5: a refused message was not taken): dataSent stays true only
  // when no reply comes (timeout, lost connection). The error names the step, never the message itself (DELTA-WORKER-5).
  const expect=(codes,command,label=command)=>new Promise(done=>{
   waiting=line=>{if(codes.includes(line.slice(0,3)))return done(line);dataSent=false;fail(new Error(`SMTP ${label??'greeting'} refused: ${line}`));};
   if(command!==undefined)socket.write(command+CRLF);
  });
  (async()=>{
   await expect(['220']);
   await expect(['250'],'EHLO abnahme.local');
   await expect(['250'],`MAIL FROM:<${address(from)}>`);
   await expect(['250','251'],`RCPT TO:<${address(to)}>`);
   await expect(['354'],'DATA');
   dataSent=true;
   const smtpReply=await expect(['250'],`${message}${CRLF}.`,'message');
   socket.end(`QUIT${CRLF}`);
   resolve({messageId,smtpReply});
  })().catch(fail);
 });
}

// Greeting + EHLO + QUIT, no message: true when the server would take mail right now. Used before a paid SENDEN.
export function probeSmtp({host='127.0.0.1',port=Number(process.env.MAIL_SMTP_PORT||1025),timeoutMs=3000}={}){
 return new Promise(resolve=>{
  const socket=connect({host,port});
  let buffer='',greeted=false;
  const done=ok=>{socket.setTimeout(0);if(ok)socket.end(`QUIT${CRLF}`);else socket.destroy();resolve(ok);};
  socket.setTimeout(timeoutMs,()=>done(false));
  socket.on('error',()=>done(false));
  socket.on('data',chunk=>{
   buffer+=chunk.toString('utf8');
   let end;
   while((end=buffer.indexOf(CRLF))>=0){
    const line=buffer.slice(0,end);buffer=buffer.slice(end+2);
    if(!/^\d{3}( |$)/.test(line))continue;
    if(!greeted){if(!line.startsWith('220'))return done(false);greeted=true;socket.write(`EHLO abnahme.local${CRLF}`);}
    else return done(line.startsWith('250'));
   }
  });
 });
}
