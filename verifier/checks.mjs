import {textDe} from './messages-de.mjs';

// Semantic acceptance checks on the delivered XRechnung-UBL XML against the acceptance profile and the
// recipient profile (Empfängerprofil). Reads the cbc:/cac: prefixed UBL our builder emits.
const blocks=(xml,tag)=>[...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`,'g'))].map(m=>m[1]);
const value=(xml,tag)=>{const v=xml.match(new RegExp(`<${tag}\\b[^>]*>([^<]*)</${tag}>`))?.[1];return v==null?null:v.trim();};
const norm=s=>s==null?null:s.replace(/\s+/g,'').toUpperCase();
const vatIds=party=>blocks(party,'cac:PartyTaxScheme').filter(b=>value(blocks(b,'cac:TaxScheme')[0]??'','cbc:ID')==='VAT').map(b=>norm(value(b,'cbc:CompanyID')));
const cents=n=>Math.round(Number(n)*100);
const euro=n=>Number(n).toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2})+' €';

export function invoiceFacts(xml){
 const seller=blocks(xml,'cac:AccountingSupplierParty')[0]??'';
 const buyer=blocks(xml,'cac:AccountingCustomerParty')[0]??'';
 return {
  payableAmount:value(blocks(xml,'cac:LegalMonetaryTotal')[0]??'','cbc:PayableAmount'),
  sellerVatIds:vatIds(seller),
  buyerVatIds:vatIds(buyer),
  ibans:blocks(xml,'cac:PayeeFinancialAccount').map(b=>norm(value(b,'cbc:ID'))),
  lineCategories:blocks(xml,'cac:ClassifiedTaxCategory').map(b=>value(b,'cbc:ID')),
  breakdownCategories:blocks(xml,'cac:TaxSubtotal').map(b=>value(blocks(b,'cac:TaxCategory')[0]??'','cbc:ID')),
  buyerReference:value(xml,'cbc:BuyerReference'),
 };
}

const SEMANTIC={
 'payable-amount':(f,{expectedTotal})=>{
  if(expectedTotal==null)return [{code:'ABN-BETRAG',textDe:'Es liegt kein erwarteter Rechnungsbetrag vor; der Zahlbetrag (BT-115) kann nicht abgenommen werden.'}];
  if(f.payableAmount==null)return [{code:'ABN-BETRAG',textDe:'Der Zahlbetrag (BT-115) fehlt.'}];
  return cents(f.payableAmount)===cents(expectedTotal)?[]:[{code:'ABN-BETRAG',textDe:`Der Zahlbetrag (BT-115) ist ${euro(f.payableAmount)}, erwartet waren ${euro(expectedTotal)}.`}];
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
 'buyer-reference':(f,{recipient})=>{
  if(!f.buyerReference)return [{code:'ABN-BT10',textDe:`Die Käuferreferenz (BT-10) fehlt; ${recipient.name} erwartet ${recipient.buyerReferenceHinweis}.`}];
  return new RegExp(recipient.buyerReferencePattern).test(f.buyerReference)?[]:[{code:'ABN-BT10',textDe:`Die Käuferreferenz (BT-10) „${f.buyerReference}“ passt nicht zum Muster von ${recipient.name} (${recipient.buyerReferenceHinweis}).`}];
 },
};

// kosit: result of verifier/kosit.mjs validate(). Messages are classified by acceptance.kositLevels;
// a level the profile does not name counts as a failure.
export function runChecks({xml,kosit,acceptance,recipient,expectedTotal}){
 const failures=[],minor=[];
 for(const m of kosit.messages){
  if(acceptance.kositLevels[m.level]==='minor')minor.push({code:m.code,level:m.level,textDe:textDe(m.code,m.text)});
  else failures.push({code:m.code,textDe:textDe(m.code,m.text)});
 }
 if(!kosit.accepted&&!failures.length)failures.push({code:'KOSIT-REJECT',textDe:`Der KoSIT-Prüfer hat die Rechnung abgelehnt (HTTP ${kosit.httpStatus}).`});
 const facts=invoiceFacts(xml);
 for(const check of acceptance.semanticChecks){
  const run=SEMANTIC[check.id];
  if(!run)throw new Error(`Unknown semantic check ${check.id} in acceptance profile`);
  failures.push(...run(facts,{recipient,expectedTotal}));
 }
 return {passed:kosit.accepted&&!failures.length,failures,minor};
}
