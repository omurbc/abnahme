import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseFixed} from '../einvoice/parse-fixed.mjs';
import {buildXml} from '../einvoice/build.mjs';
import {parseTask,parseAmount,isSenden,invoiceNumberOf,createBuero,sha256,SEND_PRICE_DE} from './sokosumi.mjs';

const fixture=name=>readFileSync(new URL(`../fixtures/${name}`,import.meta.url),'utf8');
const xmlB=await buildXml(parseFixed(fixture('b-abschlag-13b-bau-isar.fixed.txt')));
const pruefenInput=`PRÜFEN\nEmpfänger: bau-isar\nBetrag: 18.400,00 €\n${fixture('b-abschlag-13b-bau-isar.txt')}`;
const tx={label:'FundsLocked',txHash:'ab'.repeat(32),explorerUrl:`https://preprod.cardanoscan.io/transaction/${'ab'.repeat(32)}`};
function setup({status='ACCEPTED',send}={}){
 const dir=mkdtempSync(join(tmpdir(),'buero-'));const sent=[],progress=[];
 const runAbnahme=async({invoiceText,recipientProfileId,expectedTotal,onProgress})=>{
  await onProgress('KoSIT: HTTP 200');
  return {status,protocolDe:status==='REFUSED'?'Abnahme: ABGELEHNT\nMängel:\n - [ABN-BT48] fehlt':`Abnahme: ABGENOMMEN (${recipientProfileId}, ${expectedTotal}, ${invoiceText.length>100})`,
   xml:status==='FAILED'?null:xmlB,kositReport:'<report/>',txs:[tx],purchaseId:'purchase-1'};
 };
 const buero=createBuero({dir,runAbnahme,send:send??(async m=>{sent.push(m);return {messageId:`<m${sent.length}@abnahme.local>`,smtpReply:'250 2.0.0 Ok: queued as X'}}),now:()=>new Date('2026-10-30T10:00:00Z')});
 return {buero,dir,sent,progress,onProgress:async text=>{progress.push(text)}};
}

test('routing: PRÜFEN parses profile and German total, SENDEN takes the paid route, anything else is unknown',()=>{
 const job=parseTask(pruefenInput);
 assert.equal(job.kind,'PRUEFEN');assert.equal(job.recipientProfileId,'bau-isar');assert.equal(job.expectedTotal,18400);
 assert.doesNotMatch(job.invoiceText,/^(PRÜFEN|Empfänger:|Betrag:)/mu);assert.match(job.invoiceText,/AR-2026-0087/);
 assert.equal(parseTask('PRUEFEN\nEmpfaenger: hv-giesing\nBetrag: 527.17\nText').expectedTotal,527.17);
 assert.deepEqual(parseTask('SENDEN AR-2026-0087'),{kind:'SENDEN',invoiceNumber:'AR-2026-0087'});
 assert.equal(isSenden('SENDEN AR-2026-0087'),true);assert.equal(isSenden(pruefenInput),false);
 assert.equal(parseTask('Suggest names for our team').kind,'UNKNOWN');
 assert.equal(parseAmount('18400'),18400);assert.equal(parseAmount('18.400'),18400);
 assert.throws(()=>parseTask('PRÜFEN\nEmpfänger: gu-sendling\nBetrag: 1,00\nText'),/Empfängerprofil/);
 assert.throws(()=>parseTask('PRÜFEN\nEmpfänger: bau-isar\nText'),/Betrag/);
 assert.throws(()=>parseAmount('abc'),/kein gültiger/);
});

test('invoice number is BT-1 of the real XRechnung build',()=>{assert.equal(invoiceNumberOf(xmlB),'AR-2026-0087')});

test('SENDEN is refused before payment unless a PRÜFEN Task accepted that invoice',async()=>{
 const refused=setup({status:'REFUSED'});
 assert.equal(refused.buero.sendenCheck('SENDEN AR-2026-0087').ok,false);
 const text=await refused.buero.pruefen({taskId:'t1',input:pruefenInput,onProgress:refused.onProgress});
 assert.match(text,/ABN-BT48/);assert.match(text,/keine Kosten/);assert.doesNotMatch(text,/SENDEN AR/);
 assert.match(refused.buero.sendenCheck('SENDEN AR-2026-0087').reasonDe,/nicht in einer PRÜFEN-Aufgabe abgenommen/);
 await assert.rejects(refused.buero.senden('SENDEN AR-2026-0087'),/PRÜFEN/);assert.equal(refused.sent.length,0);

 const ok=setup();
 const protocol=await ok.buero.pruefen({taskId:'t2',input:pruefenInput,onProgress:ok.onProgress});
 assert.match(protocol,/ABGENOMMEN \(bau-isar, 18400, true\)/);assert.ok(protocol.includes(SEND_PRICE_DE));
 assert.ok(protocol.includes(tx.explorerUrl));assert.ok(protocol.includes(sha256(xmlB)));
 assert.equal(ok.progress.length,2);
 assert.equal(ok.buero.sendenCheck('SENDEN AR-2026-0087').ok,true);
 assert.equal(ok.buero.sendenCheck('SENDEN AR-2026-9999').ok,false);
});

test('§ 14c guard: the same invoice is e-mailed once; a second SENDEN fails before payment and after FundsLocked',async()=>{
 const {buero,sent}=setup();
 await buero.pruefen({taskId:'t1',input:pruefenInput});
 const result=await buero.senden('SENDEN AR-2026-0087');
 assert.equal(sent.length,1);assert.equal(sent[0].to,'eingangsrechnungen@bau-isar.example');
 assert.equal(sent[0].attachment.content,xmlB);
 for(const line of ['Message-ID: <m1@abnahme.local>','SMTP-Antwort: 250 2.0.0 Ok: queued as X',`XML sha256: ${sha256(xmlB)}`,'VOB/B § 16 Abs. 1 Nr. 3','20.11.2026'])assert.ok(result.includes(line),line);
 assert.match(buero.sendenCheck('SENDEN AR-2026-0087').reasonDe,/14c.*bereits am .* versendet/u);
 await assert.rejects(buero.senden('SENDEN AR-2026-0087'),/14c/);
 await buero.pruefen({taskId:'t3',input:pruefenInput});  // re-accepting the same XML does not unlock a resend
 await assert.rejects(buero.senden('SENDEN AR-2026-0087'),/14c/);
 assert.equal(sent.length,1);
});

test('§ 14c guard: an SMTP failure after DATA blocks any resend; a failure before DATA releases the reservation',async()=>{
 let calls=0;
 const uncertain=setup({send:async()=>{calls++;throw Object.assign(new Error('SMTP timeout'),{dataSent:true})}});
 await uncertain.buero.pruefen({taskId:'t1',input:pruefenInput});
 await assert.rejects(uncertain.buero.senden('SENDEN AR-2026-0087'),/ungeklärt/);
 assert.match(uncertain.buero.sendenCheck('SENDEN AR-2026-0087').reasonDe,/ungeklärtem Ausgang/);
 await assert.rejects(uncertain.buero.senden('SENDEN AR-2026-0087'),/14c/);assert.equal(calls,1);

 let attempts=0;
 const refused=setup({send:async m=>{if(++attempts===1)throw Object.assign(new Error('connect ECONNREFUSED'),{dataSent:false});return {messageId:'<m@x>',smtpReply:'250 Ok'}}});
 await refused.buero.pruefen({taskId:'t1',input:pruefenInput});
 await assert.rejects(refused.buero.senden('SENDEN AR-2026-0087'),/nichts versendet/);
 assert.match(await refused.buero.senden('SENDEN AR-2026-0087'),/Message-ID: <m@x>/);
});

test('PRÜFEN throws on FAILED, unknown or SENDEN input so the worker takes its gate-failed path',async()=>{
 const {buero}=setup({status:'FAILED'});
 await assert.rejects(buero.pruefen({taskId:'t',input:pruefenInput}),/Prüfung fehlgeschlagen/);
 await assert.rejects(buero.pruefen({taskId:'t',input:'Suggest names'}),/Unbekannter Auftrag/);
 await assert.rejects(buero.pruefen({taskId:'t',input:'SENDEN AR-2026-0087'}),/bezahlten Ablauf/);
 assert.equal(buero.sendenCheck('SENDEN AR-2026-0087').ok,false);
});

test('a failing progress comment does not abort the check',async()=>{
 const {buero}=setup();
 assert.match(await buero.pruefen({taskId:'t',input:pruefenInput,onProgress:async()=>{throw new Error('HTTP 503')}}),/ABGENOMMEN/);
});
