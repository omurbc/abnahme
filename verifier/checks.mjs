import {textDe} from './messages-de.mjs';
import {parseXml} from './xml.mjs';

// Semantic acceptance checks on the delivered XRechnung-UBL XML against the acceptance profile and the
// recipient profile (Empfängerprofil). The delivery is untrusted: facts are read with a real XML parser by exact
// namespace path from the Invoice root, so comments, CDATA, other prefixes or copies inside UBL extensions cannot show
// the checks other values than KoSIT and the recipient's ERP read.
const NS={cac:'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',cbc:'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2'};
const INVOICE_NS='urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';
const select=(el,path)=>path.split('/').reduce((set,step)=>{const [p,name]=step.split(':');return set.flatMap(e=>e.children.filter(c=>c.ns===NS[p]&&c.name===name));},[el]);
const one=(el,path)=>{const found=select(el,path);return found.length===1?found[0].text.trim():null;};
const norm=s=>s==null?null:s.replace(/\s+/g,'').toUpperCase();
const cents=n=>Math.round(Number(n)*100);
// Half-up (kaufmännisch) VAT in cents for a taxable amount in cents and a rate in percent; integers only.
const vatCents=(taxableCents,percent)=>{const x=taxableCents*Math.round(Number(percent)*100);return Math.sign(x)*Math.floor((Math.abs(x)+5000)/10000);};
const RC_WORDING='Steuerschuldnerschaft des Leistungsempfängers';
const plain=s=>s.normalize('NFC').replace(/\s+/g,' ').trim();
const berlinToday=()=>new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Berlin'});
const descendants=root=>{const all=[],todo=[root];while(todo.length){const e=todo.pop();all.push(e);for(const c of e.children)todo.push(c);}return all;};
const euro=n=>Number(n).toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2})+' €';

// Throws (German message) when the XML is not a well-formed UBL Invoice this reader can read safely.
export function invoiceFacts(xml){
 const doc=parseXml(xml);
 if(doc.ns!==INVOICE_NS||doc.name!=='Invoice')throw new Error('das Dokument ist keine UBL-Rechnung (Invoice)');
 const vatIds=party=>select(doc,`${party}/cac:Party/cac:PartyTaxScheme`).filter(t=>one(t,'cac:TaxScheme/cbc:ID')==='VAT').map(t=>norm(one(t,'cbc:CompanyID')));
 return {
  invoiceNumber:one(doc,'cbc:ID'),
  payableAmount:one(doc,'cac:LegalMonetaryTotal/cbc:PayableAmount'),
  sellerVatIds:vatIds('cac:AccountingSupplierParty'),
  buyerVatIds:vatIds('cac:AccountingCustomerParty'),
  ibans:select(doc,'cac:PaymentMeans/cac:PayeeFinancialAccount').map(a=>norm(one(a,'cbc:ID'))),
  lineCategories:select(doc,'cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory').map(c=>one(c,'cbc:ID')),
  breakdownCategories:select(doc,'cac:TaxTotal/cac:TaxSubtotal').map(t=>one(t,'cac:TaxCategory/cbc:ID')),
  buyerReference:one(doc,'cbc:BuyerReference'),
  buyerName:one(doc,'cac:AccountingCustomerParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName'),
  buyerPostcode:one(doc,'cac:AccountingCustomerParty/cac:Party/cac:PostalAddress/cbc:PostalZone'),
  issueDate:one(doc,'cbc:IssueDate'),
  dueDate:one(doc,'cbc:DueDate'),
  invoiceType:one(doc,'cbc:InvoiceTypeCode'),
  currency:one(doc,'cbc:DocumentCurrencyCode'),
  taxCurrency:one(doc,'cbc:TaxCurrencyCode'),
  currencyIds:descendants(doc).filter(e=>e.attrs.has('currencyID')).map(e=>e.attrs.get('currencyID')),
  notes:select(doc,'cbc:Note').map(n=>n.text),
  taxSubtotals:select(doc,'cac:TaxTotal/cac:TaxSubtotal').map(t=>({category:one(t,'cac:TaxCategory/cbc:ID'),percent:one(t,'cac:TaxCategory/cbc:Percent'),taxable:one(t,'cbc:TaxableAmount'),tax:one(t,'cbc:TaxAmount'),reason:one(t,'cac:TaxCategory/cbc:TaxExemptionReason')})),
  lineTaxCategories:select(doc,'cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory').map(c=>({category:one(c,'cbc:ID'),percent:one(c,'cbc:Percent')})),
  allowanceChargeTaxCategories:select(doc,'cac:AllowanceCharge/cac:TaxCategory').map(c=>({category:one(c,'cbc:ID'),percent:one(c,'cbc:Percent')})),
  taxInclusiveAmount:one(doc,'cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount'),
  prepaidAmounts:select(doc,'cac:LegalMonetaryTotal/cbc:PrepaidAmount').map(e=>e.text.trim()),
 };
}
// A rate as written in the XML ("19", "19.00"); anything else is no rate.
const rate=s=>s!=null&&/^\d+(?:\.\d+)?$/.test(s)?Number(s):NaN;

const SEMANTIC={
 'payable-amount':(f,{expectedTotal})=>{
  if(expectedTotal==null)return [{code:'ABN-BETRAG',textDe:'Es liegt kein erwarteter Rechnungsbetrag vor; der Zahlbetrag (BT-115) kann nicht abgenommen werden.'}];
  if(f.payableAmount==null)return [{code:'ABN-BETRAG',textDe:'Der Zahlbetrag (BT-115) fehlt.'}];
  return cents(f.payableAmount)===cents(expectedTotal)?[]:[{code:'ABN-BETRAG',textDe:`Der Zahlbetrag (BT-115) ist ${euro(f.payableAmount)}, erwartet waren ${euro(expectedTotal)}.`}];
 },
 // The job has no input for a prepayment, so none is declared: BT-115 must be the whole invoice total (BT-112). Otherwise
 // inflated lines plus a fake prepayment keep BT-115 at the expected total (DELTA-VERIFIER-1).
 'prepaid-amount':f=>{
  const prepaid=f.prepaidAmounts.filter(a=>cents(a)!==0);
  if(prepaid.length)return [{code:'ABN-VORAUSZAHLUNG',textDe:`Die Rechnung zieht eine Vorauszahlung von ${prepaid.map(euro).join(', ')} ab (BT-113); der Auftrag nennt keine Vorauszahlung.`}];
  return f.taxInclusiveAmount!=null&&cents(f.taxInclusiveAmount)===cents(f.payableAmount)?[]:[{code:'ABN-VORAUSZAHLUNG',textDe:`Der Gesamtbetrag einschließlich Umsatzsteuer (BT-112) ist ${f.taxInclusiveAmount==null?'nicht eindeutig angegeben':euro(f.taxInclusiveAmount)}, der Zahlbetrag (BT-115) ${euro(f.payableAmount)}; Abzüge oder Rundungsbeträge (BT-113, BT-114) sind nicht vereinbart.`}];
 },
 'seller-vat-id':(f,{recipient})=>{
  if(!f.sellerVatIds.length)return [{code:'ABN-USTID',textDe:'Die USt-IdNr. des Verkäufers (BT-31) fehlt.'}];
  return recipient.kreditoren.some(k=>f.sellerVatIds.includes(norm(k.vatId)))?[]:[{code:'ABN-USTID',textDe:`Die USt-IdNr. des Verkäufers ${f.sellerVatIds.join(', ')} steht nicht in den Kreditorenstammdaten von ${recipient.name}.`}];
 },
 'seller-iban':(f,{recipient})=>{
  const kreditor=recipient.kreditoren.find(k=>f.sellerVatIds.includes(norm(k.vatId)));
  if(!kreditor)return [{code:'ABN-IBAN',textDe:'Die IBAN kann nicht geprüft werden, weil der Verkäufer nicht in den Kreditorenstammdaten steht.'}];
  if(!f.ibans.length)return [{code:'ABN-IBAN',textDe:'Die IBAN des Zahlungsempfängers (BT-84) fehlt.'}];
  const wrong=f.ibans.filter(i=>i!==norm(kreditor.iban));
  return wrong.length?[{code:'ABN-IBAN',textDe:`Die IBAN ${wrong.join(', ')} weicht von der hinterlegten IBAN ${kreditor.iban} für ${kreditor.name} ab.`}]:[];
 },
 'reverse-charge':(f,{recipient})=>{
  const categories=[...f.lineCategories,...f.breakdownCategories];
  if(!recipient.reverseCharge13b)return categories.includes('AE')?[{code:'ABN-13B',textDe:`${recipient.name} ist kein Leistungsempfänger nach § 13b UStG; die Rechnung darf keine Kategorie AE enthalten.`}]:[];
  const failures=[];
  if(!categories.length||categories.some(c=>c!=='AE'))failures.push({code:'ABN-13B',textDe:`Für ${recipient.name} gilt § 13b UStG: alle Positionen und die Steueraufschlüsselung müssen Kategorie AE haben (gefunden: ${[...new Set(categories)].join(', ')||'keine'}).`});
  if(!f.buyerVatIds.includes(norm(recipient.vatId)))failures.push({code:'ABN-BT48',textDe:f.buyerVatIds.length?`Die USt-IdNr. des Käufers (BT-48) ist ${f.buyerVatIds.join(', ')}, erwartet ${recipient.vatId}.`:`Die USt-IdNr. des Käufers (BT-48) fehlt; bei § 13b muss ${recipient.vatId} angegeben sein.`});
  return failures;
 },
 // The recipient profile pins the one VAT category and rate its invoices carry (vat): an exempt or 7 % invoice with the
 // expected BT-115 is no invoice the recipient ordered (DELTA-VERIFIER-1).
 'vat-rate':(f,{recipient})=>{
  const {category,percent}=recipient.vat;
  const found=[...f.lineTaxCategories,...f.taxSubtotals,...f.allowanceChargeTaxCategories];
  const wrong=found.filter(t=>t.category!==category||rate(t.percent)!==percent);
  if(found.length&&!wrong.length)return [];
  return [{code:'ABN-STEUERSATZ',textDe:`Für ${recipient.name} gilt Kategorie ${category} mit ${percent} % (Empfängerprofil); die Rechnung enthält ${[...new Set(wrong.map(t=>`${t.category??'ohne Kategorie'} ${t.percent??'ohne Satz'} %`))].join(', ')||'keine Steuerkategorie'} (BT-151/BT-152, BT-118/BT-119).`}];
 },
 'buyer-reference':(f,{recipient})=>{
  if(!f.buyerReference)return [{code:'ABN-BT10',textDe:`Die Käuferreferenz (BT-10) fehlt; ${recipient.name} erwartet ${recipient.buyerReferenceHinweis}.`}];
  return new RegExp(recipient.buyerReferencePattern).test(f.buyerReference)?[]:[{code:'ABN-BT10',textDe:`Die Käuferreferenz (BT-10) „${f.buyerReference}“ passt nicht zum Muster von ${recipient.name} (${recipient.buyerReferenceHinweis}).`}];
 },
 'buyer-identity':(f,{recipient})=>{
  const sameName=f.buyerName!=null&&plain(f.buyerName).toLocaleLowerCase('de')===plain(recipient.name).toLocaleLowerCase('de');
  return sameName&&f.buyerPostcode===recipient.postcode?[]:[{code:'ABN-KAEUFER',textDe:`Käufer laut Rechnung ist ${f.buyerName??'nicht angegeben'}, ${f.buyerPostcode??'ohne Postleitzahl'} (BT-44, BT-53); das Empfängerprofil gilt für ${recipient.name}, ${recipient.postcode}.`}];
 },
 'dates':(f,{today})=>{
  const issued=f.issueDate?.slice(0,10),due=f.dueDate?.slice(0,10);
  if(!issued)return [{code:'ABN-DATUM',textDe:'Das Rechnungsdatum (BT-2) fehlt.'}];
  const failures=[];
  if(issued>today)failures.push({code:'ABN-DATUM',textDe:`Das Rechnungsdatum (BT-2) ${issued} liegt in der Zukunft (heute ist ${today}).`});
  if(due&&due<issued)failures.push({code:'ABN-DATUM',textDe:`Das Fälligkeitsdatum (BT-9) ${due} liegt vor dem Rechnungsdatum (BT-2) ${issued}.`});
  return failures;
 },
 'currency':(f,{check})=>{
  const found=[...new Set([f.currency,f.taxCurrency,...f.currencyIds].filter(c=>c!=null))];
  return f.currency===check.currency&&found.every(c=>c===check.currency)?[]:[{code:'ABN-WAEHRUNG',textDe:`Die Rechnung enthält Beträge in ${found.join(', ')||'unbekannter Währung'}; abgenommen werden nur Beträge in ${check.currency} (BT-5, currencyID).`}];
 },
 'invoice-type':(f,{check})=>check.codes.includes(f.invoiceType)?[]:[{code:'ABN-RECHNUNGSART',textDe:`Die Rechnungsart (BT-3) ist ${f.invoiceType??'nicht angegeben'}; abgenommen werden nur ${check.codes.join(', ')} (Rechnung, Abschlagsrechnung Bau).`}],
 // Exact statements only (check.statements, compared after NFC and whitespace normalisation): a substring test also
 // passed "Keine Steuerschuldnerschaft des Leistungsempfängers" (DELTA-VERIFIER-4). Every BT-22/BT-120 text that speaks of
 // Steuerschuldnerschaft must be one of the statements; other free text is not interpreted.
 'reverse-charge-wording':(f,{check})=>{
  if(![...f.lineCategories,...f.breakdownCategories].includes('AE'))return [];
  const texts=[...f.notes,...f.taxSubtotals.filter(t=>t.category==='AE').map(t=>t.reason)].filter(Boolean).map(plain);
  const foreign=texts.filter(t=>/steuerschuldnerschaft/i.test(t)&&!check.statements.includes(t));
  if(foreign.length)return [{code:'ABN-13B-HINWEIS',textDe:`Der Hinweis „${foreign[0].slice(0,200)}“ (BT-22 oder BT-120) ist keine der Angaben nach § 14a Abs. 5 UStG; zulässig ist wörtlich ${check.statements.map(s=>`„${s}“`).join(' oder ')}.`}];
  return texts.some(t=>check.statements.includes(t))?[]:[{code:'ABN-13B-HINWEIS',textDe:`Bei Steuerschuldnerschaft des Leistungsempfängers muss die Rechnung die Angabe „${RC_WORDING}“ enthalten (§ 14a Abs. 5 UStG; BT-120 oder BT-22).`}];
 },
 'vat-arithmetic':f=>f.taxSubtotals.flatMap(t=>{
  const percent=t.percent??'0',expected=vatCents(cents(t.taxable),percent);
  if(t.taxable==null||t.tax==null||!Number.isFinite(expected))return [{code:'ABN-UST',textDe:`Die Steueraufschlüsselung der Kategorie ${t.category} ist unvollständig (BT-116, BT-117, BT-119).`}];
  return cents(t.tax)===expected?[]:[{code:'ABN-UST',textDe:`Der Steuerbetrag der Kategorie ${t.category} ${percent} % (BT-117) ist ${euro(t.tax)}, richtig wären ${euro(expected/100)} (${euro(t.taxable)} × ${percent} %, kaufmännisch gerundet).`}];
 }),
};

// kosit: result of verifier/kosit.mjs validate(). Messages are classified by rule code (acceptance.kositRules), else
// by level (acceptance.kositLevels); a level the profile does not name counts as a failure. The level is the one in the
// message: scenario customLevel downgrades (BR-CL-21/23 to warning) are deliberately not applied, so this test is
// stricter than KoSIT's own accept/reject there.
// today: ISO date for the date check, default the current date in Europe/Berlin.
export function runChecks({xml,kosit,acceptance,recipient,expectedTotal,today=berlinToday()}){
 const failures=[],minor=[];
 for(const m of kosit.messages){
  if((acceptance.kositRules[m.code]??acceptance.kositLevels[m.level])==='minor')minor.push({code:m.code,level:m.level,textDe:textDe(m.code,m.text)});
  else failures.push({code:m.code,textDe:textDe(m.code,m.text)});
 }
 if(!kosit.accepted&&!failures.length)failures.push({code:'KOSIT-REJECT',textDe:`Der KoSIT-Prüfer hat die Rechnung abgelehnt (HTTP ${kosit.httpStatus}).`});
 let facts;
 try{facts=invoiceFacts(xml);}
 catch(error){
  failures.push({code:'ABN-XML',textDe:`Die gelieferte XML-Datei kann nicht sicher gelesen werden: ${error.message}.`});
  return {passed:false,failures,minor};
 }
 for(const check of acceptance.semanticChecks){
  const run=SEMANTIC[check.id];
  if(!run)throw new Error(`Unknown semantic check ${check.id} in acceptance profile`);
  failures.push(...run(facts,{recipient,expectedTotal,check,today}));
 }
 return {passed:kosit.accepted&&!failures.length,failures,minor};
}
