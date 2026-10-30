// Operator step for a SENDEN whose outcome the send ledger (.local/sent-ledger.json) cannot tell (QA-16): an entry left
// "sending" or "uncertain" by an interrupted SMTP hand-off, or a reservation whose Task closed without the worker.
// First search the AP inbox (Mailpit, http://127.0.0.1:8025) for the Message-ID the Task's FAILED text names. Then,
// from the repo root, with the worker stopped (the CLI takes the worker lock, so it never writes the ledger beside it):
//   node buero/resolve.mjs <Rechnungsnummer> sent       # the mail is in the inbox: the number stays locked
//   node buero/resolve.mjs <Rechnungsnummer> not-sent   # it is not: the number is free for one new SENDEN
// Exit 0 done, 1 refused (worker running, nothing to resolve), 2 usage.
import {acquireWorkerLock} from '../worker-lock.mjs';
import {createBuero} from './sokosumi.mjs';

const [invoiceNumber,result,extra]=process.argv.slice(2);
if(!invoiceNumber||!['sent','not-sent'].includes(result)||extra!==undefined){
 console.error('Usage: node buero/resolve.mjs <Rechnungsnummer> sent|not-sent');
 process.exit(2);
}
let release;
try{release=acquireWorkerLock();}catch(e){console.error(`${e.message}. Stop the worker first (one SIGTERM, it finishes its pass), then run this again.`);process.exit(1);}
try{
 const e=createBuero({}).resolve(invoiceNumber,result);
 console.log(`Rechnung ${invoiceNumber} (SENDEN-Auftrag ${e.taskId}, Message-ID ${e.messageId??'keine'}): ${result==='sent'?'als versendet eingetragen, die Nummer bleibt gesperrt':'freigegeben für ein neues SENDEN'}.`);
}catch(e){console.error(e.message);process.exitCode=1;}
finally{release();}
