import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseFixed} from '../einvoice/parse-fixed.mjs';
import {buildXml} from '../einvoice/build.mjs';
import {parseTask,parseAmount,isSenden,invoiceNumberOf,createBuero,sha256,SEND_PRICE_DE,txTableDe} from './sokosumi.mjs';

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

test('LANE-A2-2: the customer tx table lists an x402 payment that never settled without hash or link',()=>{
 const table=txTableDe([tx,{label:'x402 inspection 1 (not charged, local KoSIT)',txHash:null,explorerUrl:null}]);
 assert.ok(table.includes(`| FundsLocked | \`${tx.txHash}\` | ${tx.explorerUrl} |`));
 assert.ok(table.includes('| x402 inspection 1 (not charged, local KoSIT) | – | – |'));
 assert.doesNotMatch(table,/undefined|null/);assert.equal(table.match(/cardanoscan/g).length,1);
});
test('invoice number is BT-1 of the real XRechnung build',()=>{assert.equal(invoiceNumberOf(xmlB),'AR-2026-0087')});

test('SENDEN is refused before payment unless a PRÜFEN Task accepted that invoice',async()=>{
 const refused=setup({status:'REFUSED'});
 assert.equal(refused.buero.sendenCheck('SENDEN AR-2026-0087').ok,false);
 const text=await refused.buero.pruefen({taskId:'t1',input:pruefenInput,onProgress:refused.onProgress});
 assert.match(text,/ABN-BT48/);assert.doesNotMatch(text,/keine Kosten/);assert.match(text,/Betreiber/);assert.doesNotMatch(text,/SENDEN AR/);
 assert.match(refused.buero.sendenCheck('SENDEN AR-2026-0087').reasonDe,/in PRÜFEN-Aufgabe t1 abgelehnt/,'LANE-A2-7: a refused invoice is called refused, not "not accepted"');
 await assert.rejects(refused.buero.senden('SENDEN AR-2026-0087',{id:'s1'}),/PRÜFEN/);assert.equal(refused.sent.length,0);

 const ok=setup();
 const protocol=await ok.buero.pruefen({taskId:'t2',input:pruefenInput,onProgress:ok.onProgress});ok.buero.confirm('t2');
 assert.match(protocol,/ABGENOMMEN \(bau-isar, 18400, true\)/);assert.ok(protocol.includes(SEND_PRICE_DE));
 assert.ok(protocol.includes(tx.explorerUrl));assert.ok(protocol.includes(sha256(xmlB)));
 assert.equal(ok.progress.length,2);
 assert.equal(ok.buero.sendenCheck('SENDEN AR-2026-0087').ok,true);
 assert.equal(ok.buero.sendenCheck('SENDEN AR-2026-9999').ok,false);
});

test('Doppelversand guard: the same invoice is e-mailed once; a second SENDEN fails before payment and after FundsLocked',async()=>{
 const {buero,sent}=setup();
 await buero.pruefen({taskId:'t1',input:pruefenInput});buero.confirm('t1');
 const result=await buero.senden('SENDEN AR-2026-0087',{id:'s1'});
 assert.equal(sent.length,1);assert.equal(sent[0].to,'eingangsrechnungen@bau-isar.example');
 assert.equal(sent[0].attachment.content,xmlB);
 for(const line of ['Message-ID: <m1@abnahme.local>','SMTP-Antwort: 250 2.0.0 Ok: queued as X',`XML sha256: ${sha256(xmlB)}`,'VOB/B § 16 Abs. 1 Nr. 3','20.11.2026'])assert.ok(result.includes(line),line);
 assert.match(buero.sendenCheck('SENDEN AR-2026-0087').reasonDe,/Doppelversand gesperrt.*bereits am .* versendet/u);
 await assert.rejects(buero.senden('SENDEN AR-2026-0087',{id:'s2'}),/Doppelversand/);
 await buero.pruefen({taskId:'t3',input:pruefenInput});buero.confirm('t3');  // re-accepting the same XML does not unlock a resend
 await assert.rejects(buero.senden('SENDEN AR-2026-0087',{id:'s3'}),/Doppelversand/);
 assert.equal(sent.length,1);
});

test('Doppelversand guard: an SMTP failure after DATA blocks any resend; a failure before DATA releases the reservation',async()=>{
 let calls=0;
 const uncertain=setup({send:async()=>{calls++;throw Object.assign(new Error('SMTP timeout'),{dataSent:true})}});
 await uncertain.buero.pruefen({taskId:'t1',input:pruefenInput});uncertain.buero.confirm('t1');
 await assert.rejects(uncertain.buero.senden('SENDEN AR-2026-0087',{id:'s1'}),/ungeklärt/);
 assert.match(uncertain.buero.sendenCheck('SENDEN AR-2026-0087').reasonDe,/ungeklärtem Ausgang/);
 await assert.rejects(uncertain.buero.senden('SENDEN AR-2026-0087',{id:'s2'}),/ungeklärtem Ausgang/);assert.equal(calls,1);

 let attempts=0;
 const refused=setup({send:async m=>{if(++attempts===1)throw Object.assign(new Error('connect ECONNREFUSED'),{dataSent:false});return {messageId:'<m@x>',smtpReply:'250 Ok'}}});
 await refused.buero.pruefen({taskId:'t1',input:pruefenInput});refused.buero.confirm('t1');
 await assert.rejects(refused.buero.senden('SENDEN AR-2026-0087',{id:'s1'}),/nichts versendet/);
 assert.match(await refused.buero.senden('SENDEN AR-2026-0087',{id:'s2'}),/Message-ID: <m@x>/);
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

// ---- Regression tests for the audit findings (QA-1, QA-2, QA-3, QA-7, QA-8, QA-9, QA-11, QA-12, QA-13, QA-16, EINVOICE-4, PENTEST-2).
const s1={id:'s1',userId:'u'},s2={id:'s2',userId:'u'};
function setup2({xmls=[xmlB],send,probe=async()=>true,now='2026-10-30T10:00:00Z'}={}){
 const dir=mkdtempSync(join(tmpdir(),'buero-'));const sent=[];let i=0;
 const runAbnahme=async()=>({status:'ACCEPTED',protocolDe:'Abnahme: ABGENOMMEN',xml:xmls[Math.min(i++,xmls.length-1)],kositReport:null,txs:[],purchaseId:null});
 const buero=createBuero({dir,runAbnahme,probe,now:()=>new Date(now),send:send??(async m=>{sent.push(m);return {messageId:m.messageId,smtpReply:'250 Ok'}})});
 const accept=async(taskId='p1',input=pruefenInput,userId='u')=>{await buero.pruefen({taskId,userId,input});buero.confirm(taskId);};
 return {buero,dir,sent,accept};
}
const fieldsOf=name=>parseFixed(fixture(name));
const xmlWith=async(name,patch)=>buildXml({...fieldsOf(name),...patch});

test('QA-1: the SENDEN gate reserves the invoice for one Task; a second Task is refused until the first releases it',async()=>{
 const {buero,sent,accept}=setup2();await accept();
 assert.equal(buero.sendenCheck('SENDEN AR-2026-0087',{taskId:'s1',userId:'u',reserve:true}).ok,true);
 assert.equal(buero.sendenCheck('SENDEN AR-2026-0087',{taskId:'s1',userId:'u',reserve:true}).ok,true);  // same Task again: idempotent
 assert.match(buero.sendenCheck('SENDEN AR-2026-0087',{taskId:'s2',userId:'u',reserve:true}).reasonDe,/läuft bereits der SENDEN-Auftrag s1/);
 await assert.rejects(buero.senden('SENDEN AR-2026-0087',s2),/läuft bereits/);assert.equal(sent.length,0);
 buero.release('s1');
 assert.equal(buero.sendenCheck('SENDEN AR-2026-0087',{taskId:'s2',userId:'u',reserve:true}).ok,true);
 assert.match(await buero.senden('SENDEN AR-2026-0087',s2),/Versendet/);assert.equal(sent.length,1);
 buero.release('s2');assert.match(buero.sendenCheck('SENDEN AR-2026-0087',{taskId:'s3',userId:'u'}).reasonDe,/bereits am/);  // release never frees a sent entry
});
test('QA-3: sendenGate refuses before payment when the mail server does not answer, and reserves nothing',async()=>{
 const down=setup2({probe:async()=>false});await down.accept();
 assert.match((await down.buero.sendenGate('SENDEN AR-2026-0087',s1)).reasonDe,/SMTP/);
 const up=setup2();await up.accept();
 assert.equal((await up.buero.sendenGate('SENDEN AR-2026-0087',s1)).ok,true);
 assert.match((await up.buero.sendenGate('SENDEN AR-2026-0087',s2)).reasonDe,/läuft bereits/);
 assert.equal((await down.buero.sendenGate('SENDEN AR-2026-0087',s2)).ok,false);
 down.buero.release('s1');assert.equal(down.buero.sendenCheck('SENDEN AR-2026-0087',{taskId:'s2',userId:'u',reserve:true}).ok,true);
});
test('QA-2: recover() tells a restarted paid SENDEN whether its mail went out',async()=>{
 const {buero,dir,accept}=setup2();await accept();
 assert.deepEqual(await buero.recover(s1),{retry:true});
 buero.sendenCheck('SENDEN AR-2026-0087',{taskId:'s1',userId:'u',reserve:true});
 assert.deepEqual(await buero.recover(s1),{retry:true});
 const text=await buero.senden('SENDEN AR-2026-0087',s1);
 assert.deepEqual(await buero.recover(s1),{result:text});
 const ledger=JSON.parse(readFileSync(`${dir}/sent-ledger.json`,'utf8'));
 assert.match(ledger.entries[0].messageId,/^<.+@abnahme\.local>$/);ledger.entries[0].status='sending';writeFileSync(`${dir}/sent-ledger.json`,JSON.stringify(ledger));
 assert.match((await buero.recover(s1)).error,/ungeklärtem Ausgang.*Postfach prüfen/su);
 assert.equal(JSON.parse(readFileSync(`${dir}/sent-ledger.json`,'utf8')).entries[0].status,'uncertain');
});
test('QA-2: the Message-ID is in the ledger before the message body is handed over',async()=>{
 let seen;const {buero,dir,accept}=setup2({send:async m=>{seen=JSON.parse(readFileSync(`${dir}/sent-ledger.json`,'utf8')).entries[0];return {messageId:m.messageId,smtpReply:'250 Ok'}}});
 await accept();const text=await buero.senden('SENDEN AR-2026-0087',s1);
 assert.equal(seen.status,'sending');assert.match(seen.messageId,/^<[0-9a-f-]+@abnahme\.local>$/);assert.ok(text.includes(`Message-ID: ${seen.messageId}`));
});
test('QA-7: control lines count only in the header block; body lines are neither used nor removed; duplicates are refused',()=>{
 const body=`Rechnung\nBetrag: 9.999,00\nEmpfänger: hv-giesing\nBetrag: siehe unten`;
 const job=parseTask(`PRÜFEN\nEmpfänger: bau-isar\nBetrag: 18.400,00\n${body}`);
 assert.equal(job.expectedTotal,18400);assert.equal(job.recipientProfileId,'bau-isar');assert.equal(job.invoiceText,body);
 assert.throws(()=>parseTask('PRÜFEN\nBetrag: 1,00\nBetrag: 2,00\nEmpfänger: bau-isar\nText'),/doppelt/);
 assert.throws(()=>parseTask('PRÜFEN\nEmpfänger: bau-isar\nEmpfänger: hv-giesing\nBetrag: 1,00\nText'),/doppelt/);
 assert.throws(()=>parseTask('PRÜFEN\nText\nEmpfänger: bau-isar\nBetrag: 1,00'),/Empfänger/);
});
test('QA-8: SENDEN needs a completed PRÜFEN by the same Sokosumi user; a later refusal withdraws the acceptance',async()=>{
 const {buero,dir}=setup2();
 await buero.pruefen({taskId:'p1',userId:'u',input:pruefenInput});
 assert.match(buero.sendenCheck('SENDEN AR-2026-0087',{userId:'u'}).reasonDe,/nicht abgeschlossen/);
 buero.confirm('p1');
 assert.equal(buero.sendenCheck('SENDEN AR-2026-0087',{userId:'u'}).ok,true);
 assert.match(buero.sendenCheck('SENDEN AR-2026-0087',{userId:'other'}).reasonDe,/anderen Sokosumi-Konto/);
 const refusing=createBuero({dir,runAbnahme:async()=>({status:'REFUSED',protocolDe:'Abnahme: ABGELEHNT',xml:xmlB,txs:[]})});
 await refusing.pruefen({taskId:'p2',userId:'u',input:pruefenInput});
 assert.match(buero.sendenCheck('SENDEN AR-2026-0087',{userId:'u'}).reasonDe,/zuletzt in PRÜFEN-Aufgabe p2 abgelehnt/);
});
test('QA-9: a description above 16,000 characters is refused in German, for PRÜFEN and SENDEN',()=>{
 assert.throws(()=>parseTask(pruefenInput+'x'.repeat(16000)),/zu lang.*16\.000/su);
 const {buero}=setup2();assert.match(buero.sendenCheck('SENDEN X'+'x'.repeat(16000)).reasonDe,/zu lang/);
});
test('QA-11: invoice numbers with spaces and & survive PRÜFEN -> SENDEN, unescaped in key, subject and filename',async()=>{
 for(const number of ['RE 2026 17','R&D-2026-1']){
  const {buero,sent,accept}=setup2({xmls:[await xmlWith('b-abschlag-13b-bau-isar.fixed.txt',{invoiceNumber:number})]});
  await accept();
  assert.match(await buero.senden(`SENDEN ${number}`,s1),/Versendet/);
  assert.equal(sent[0].subject,`XRechnung ${number}`);assert.equal(sent[0].attachment.filename,`${number}.xml`);
 }
});
test('QA-12/EINVOICE-10: the VOB/B Abschlag due date is printed only for Abschlag invoices and counts Berlin calendar days',async()=>{
 const xmlA=await buildXml(fieldsOf('a-reparatur-hv-giesing.fixed.txt'));
 const a=setup2({xmls:[xmlA]});await a.buero.pruefen({taskId:'p1',userId:'u',input:`PRÜFEN\nEmpfänger: hv-giesing\nBetrag: 527,17\nRechnung`});a.buero.confirm('p1');
 assert.doesNotMatch(await a.buero.senden('SENDEN 2026-0412',s1),/VOB\/B/);
 const b=setup2({now:'2026-10-04T22:30:00Z'});await b.accept();
 assert.match(await b.buero.senden('SENDEN AR-2026-0087',s1),/VOB\/B § 16 Abs\. 1 Nr\. 3.*am 26\.10\.2026/u);
});
test('QA-13: NFD umlauts, zero-width characters, lower-case senden and quoted SENDEN are understood; texts use German dates',async()=>{
 assert.equal(parseTask(`PRÜFEN\nEmpfänger: bau-isar​\nBetrag: 1,00\nText`).recipientProfileId,'bau-isar');
 for(const line of ['senden AR-2026-0087','„SENDEN AR-2026-0087“','"SENDEN AR-2026-0087"','SENDEN „AR-2026-0087“']){
  assert.equal(isSenden(line),true,line);assert.deepEqual(parseTask(line),{kind:'SENDEN',invoiceNumber:'AR-2026-0087'},line);
 }
 assert.throws(()=>parseTask('PRÜFEN\nEmpfänger: Bau-Isar\nBetrag: 1,00\nText'),/„Bau-Isar“/);
 const {buero,accept}=setup2();await accept();
 assert.match(buero.sendenCheck('SENDEN AR-2026-0087 bitte').reasonDe,/„AR-2026-0087 bitte“/);
 const text=await buero.senden('SENDEN AR-2026-0087',s1);
 assert.match(text,/Versandzeit: 30\.10\.2026, 11:00 Uhr/);assert.doesNotMatch(text,/\d{4}-\d\d-\d\dT/);
 const refusal=buero.sendenCheck('SENDEN AR-2026-0087',{userId:'u'}).reasonDe;assert.match(refusal,/am 30\.10\.2026, 11:00 Uhr/);assert.doesNotMatch(refusal,/\d{4}-\d\d-\d\dT/);
 assert.doesNotMatch(SEND_PRICE_DE,/^Senden: 1 tUSDM \(/);assert.match(SEND_PRICE_DE,/Credits/);
});
test('EINVOICE-4: the same supply under a new invoice number is refused before payment; an identical resend is a Doppelversand, not § 14c',async()=>{
 const xmlA=await buildXml(fieldsOf('a-reparatur-hv-giesing.fixed.txt')),xmlA1=await xmlWith('a-reparatur-hv-giesing.fixed.txt',{invoiceNumber:'2026-0412-1'});
 const {buero}=setup2({xmls:[xmlA,xmlA1]});const input='PRÜFEN\nEmpfänger: hv-giesing\nBetrag: 527,17\nRechnung';
 await buero.pruefen({taskId:'p1',userId:'u',input});buero.confirm('p1');
 const sentText=await buero.senden('SENDEN 2026-0412',s1);assert.match(sentText,/§ 14c UStG/);
 await buero.pruefen({taskId:'p2',userId:'u',input});buero.confirm('p2');
 const refusal=buero.sendenCheck('SENDEN 2026-0412-1',{taskId:'s2',userId:'u',reserve:true}).reasonDe;
 assert.match(refusal,/Dieselbe Leistung.*2026-0412.*§ 14c Abs\. 1 UStG/su);
 const again=buero.sendenCheck('SENDEN 2026-0412',{userId:'u'}).reasonDe;
 assert.match(again,/Doppelversand gesperrt/);assert.doesNotMatch(again,/14c/);
 const b=setup2();await b.accept();
 assert.doesNotMatch(await b.buero.senden('SENDEN AR-2026-0087',s1),/14c/);  // § 13b invoice, no VAT shown
});
test('QA-16: an uncertain send can be resolved by the operator; not-sent allows exactly one new SENDEN',async()=>{
 let calls=0;const {buero,accept}=setup2({send:async m=>{if(++calls===1)throw Object.assign(new Error('SMTP timeout'),{dataSent:true});return {messageId:m.messageId,smtpReply:'250 Ok'}}});
 await accept();
 await assert.rejects(buero.senden('SENDEN AR-2026-0087',s1),/ungeklärt/);
 assert.throws(()=>buero.resolve('AR-2026-9999','not-sent'),/Kein ungeklärter Versand/);
 buero.resolve('AR-2026-0087','not-sent');
 assert.match(await buero.senden('SENDEN AR-2026-0087',s2),/Versendet/);
 await assert.rejects(buero.senden('SENDEN AR-2026-0087',{id:'s3',userId:'u'}),/Doppelversand/);assert.equal(calls,2);
});
const ubl=body=>`<?xml version="1.0" encoding="UTF-8"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">${body}</Invoice>`;
test('PENTEST-2: invoiceNumberOf reads BT-1 with the strict XML reader and refuses control characters and quotes',()=>{
 assert.equal(invoiceNumberOf(ubl('<cbc:ID>R&amp;D-1</cbc:ID>')),'R&D-1');
 assert.equal(invoiceNumberOf(ubl('<!-- <cbc:ID>FAKE</cbc:ID> --><cbc:ID>AR-1</cbc:ID>')),'AR-1');
 assert.equal(invoiceNumberOf(ubl('<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent><cbc:ID>FAKE</cbc:ID></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions><cbc:ID>AR-1</cbc:ID>')),'AR-1');
 assert.equal(invoiceNumberOf(ubl('<cbc:ID><![CDATA[AR-1]]></cbc:ID>')),'AR-1');
 assert.throws(()=>invoiceNumberOf('<cbc:ID>AR-1</cbc:ID>'),/Rechnungsnummer/);
 for(const bad of ['AR"evil','AR&#13;&#10;Bcc: x@evil.example','x";filename*=UTF-8\'\'Zahlung.exe;x="','AR\\1'])
  assert.throws(()=>invoiceNumberOf(ubl(`<cbc:ID>${bad}</cbc:ID>`)),/Rechnungsnummer/,JSON.stringify(bad));
});

// ---- Fix round 3 (G1, STATEMACHINE-2, EINVOICE-10).
const refusedWith=txs=>createBuero({dir:mkdtempSync(join(tmpdir(),'buero-')),runAbnahme:async()=>({status:'REFUSED',protocolDe:'Abnahme: ABGELEHNT',xml:xmlB,txs,purchaseId:txs.length?'purchase-1':null})});
const txOf=label=>({label,txHash:'cd'.repeat(32),explorerUrl:'https://preprod.cardanoscan.io/transaction/x'});
test('G1 / LANE-A2-4: a REFUSED escrow protocol says where the refund stands; an authorized one is paid out automatically (MPS #1327 workaround)',async()=>{
 const authorized=await refusedWith([txOf('FundsLocked'),txOf('AuthorizeRefund')]).pruefen({taskId:'t',input:pruefenInput});
 assert.match(authorized,/Rückerstattung freigegeben.*sie wird automatisch ausgezahlt \(Workaround für Masumi #1327\)/su);assert.doesNotMatch(authorized,/Betreiber|keine Kosten/);
 const withdrawn=await refusedWith([txOf('FundsLocked'),txOf('AuthorizeRefund'),txOf('RefundWithdrawn')]).pruefen({taskId:'t',input:pruefenInput});
 assert.match(withdrawn,/Rückerstattung abgeschlossen/);assert.doesNotMatch(withdrawn,/Betreiber|keine Kosten/);
 const open=await refusedWith([txOf('FundsLocked'),txOf('Disputed')]).pruefen({taskId:'t',input:pruefenInput});
 assert.match(open,/noch nicht auf Cardano.*Betreiber/su);assert.doesNotMatch(open,/freigegeben|keine Kosten/);
 assert.match(await refusedWith([]).pruefen({taskId:'t',input:pruefenInput}),/keine Kosten/);  // local check: no escrow, nothing paid
});
test('STATEMACHINE-2: after an ACCEPTED run (an old journal with a BT-1 the Büro cannot send, or no XML) pruefen answers, never throws',async()=>{
 const bad=await xmlWith('b-abschlag-13b-bau-isar.fixed.txt',{invoiceNumber:'AR:2026:0087'});
 for(const xml of [bad,null]){
  const buero=createBuero({dir:mkdtempSync(join(tmpdir(),'buero-')),runAbnahme:async()=>({status:'ACCEPTED',protocolDe:'Abnahme: ABGENOMMEN',xml,txs:[tx],purchaseId:'purchase-1'})});
  const text=await buero.pruefen({taskId:'t',userId:'u',input:pruefenInput});
  assert.match(text,/ABGENOMMEN/);assert.match(text,/nicht versendbar/);assert.match(text,/Escrow bezahlt den RechnungsMeister/);assert.doesNotMatch(text,/Auftrag dafür: „SENDEN/);
  buero.confirm('t');assert.equal(buero.sendenCheck('SENDEN AR:2026:0087',{userId:'u'}).ok,false);
 }
});
test('EINVOICE-10: the VOB/B due date moves past weekends and Bavarian public holidays (§ 193 BGB)',async()=>{
 for(const [now,due] of [['2026-10-31T09:00:00Z','23.11.2026'],['2026-12-04T09:00:00Z','28.12.2026'],['2026-12-16T09:00:00Z','07.01.2027'],['2027-03-05T09:00:00Z','30.03.2027'],['2027-05-06T09:00:00Z','28.05.2027']]){
  const b=setup2({now});await b.accept();
  assert.match(await b.buero.senden('SENDEN AR-2026-0087',s1),new RegExp(`VOB/B § 16 Abs\\. 1 Nr\\. 3.*am ${due.replaceAll('.','\\.')}.*§ 193 BGB`,'u'),now);
 }
});
test('EINVOICE-10: the e-mail says the buyer\'s agent accepted the e-invoice, not that anyone accepted the construction work',async()=>{
 const {buero,sent,accept}=setup2();await accept();await buero.senden('SENDEN AR-2026-0087',s1);
 assert.match(sent[0].text,/e-invoice accepted by the buyer's agent/i);assert.match(sent[0].text,/not the construction work/);assert.doesNotMatch(sent[0].text,/geprüft und abgenommen/);
});

test('LANE-A2-7: SENDEN for an invoice refused in its first PRÜFEN says it was refused; a later acceptance unlocks it',async()=>{
 const b=setup({status:'REFUSED'});
 await b.buero.pruefen({taskId:'t1',userId:'u',input:pruefenInput});
 const check=b.buero.sendenCheck('SENDEN AR-2026-0087',{userId:'u'});
 assert.equal(check.ok,false);assert.match(check.reasonDe,/^Rechnung AR-2026-0087 wurde zuletzt in PRÜFEN-Aufgabe t1 abgelehnt\. Bitte die Mängel beheben/);
 const ok=createBuero({dir:b.dir,runAbnahme:async()=>({status:'ACCEPTED',protocolDe:'Abnahme: ABGENOMMEN',xml:xmlB,txs:[tx],purchaseId:'purchase-2'})});
 await ok.pruefen({taskId:'t2',userId:'u',input:pruefenInput});ok.confirm('t2');
 assert.equal(ok.sendenCheck('SENDEN AR-2026-0087',{userId:'u'}).ok,true);
});
