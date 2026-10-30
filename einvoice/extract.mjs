import Anthropic from '@anthropic-ai/sdk';
import {jsonSchemaOutputFormat} from '@anthropic-ai/sdk/helpers/json-schema';
import {parseFixed} from './parse-fixed.mjs';

// Flat invoice fields shared by extract (LLM), parse-fixed (deterministic) and build.
const str={type:'string'};
const num={type:'number'};
const date={type:'string',format:'date'};
const opt=s=>({anyOf:[s,{type:'null'}]});
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
export const UNITS=['HUR','H87','C62','LS','MTR','KGM','DAY'];
export const FIELDS_SCHEMA=object({
 invoiceNumber:str,invoiceDate:date,invoiceType:{type:'string',enum:['380','875']},serviceDate:opt(date),
 sellerName:str,sellerStreet:str,sellerPostcode:str,sellerCity:str,sellerCountry:str,
 sellerVatId:opt(str),sellerIban:opt(str),sellerContactName:opt(str),sellerPhone:opt(str),sellerEmail:opt(str),
 buyerName:str,buyerStreet:str,buyerPostcode:str,buyerCity:str,buyerCountry:str,buyerVatId:opt(str),buyerEmail:opt(str),
 buyerReference:opt(str),
 lines:{type:'array',items:object({description:str,quantity:num,unit:{type:'string',enum:UNITS},unitPrice:num,vatCategory:{type:'string',enum:['S','AE']},vatRate:num})},
 netTotal:opt(num),vatTotal:opt(num),grossTotal:opt(num),
 dueDate:opt(date),paymentTerms:opt(str),reverseCharge:{type:'boolean'},
});

const SYSTEM=`You extract German invoices (Rechnungen) that a bookkeeper pasted as plain text into structured fields for an XRechnung.
Copy values exactly as printed; never invent a value. If a field is not in the text, return null.
- Dates as YYYY-MM-DD. Amounts and quantities as JSON numbers with a dot decimal (1.234,50 -> 1234.5).
- invoiceType: "875" for an Abschlagsrechnung / Teilrechnung for construction work, otherwise "380".
- serviceDate: Leistungsdatum / Ausführungsdatum / Leistungszeitraum end.
- buyerReference (BT-10): the reference the buyer asked to be quoted, e.g. "Ihr Zeichen", "Objekt-Nr.", "Bestell-Nr.", "Leitweg-ID". Never use the invoice number.
- buyerVatId: only the buyer's own USt-IdNr. Seller identifiers go into the seller fields.
- unit: Std/h -> HUR, Stk/St./Stück -> H87, pauschal/psch/Pausch. -> LS, m -> MTR, kg -> KGM, Tag -> DAY, otherwise C62.
- reverseCharge: true when the text says the tax liability passes to the recipient (§ 13b UStG, Steuerschuldnerschaft des Leistungsempfängers, Reverse Charge). Then every line has vatCategory "AE" and vatRate 0; otherwise vatCategory "S" with the printed rate.
- unitPrice is the net price per unit; netTotal, vatTotal and grossTotal are the totals printed on the invoice.`;

export const MODEL='claude-opus-5-5';

export async function extractLlm(text,client=new Anthropic()){
 const response=await client.beta.messages.parse({
  model:MODEL,
  max_tokens:16000,
  betas:['server-side-fallback-2026-07-01'],
  fallbacks:'default',
  output_config:{effort:'medium',format:jsonSchemaOutputFormat(FIELDS_SCHEMA)},
  system:SYSTEM,
  messages:[{role:'user',content:`<rechnung>\n${text}\n</rechnung>`}],
 });
 if(response.stop_reason!=='end_turn'||!response.parsed_output)throw new Error(`Claude extraction stopped with ${response.stop_reason}`);
 return response.parsed_output;
}

export async function extract(text,mode=process.env.EXTRACT_MODE||'llm'){
 if(mode==='fixed')return parseFixed(text);
 if(mode==='llm')return extractLlm(text);
 throw new Error(`EXTRACT_MODE must be fixed or llm, got ${mode}`);
}
