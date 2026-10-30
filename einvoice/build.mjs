import {InvoiceService} from '@e-invoice-eu/core';

// Flat invoice fields (see einvoice/extract.mjs FIELDS_SCHEMA) -> XRECHNUNG-UBL XML string.
// cbc:CustomizationID is left out on purpose: the XRECHNUNG-UBL format then fills in the XRechnung 3.0 ID.
// Setting the plain EN16931 ID would select a scenario without the German BR-DE rules.
// Half-up away from zero (kaufmännisch) to whole cents. toFixed(6) first drops binary float noise: 0.5*2.01*100 is
// 100.49999999999999, which Math.round alone takes down to 1,00 instead of 1,01.
const halfUp=x=>{const v=Number(x.toFixed(6));return Math.sign(v)*Math.round(Math.abs(v));};
const cents=n=>halfUp(n*100);
const amount=c=>(c/100).toFixed(2);
const number=n=>String(Number(n.toFixed(6)));
const AE_REASON='Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG)';
const taxCategory=(category,rate)=>({'cbc:ID':category,'cbc:Percent':number(rate),'cac:TaxScheme':{'cbc:ID':'VAT'}});
const address=(street,postcode,city,country)=>({'cbc:StreetName':street,'cbc:CityName':city,'cbc:PostalZone':postcode,'cac:Country':{'cbc:IdentificationCode':country||'DE'}});

export function invoiceData(f){
 if(f.reverseCharge!==f.lines.some(l=>l.vatCategory==='AE'))throw new Error('XRechnung kann nicht erzeugt werden: der Hinweis auf § 13b UStG (reverseCharge) passt nicht zu den Steuerkategorien der Positionen.');
 const currency=f.currency||'EUR';
 const lines=f.lines.map(l=>({...l,net:cents(l.quantity*l.unitPrice)}));
 const groups=new Map();
 for(const l of lines){
  const key=`${l.vatCategory}|${l.vatRate}`;
  const g=groups.get(key)||{category:l.vatCategory,rate:l.vatRate,taxable:0};
  g.taxable+=l.net;groups.set(key,g);
 }
 const subtotals=[...groups.values()].map(g=>({...g,tax:halfUp(g.taxable*g.rate/100)}));
 const net=lines.reduce((s,l)=>s+l.net,0);
 const tax=subtotals.reduce((s,g)=>s+g.tax,0);
 const invoice={
  'cbc:ID':f.invoiceNumber,
  'cbc:IssueDate':f.invoiceDate,
  'cbc:DueDate':f.dueDate??undefined,
  'cbc:InvoiceTypeCode':f.invoiceType||'380',
  'cbc:Note':f.reverseCharge?[AE_REASON]:undefined,
  'cbc:DocumentCurrencyCode':currency,
  'cbc:BuyerReference':f.buyerReference??undefined,
  'cac:AccountingSupplierParty':{'cac:Party':{
   'cbc:EndpointID':f.sellerEmail,'cbc:EndpointID@schemeID':'EM',
   'cac:PostalAddress':address(f.sellerStreet,f.sellerPostcode,f.sellerCity,f.sellerCountry),
   'cac:PartyTaxScheme':f.sellerVatId?[{'cbc:CompanyID':f.sellerVatId,'cac:TaxScheme':{'cbc:ID':'VAT'}}]:undefined,
   'cac:PartyLegalEntity':{'cbc:RegistrationName':f.sellerName},
   'cac:Contact':{'cbc:Name':f.sellerContactName??undefined,'cbc:Telephone':f.sellerPhone??undefined,'cbc:ElectronicMail':f.sellerEmail??undefined},
  }},
  'cac:AccountingCustomerParty':{'cac:Party':{
   'cbc:EndpointID':f.buyerEmail,'cbc:EndpointID@schemeID':'EM',
   'cac:PostalAddress':address(f.buyerStreet,f.buyerPostcode,f.buyerCity,f.buyerCountry),
   'cac:PartyTaxScheme':f.buyerVatId?{'cbc:CompanyID':f.buyerVatId,'cac:TaxScheme':{'cbc:ID':'VAT'}}:undefined,
   'cac:PartyLegalEntity':{'cbc:RegistrationName':f.buyerName},
  }},
  'cac:Delivery':f.serviceDate?{'cbc:ActualDeliveryDate':f.serviceDate}:undefined,
  'cac:PaymentMeans':[{'cbc:PaymentMeansCode':'58','cac:PayeeFinancialAccount':{'cbc:ID':f.sellerIban,'cbc:Name':f.sellerName}}],
  'cac:PaymentTerms':f.paymentTerms?{'cbc:Note':f.paymentTerms}:undefined,
  'cac:TaxTotal':[{
   'cbc:TaxAmount':amount(tax),'cbc:TaxAmount@currencyID':currency,
   'cac:TaxSubtotal':subtotals.map(g=>({
    'cbc:TaxableAmount':amount(g.taxable),'cbc:TaxableAmount@currencyID':currency,
    'cbc:TaxAmount':amount(g.tax),'cbc:TaxAmount@currencyID':currency,
    'cac:TaxCategory':{...taxCategory(g.category,g.rate),...(g.category==='AE'?{'cbc:TaxExemptionReasonCode':'VATEX-EU-AE','cbc:TaxExemptionReason':AE_REASON}:{})},
   })),
  }],
  'cac:LegalMonetaryTotal':{
   'cbc:LineExtensionAmount':amount(net),'cbc:LineExtensionAmount@currencyID':currency,
   'cbc:TaxExclusiveAmount':amount(net),'cbc:TaxExclusiveAmount@currencyID':currency,
   'cbc:TaxInclusiveAmount':amount(net+tax),'cbc:TaxInclusiveAmount@currencyID':currency,
   'cbc:PayableAmount':amount(net+tax),'cbc:PayableAmount@currencyID':currency,
  },
  'cac:InvoiceLine':lines.map((l,i)=>({
   'cbc:ID':String(i+1),
   'cbc:InvoicedQuantity':number(l.quantity),'cbc:InvoicedQuantity@unitCode':l.unit,
   'cbc:LineExtensionAmount':amount(l.net),'cbc:LineExtensionAmount@currencyID':currency,
   'cac:Item':{'cbc:Name':l.description,'cac:ClassifiedTaxCategory':taxCategory(l.vatCategory,l.vatRate)},
   'cac:Price':{'cbc:PriceAmount':number(l.unitPrice),'cbc:PriceAmount@currencyID':currency},
  })),
 };
 // JSON round trip drops the undefined optionals so the library's strict schema check sees only real values.
 return JSON.parse(JSON.stringify({'ubl:Invoice':invoice}));
}

const silent={log(){},warn(){},error(){}};
// xmlbuilder2 4.0.3 (via the library's create(data)) first decodes &amp; &lt; &gt; &quot; &apos; and &#…; in every input
// string (BaseReader._decodeText), then escapes only an "&" that does not look like an entity (/&(?![A-Za-z]+;|#\d+;)/).
// So free text "R&D;" came out as the undeclared entity &D;, and "&#65;" as "A". Each "&" goes in as "&amp;amp;": the
// reader makes it "&amp;", which the writer keeps, so the XML text is exactly the input (einvoice/roundtrip.test.mjs).
const escapeAmpersands=data=>JSON.parse(JSON.stringify(data),(_key,value)=>typeof value==='string'?value.replaceAll('&','&amp;amp;'):value);
export async function buildXml(fields){
 let xml;
 try{xml=await new InvoiceService(silent).generate(escapeAmpersands(invoiceData(fields)),{format:'XRECHNUNG-UBL',lang:'de-de'});}
 catch(error){
  if(!error.errors)throw error;
  throw new Error(`XRechnung kann nicht erzeugt werden: ${error.errors.map(e=>`${e.instancePath} ${e.message}`).join('; ')}`);
 }
 return typeof xml==='string'?xml:new TextDecoder().decode(xml);
}
