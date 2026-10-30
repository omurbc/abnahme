# Abnahme: business case

**A buyer-run acceptance test for German e-invoices, enforced by a Masumi escrow on Cardano.** The converter agent is paid only after the buyer's agent has run the KoSIT validator and the recipient's own acceptance profile on the result. Sold as a Sokosumi Coworker to German trades businesses (Handwerk), starting with subcontractors that bill general contractors (GCs).

Status: 30 Oct 2026, TUM Blockchain & AI Hackathon (Cardano track). The product runs on Cardano **preprod** only. There are **no customers, no pilots and no letters of intent**. Every number below has a source link. Numbers marked **(est.)** are our estimates, and the assumptions behind them are stated next to them. All web sources were fetched on 30 Oct 2026 unless a different date is given. Key numbers in machine-readable form: [`business-facts.json`](business-facts.json).

## At a glance

| | |
|---|---|
| Trigger | From 1 Jan 2027 a German business whose prior-year turnover was above EUR 800,000 must issue e-invoices for domestic B2B supplies; from 1 Jan 2028 all businesses except small businesses under §19 UStG. No delay has been enacted (§1). |
| Market | 564,045 Handwerk enterprises (Destatis, 2024). About 121,000 of them above EUR 800k turnover (est.). Bottom-up TAM 36-79 million B2B invoices a year, EUR 54-117 million a year at the planned EUR 1.49 per invoice (est.) (§2). |
| Pain | A GC's accounts payable (AP) returns invoices that miss its own fields (reference code, order number, buyer VAT ID). The payment period starts again only when a proper invoice arrives (§3). |
| Price | Planned mainnet price: EUR 1.49 net per accepted invoice, about 90 Sokosumi credits at the Starter rate of EUR 25 per 1,500 credits. The check (PRÜFEN) is free, and refused invoices are free. RechneX charges EUR 2.99-3.99 per invoice (§4, §7). |
| Unit economics | The hackathon build opens one escrow per invoice. On mainnet that costs about EUR 0.62 per invoice in Cardano fees at today's ADA price, which leaves about EUR 0.05 of the est. EUR 0.76 that reaches us through Sokosumi. Production settles through one Masumi escrow per customer and month (designed, not built yet): total cost is about EUR 0.12 per invoice, and gross margin is 84% via Sokosumi or 92% sold direct (est.) (§5). |
| Differentiation | Among the 29 competitor products whose pages we could read, none tests an invoice against the recipient's own rules, and none is paid only after the buyer accepts (§7). |
| Traction | 97 confirmed preprod transactions, 261 tests, a two-part internal security review, one upstream bug report and fix for the Masumi Payment Service (§10). |

---

## 1. The trigger: the German B2B e-invoicing mandate

**The law.** The Wachstumschancengesetz ([BGBl. 2024 I Nr. 108](https://www.recht.bund.de/bgbl/1/2024/108/VO.html), 27 Mar 2024) redefined the invoice in [§14 Abs. 1 UStG](https://www.gesetze-im-internet.de/ustg_1980/__14.html). An e-invoice is "in einem strukturierten elektronischen Format ausgestellt, übermittelt und empfangen", following EN 16931. The duty applies to supplies between two businesses established in Germany (§14 Abs. 2 S. 2 Nr. 1), so invoices to private customers are exempt.

| Date | Rule | Source |
|---|---|---|
| 1 Jan 2025 | Every business must be able to **receive** e-invoices. No transition period. | [BMF letter 15 Oct 2024](https://www.zdh.de/fileadmin/Oeffentlich/Steuern_und_Finanzen/Themen/20241015_03-01_BMF_E-Rechnung_final.pdf), Rn. 62 (copy hosted by ZDH) |
| until 31 Dec 2026 | Anyone may still issue paper, or PDF with the recipient's consent. | [§27 Abs. 38 Nr. 1 UStG](https://www.gesetze-im-internet.de/ustg_1980/__27.html) |
| 1 Jan 2027 | Paper or PDF only if the issuer's prior-year total turnover (Gesamtumsatz) was **not more than EUR 800,000**. EDI with the recipient's consent stays allowed through 2027, regardless of size. | §27 Abs. 38 Nr. 2 and Nr. 3 UStG |
| 1 Jan 2028 | Everyone must issue, except small businesses under §19 UStG. | [§34a UStDV](https://www.gesetze-im-internet.de/ustdv_1980/__34a.html), [ZDH](https://www.zdh.de/themen-und-positionen/zdh-positionen/zdh-kompakt/verschiebung-der-e-rechnungspflicht-auf-den-1-januar-2028/) |

- **Exemptions that matter for trades.** Invoices up to EUR 250 ([§33 UStDV](https://www.gesetze-im-internet.de/ustdv_1980/__33.html)) and invoices to consumers (BMF 2024, Rn. 19-20).
- **Reverse-charge construction invoices are included.** §13b invoices fall under the duty when both parties are established in Germany ([BMF letter 15 Oct 2025](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Umsatzsteuer/Umsatzsteuer-Anwendungserlass/2025-10-15-einfuehrung-obligatorische-e-rechnung.pdf), Rn. 17).
- **Formats.** XRechnung, and ZUGFeRD from version 2.0.1 except the profiles MINIMUM and BASIC-WL. Hybrid PDF+XML formats are allowed (BMF 2024, Rn. 24-25).
- **Third BMF letter, 15 Oct 2026** ("Ergänzende Regelungen", [copy hosted by ZDH](https://www.zdh.de/fileadmin/Oeffentlich/Steuern_und_Finanzen/Themen/E-Rechnung/20261015_BMF-Schreiben_E-Rechnung_final.pdf)). It restates the transition rules up to 31 Dec 2027. For construction invoices it accepts the trades and their totals in the structured part, with the details in an annex (Rn. 14).

**Delay: requested, not decided.**
- **The request.** On 22 Jun 2026 the ZDH (the national Handwerk association) asked to move the date for businesses above EUR 800k from 1 Jan 2027 to 1 Jan 2028 ([ZDH](https://www.zdh.de/themen-und-positionen/zdh-positionen/zdh-kompakt/verschiebung-der-e-rechnungspflicht-auf-den-1-januar-2028/)). Its reasons were the late revision of EN 16931 and software that does not implement the standard correctly.
- **Renewed in October.** The Sächsischer Handwerkstag renewed the demand in October ([DHZ, 15 Oct 2026](https://www.deutsche-handwerks-zeitung.de/e-rechnungspflicht-2027-handwerk-fordert-ein-jahr-aufschub-385076/)). That article dates the ZDH demand to "Ende August 2026", but ZDH's own page shows June.
- **No change in the law.** §27 Abs. 38 UStG is unchanged; the UStG was last amended on 29 Jun 2026 without touching it. Haufe on 22 Oct 2026: "Mit einer Verlängerung der Übergangsfristen ist derzeit nicht zu rechnen" ([Haufe](https://www.haufe.de/steuern/gesetzgebung-politik/elektronische-rechnung-wird-pflicht-e-rechnung-im-ueberblick_168_605558.html)).
- **Status.** **No delay enacted as of 22 Oct 2026**, the date of the latest source.
- **Not checked.** We did not check positions of the DIHK, the Bundesrat in 2026 or the coalition.

**What a wrong invoice costs, legally.** This is the honest version, and it shapes our pitch.
- **Input tax.** A paper or PDF invoice where an e-invoice is required is not a proper invoice. It "berechtigt … dem Grunde nach nicht zum Vorsteuerabzug" (BMF 2024, Rn. 56).
  - The BMF softens this. A correction takes effect retroactively (Rn. 57). For a content-correct invoice the conditions for deduction "regelmäßig erfüllt sein" will be met (BMF 2025, UStAE 15.2a Abs. 1a).
- **No fine.** Issuing another invoice instead of an e-invoice "stellt … keine Ordnungswidrigkeit nach § 26a Abs. 2 Nr. 1 UStG dar" (BMF 2026, Rn. 28).
- **Rule errors don't void the e-invoice.** A file with a business-rule error but no format error is still "prinzipiell eine E-Rechnung" (BMF 2026). Errors in BT-10 (buyer reference) "sind umsatzsteuerlich unbeachtlich" (BMF 2025, Rn. 35a).
- **So we do not sell VAT fear.** The cost of a bad invoice is commercial: the GC's AP returns it, and the payment period starts again (§3).

**EU context.** The EU adopted ViDA (VAT in the Digital Age) on 11 Mar 2025. Digital reporting for cross-border B2B transactions starts on 1 Jul 2030, and national systems must be aligned by 1 Jan 2035 ([European Commission](https://taxation-customs.ec.europa.eu/taxation/vat/vat-digital-age-vida_en)).

---

## 2. Market

### Verified figures

| Figure | Value | Source |
|---|---|---|
| Handwerk businesses in the chamber registers, 31 Dec 2025 | 1,038,126 | [ZDH, June 2026](https://www.zdh.de/daten-und-fakten/kennzahlen-des-handwerks/wirtschaftlicher-stellenwert-des-handwerks-2025/) |
| Handwerk enterprises (Handwerkszählung 2024: turnover above EUR 22,000 or at least one employee) | 564,045; EUR 762 bn turnover; 6.0 million people | [Destatis, 23 Apr 2026](https://www.destatis.de/DE/Presse/Pressemitteilungen/2026/04/PD26_143_53211.html) |
| ... with turnover of EUR 500k or more | 187,312 (33.2%) | [ZDH evaluation of Handwerkszählung 2024](https://www.zdh.de/fileadmin/Oeffentlich/Wirschaft_Energie_Umwelt/Themen/Daten_Fakten/Handwerkszaehlung/2024/Auswertung_HWZ_2024.xlsx), sheet UKL |
| ... with turnover of EUR 5m or more | 22,144 | same |
| Finishing trades (Ausbaugewerbe) | 213,306 enterprises, EUR 213 bn; 72,662 at EUR 500k or more; 6,024 at EUR 5m or more | Destatis; ZDH sheet UKL |
| Main construction trades (Bauhauptgewerbe) | 76,877 enterprises, EUR 138 bn; 34,122 at EUR 500k or more | [Destatis table](https://www.destatis.de/DE/Themen/Branchen-Unternehmen/Handwerk/Tabellen/handwerksunternehmen-insgesamt.html); ZDH sheet UKL |
| Munich: Handwerk businesses, 2025 annual average (includes Anlage B2) | 19,366, of which 5,614 finishing trades and 1,471 main construction | [Statistisches Amt München, 8 Jul 2026](https://lhm.muenchen.swm.de/dam/jcr:b872138b-ff19-4482-9536-1f23a8f0a9b2/jt260512.pdf) |
| Handwerkskammer für München und Oberbayern | "rund 80.000 Mitgliedsbetriebe" (undated) | [HWK München](https://www.hwk-muenchen.de/artikel/die-handwerkskammer-ein-starker-partner-74,4001,7284.html) |
| B2B e-invoice cases per year, whole economy (government estimate) | about 1.18 bn | [Drucksache 20/8628](https://dserver.bundestag.de/btd/20/086/2008628.pdf), p. 98 |

Destatis has no turnover class boundary at EUR 800k, so no official count of Handwerk firms above the threshold exists. The count lies between 22,144 (firms at EUR 5m or more) and 187,312 (firms at EUR 500k or more).

**Readiness: ZDH survey, Jan-Feb 2026, 1,926 businesses from 52 chambers** ([results PDF](https://www.zdh.de/fileadmin/Oeffentlich/Steuern_und_Finanzen/Themen/Umsatzsteuer/20260520_03-01_ZDH-Umfrage_E-Rechnung_UEbersicht.pdf), [press release](https://www.zdh.de/presse/veroeffentlichungen/pressemitteilungen/e-rechnung-fuer-betriebe-noch-mehr-aufwand-statt-entlastung/)). The sample is self-selected, and 44.0% of respondents are above EUR 800k, so the results are not representative.

| Result | Value |
|---|---|
| Already issue e-invoices | 37.1% |
| Non-issuers that plan to start only in H2 2027 | 48.2% |
| Named at least one problem receiving e-invoices (our reading of the answer rate) | 67.7% |
| Receive e-invoices by e-mail / by Peppol | 93.4% / 0.3% |
| Process incoming e-invoices manually | 65.7% |
| Outgoing invoices per year, firms already issuing (2025) | 1,310 on average |
| Cost of e-invoicing: one-off / per year | EUR 2,976 / EUR 798 on average |

Bitkom, DIHK and software-vendor surveys could not be verified and are not used.

### Bottom-up sizing (est.)

**Assumptions.**
- **A1, firms above EUR 800k.** About **121,000** Handwerk enterprises. We fitted a power law between the two Destatis class boundaries (EUR 500k and 5m), which gives an exponent of 0.93. For the finishing trades the same method gives about 43,700 (exponent 1.08). For the main construction trades we apply the finishing-trade exponent, because no EUR 5m count is available, and get about 20,500.
- **A2, B2B invoices per firm.** **300 to 650 a year.** This is the ZDH average of 1,310 outgoing invoices times an assumed B2B share of 25-50%. The composite persona Toni sends 29 a month, or 348 a year; SAM and SOM use 350.
- **A3, price.** EUR 1.49 per accepted invoice, the planned mainnet price (§4).

| Tier | Definition | Firms | Invoices per year | EUR per year at EUR 1.49 |
|---|---|---|---|---|
| TAM | All Handwerk enterprises above EUR 800k (mandated from 2027) | ~121,000 | 36-79 million | EUR 54-117 million (36.3 million × 1.49 to 78.7 million × 1.49) |
| SAM | Finishing and main construction trades above EUR 800k, which bill GCs and property managers | ~64,000 | ~22.5 million | ~EUR 33.5 million (22.5 million × 1.49) |
| SOM, year 3 | 1,000 paying firms in Munich and Oberbayern, about 1.3% of the HWK's 80,000 members | 1,000 | 350,000 | EUR 522k retail (350,000 × 1.49); about EUR 267k reaches us through Sokosumi (350,000 × EUR 0.763, §4) |

Two cross-checks:
- **Spend-based.** 121,000 firms times the ZDH average annual e-invoice cost of EUR 798 is about EUR 97 million a year. All 564,045 firms, which are mandated from 2028, give about EUR 450 million a year.
- **Not yet issuing.** Within the SAM, about 40,000 firms do not issue e-invoices yet, applying ZDH's 37.1%. Firms that already issue still need the recipient check.

**What the sizing says.** At EUR 1.49 per invoice, the Handwerk wedge alone is still a modest market. The case for venture funding depends on three levers:
1. Price per invoice. Competitors charge EUR 2.99-5.00 per file (§7).

   | Price per accepted invoice | SAM per year |
   |---|---|
   | EUR 1.49 (planned mainnet price, ~90 credits) | ~EUR 33.5 million |
   | EUR 2.99 (RechneX create price) | ~EUR 67 million |

2. GC-paid contracts that cover all of a GC's subcontractors.
3. Taking buyer-run acceptance beyond Handwerk to other senders and agent buyers, and later "Fällig" (§8).

---

## 3. Customer and pain

**Who.** A finishing-trade subcontractor that sends monthly progress invoices (Abschlagsrechnungen) to general contractors. Our face for it is **Toni Huber Elektrotechnik GmbH**, Munich. Toni is a **composite persona**, not a real firm: 8 people, about EUR 1.1M turnover, so above the threshold from 2027. His part-time office manager, Frau Berger, writes the invoices and has no crypto wallet.

**Why a bounced invoice costs money.**
- **Payment periods.**
  - Under [VOB/B §16](https://dejure.org/gesetze/VOB-B/16.html) a progress payment is due "binnen 21 Tagen nach Zugang der Aufstellung" (Abs. 1 Nr. 3). The final payment is due within 30 days, or at most 60 if agreed (Abs. 3 Nr. 1).
  - GC terms are often longer. STRABAG's 2025 construction terms say 30 days after receipt for progress invoices, and 2 months after acceptance and receipt of a reviewable final invoice. Payments are capped at 90% with a 5% retention ([STRABAG ABV 2025](https://strabag-pfs.com/site/strabag-company-locale/get/params_E-103557440_Dattachment/1546899/ABV_Allgemeine%20Bauvertragsbedingungen_2025-02-17.pdf)).
  - Max Bögl: "Die Zahlungsfrist beginnt mit dem Eingang der prüfbaren, ordnungsgemäßen Rechnung" ([Max Bögl](https://max-boegl.de/content/dam/maxboeglsitesassets/E-Rechnung/de_hinweise_zu_dem_elektronischen_rechnungseingang.pdf.coredownload.pdf)).
  - A returned invoice therefore restarts the clock.
- **Cost of one bounce (est.).** For the EUR 18,400 progress invoice in our fixtures, at an assumed 10% a year financing cost:
  - 21 extra days cost about **EUR 106**. At STRABAG's 30 days, about EUR 151.
  - One avoided bounce pays for about 71 accepted invoices at EUR 1.49 (106 ÷ 1.49).
  - For reference, the statutory B2B default interest rate is the base rate plus 9 points, which is 1.52% + 9 = 10.52% since 1 Jul 2026 ([§288 Abs. 2 BGB](https://www.gesetze-im-internet.de/bgb/__288.html), [Bundesbank](https://www.bundesbank.de/de/presse/pressemitteilungen/bekanntgabe-des-basiszinssatzes-zum-1-juli-2026-anpassung-auf-1-52--941386)).
- **The expensive tax error: reverse charge.**
  - When a subcontractor supplies construction work to a contractor that itself supplies construction work, the recipient owes the VAT ([§13b Abs. 2 Nr. 4, Abs. 5 UStG](https://www.gesetze-im-internet.de/ustg_1980/__13b.html)). The invoice must say "Steuerschuldnerschaft des Leistungsempfängers" ([§14a Abs. 5](https://www.gesetze-im-internet.de/ustg_1980/__14a.html)).
  - If the subcontractor shows VAT anyway, it owes that VAT ([§14c Abs. 1](https://www.gesetze-im-internet.de/ustg_1980/__14c.html)), and the GC "erhält hieraus keinen Vorsteuerabzug" ([Haufe](https://www.haufe.de/id/beitrag/reverse-charge-verfahren-HI855907.html)). On the EUR 18,400 fixture that is EUR 3,496 at 19%.
  - Whether §13b applies depends on the GC's USt 1 TG certificate, which is valid for up to three years ([ZDH](https://www.zdh.de/ueber-uns/fachbereich-steuern-und-finanzen/umsatzsteuer/hinweise-zur-umsatzsteuer-bei-bauleistungen/), UStAE 13b.3). Our recipient profile pins that status, so the check does not have to guess it.

**What GC accounts payable rejects (published rules).**
- **STRABAG** ([one-pager](https://einvoicing.strabag.com/databases/internet/_public/files30.nsf/SearchView/59424FE39E6D909BC125849E0039781C/$File/One_Pager_E-Mail_mit_PDF.pdf), dated 2016 and still linked) and **Züblin** ([AAVB 2024](https://www.zueblin.de/site/zueblin-company-locale/get/params_E1034687086/2101053/AAVB_2024.pdf)):
  - an 18-character reference code
  - one invoice per e-mail
  - no collective invoices across cost centres
  - Otherwise the e-mail is "nicht weiterbearbeitet bzw. an den Absender retourniert". Züblin: without the reference code "eine elektronische Erfassung … nicht möglich".
  - STRABAG also requires a §48b EStG exemption certificate (Freistellungsbescheinigung).
- **Max Bögl:**
  - only EN 16931 e-invoices
  - order number in BT-13 ("beginnt mit 4… oder 5...")
  - cost centre in BT-19/BT-133
  - type codes 875 (progress) and 877 (final)
  - "AE" reverse charge
  - "Fehlerhaften Rechnungen werden per E-Mail an den Absender zurückgewiesen".

These rules are exactly what a recipient profile pins. Our two demo profiles already pin a number of them: BT-10 pattern, BT-48 buyer VAT ID, category AE, buyer name and postcode, supplier VAT ID, IBAN, amount and invoice type ([`verifier/profiles/`](../verifier/profiles)). **Max Bögl's BT-13 and BT-19 fields are not yet covered.** The profile schema needs extending.

**Limits of the pain claim.**
- A validation "ersetzt nicht die dem Empfänger obliegende Pflicht zur Überprüfung der Rechnung" (BMF 2025, Rn. 35a).
- KoSIT checks format and rules, not truth. A pass does not prove that the GC's ERP will book the invoice.

---

## 4. Product and pricing

| Step | Price | Notes |
|---|---|---|
| PRÜFEN (check): convert, run KoSIT and the recipient profile | free | Costs us one LLM extraction, about EUR 0.02-0.08 (§5) |
| SENDEN (send) an accepted invoice | **EUR 1.49 net, planned mainnet price** (team decision), about 90 credits | [Sokosumi pricing](https://www.sokosumi.com/pricing) (plans billed monthly per seat). Starter: EUR 25 for 1,500 credits, so 90 credits are EUR 1.50 and EUR 1.49 is 89.4 credits. Standard: EUR 75 for 5,000 (90 credits = EUR 1.35). Pro: EUR 200 for 15,000 (90 credits = EUR 1.20). Prices are net of VAT ([Terms](https://www.sokosumi.com/legal/terms-of-service)). On preprod the hackathon build charges a symbolic 1 tUSDM, which Sokosumi booked as 100 credits ([`plan/SOKOSUMI.md`](../plan/SOKOSUMI.md)). |
| A refused invoice | free | SENDEN runs only after an accepted PRÜFEN by the same user. It is refused before any payment request otherwise (README "Sokosumi Tasks") |
| Converter wholesale (RechnungsMeister, sold to other buyer agents on Masumi) | target EUR 0.30 per accepted invoice (plan) | On preprod both hops are a symbolic 1 tUSDM. Masumi takes 5% of the seller's price ([docs](https://www.masumi.network/dev/masumi/core-concepts/transaction-fees); [`FEE_PERMILLE_MAINNET: 50`](https://github.com/masumi-network/masumi-payment-service/blob/main/packages/payment-core/src/config.ts)) |

**What reaches us through Sokosumi (est.).**
- Sokosumi publishes no rate between credits and stablecoin, and its Terms say only that it pays suppliers "the agreed prices".
- Two observations point to **100 credits ≈ 1 USDM**:
  - Our paid SENDEN Task priced at 1 tUSDM was charged 100 credits on preprod ([`plan/SOKOSUMI.md`](../plan/SOKOSUMI.md)).
  - Matching mainnet listings to their on-chain registry prices gives the same ratio, for example 30 credits against 0.3 USDM for "Company Researcher".
- At that ratio, 90 credits pay our Coworker 0.90 USDM. After Masumi's 5% that is 0.855 USDM, about **EUR 0.763** per send (0.855 × USD 0.993 per USDM ÷ USD 1.1130 per EUR, §5).
- So Sokosumi would keep about half of the retail price. Both figures are unverified until Sokosumi confirms the rate.

**Honest limits of "pay only after acceptance".**
- Sokosumi credits are not refunded when an on-chain escrow refunds. The guarantee is enforced on the agent-to-agent hop (buyer agent to converter), not on Frau Berger's credits.
- The hackathon build opens one escrow per invoice. Production settles through the monthly batch escrow below.

**Monthly batch escrow (the production design for mainnet, not built yet).**
- Why: one escrow per invoice costs about EUR 0.62 per invoice in Cardano fees on mainnet (§5), most of the est. EUR 0.763 that reaches us through Sokosumi.
- One Masumi escrow per customer and month. Its `input_hash` binds a manifest of every invoice hash and profile hash in the batch.
- [§641 Abs. 1 S. 2 BGB](https://www.gesetze-im-internet.de/bgb/__641.html) supports paying per accepted part.
- **Constraint.** The V2 escrow releases or refunds the whole locked amount. A batch is therefore accepted only when every invoice in it is accepted; open invoices are cured first or carried to the next batch.
- **Batching of actions.** The Masumi Payment Service already batches up to 7 escrow actions per transaction ([`SUBMIT_RESULT_BATCH_SIZE = 7`](https://github.com/masumi-network/masumi-payment-service/blob/main/packages/payment-source-v2/src/services/payments/submit-result/service.ts)), and up to 10 for locks ([`maxBatchSize = 10`](https://github.com/masumi-network/masumi-payment-service/blob/main/packages/payment-source-v2/src/services/purchases/batch-payments/service.ts)). On preprod, two SubmitResults in one transaction cost 0.860 ADA, against 0.710 ADA for one.

**Price position.** EUR 1.49 is about half of RechneX's EUR 2.99 per created invoice, and below its EUR 3.99 per PDF conversion and invoice-converter.com's EUR 5 (§7). Validation services are cheaper (W System: USD 0.03 to validate, USD 0.08 to create), but none of them tests the recipient's own rules or is paid only after the buyer accepts (§7).

---

## 5. Unit economics per invoice

### Measured inputs

| Input | Value | Source |
|---|---|---|
| LLM for field extraction | `claude-opus-5-5`, effort `medium`; USD 4 per million input tokens, USD 20 per million output tokens; Batch API half price | [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing); [`einvoice/extract.mjs`](../einvoice/extract.mjs) |
| Thinking tokens | Billed as output tokens. At effort `medium` the model may skip thinking on easy inputs. | [Anthropic docs](https://platform.claude.com/docs/en/build-with-claude/extended-thinking) |
| Input tokens per extraction | 3,049-3,147 (system prompt, JSON schema, invoice text), counted for the four free-text fixtures with the `count_tokens` endpoint | [`fixtures/`](../fixtures) |
| Output tokens per extraction | 586-646 for the JSON fields (counted on the equivalent JSON of the same invoices) plus thinking: **0-3,000 assumed** (not measured) | [`einvoice/parse-fixed.mjs`](../einvoice/parse-fixed.mjs) |
| Cardano fee parameters | 44 lovelace per byte + 155,381 lovelace per transaction, plus script execution; **identical on preprod and mainnet** | Koios [mainnet](https://api.koios.rest/api/v1/cli_protocol_params), [preprod](https://preprod.koios.rest/api/v1/cli_protocol_params) |
| Escrow transaction fees (real, preprod) | lock 0.206-0.209 ADA; each script action (submit, dispute, cure, authorize, withdraw) 0.671-0.712 ADA | Koios `tx_info` on the hashes in [`plan/EVIDENCE.md`](../plan/EVIDENCE.md) |
| Why script actions cost 0.7 ADA | Each script transaction is about 11.3 KB, because the 10,003-byte V2 validator is included in every transaction. For `20ca2cf5…`: 71% of the fee is the per-byte part, 22% the fixed part, 8% script execution. | Koios `tx_info` |
| x402 inspection | 0.168 ADA network fee per payment, plus the 1 ADA price, which goes to our own Gutachter. The CF facilitator charges no fee of its own and does not sponsor fees. | `7dc0c48a…`; [CF x402 facilitator](https://github.com/cardano-foundation/cardano-x402-facilitator) |
| ADA price | EUR 0.1721 / USD 0.1921 (30 Oct 2026, 14:45 UTC); Kraken last trade EUR 0.1724 | [CoinGecko API](https://api.coingecko.com/api/v3/simple/price?ids=cardano&vs_currencies=eur,usd), [Kraken API](https://api.kraken.com/0/public/Ticker?pair=ADAEUR) |
| EUR/USD | 1.1130 (ECB reference rate, 29 Oct 2026) | [ECB data API](https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?lastNObservations=1&format=csvdata) |
| USDM | USD 0.993-0.998 (30-31 Oct 2026) | [CoinGecko API](https://api.coingecko.com/api/v3/simple/price?ids=usdm-2&vs_currencies=usd) |
| Server | Hetzner CPX42 (8 vCPU, 16 GB): EUR 69.99 a month, excl. VAT | [Hetzner](https://www.hetzner.com/cloud/regular-performance) |

**Derived building blocks** (at EUR 0.1721 per ADA):

| Item | ADA | EUR |
|---|---|---|
| One LLM extraction (0 / 1,000 / 3,000 thinking tokens) | | 0.023 / 0.041 / 0.077 |
| Agent escrow, accepted on the first delivery (lock, submit, withdraw) | 1.600 | 0.275 |
| Agent escrow, refuse → cure → accept (6 transactions) | 3.706 | 0.638 |
| One x402 inspection payment | 0.168 | 0.029 |
| Paid Sokosumi Task, our seller-side fees (submit + withdraw) | 1.378 | 0.237 |

### Per accepted invoice, two architectures (est.)

**Assumptions:**
- 1.2 checks per accepted invoice
- 20% of invoices need one cure
- an LLM extraction costs EUR 0.041
- converter wholesale is EUR 0.30, so Masumi's 5% on our internal hop is EUR 0.015
- fixed infrastructure is EUR 240 a month (two CPX42 plus EUR 100 for chain API, backups and monitoring), spread over 10,000 invoices a month

| Cost line (EUR) | A: one escrow per invoice (as built for the hackathon) | B: one escrow per customer and month, 29 invoices (production design, not built yet) |
|---|---|---|
| LLM extraction (1.2 checks) | 0.049 | 0.049 |
| Agent escrow fees (we run both buyer and converter) | 0.348 | 0.022 (one escrow with a cure, divided by 29) |
| Masumi 5% on the internal converter price | 0.015 | 0.015 |
| x402 inspection fees | 0.035 | 0.002 (2 bundled inspections per batch) |
| Sokosumi Task escrow, our fees | 0.237 | 0.008 (one paid Task per month) |
| Infrastructure | 0.024 | 0.024 |
| **Total cost** | **0.708** | **0.120** |
| Revenue via Sokosumi (est. EUR 0.763 of ~90 credits, §4) | **+0.055 contribution, 7% gross margin** | **+0.64, 84% gross margin** |
| Revenue sold direct (EUR 1.49) | +0.78, 52% gross margin | +1.37, 92% gross margin |

The arithmetic (gross margin = contribution ÷ revenue that reaches us):
- B via Sokosumi: 0.763 − 0.120 = 0.643; 0.643 ÷ 0.763 = 84%.
- B sold direct: 1.49 − 0.120 = 1.370; 1.370 ÷ 1.49 = 92%.
- A via Sokosumi: 0.763 − 0.708 = 0.055; 0.055 ÷ 0.763 = 7%.
- A sold direct: 1.49 − 0.708 = 0.782; 0.782 ÷ 1.49 = 52%.

**Per monthly batch** (Toni, 29 invoices, architecture B): revenue via Sokosumi 29 × EUR 0.7628 = EUR 22.12, cost 29 × EUR 0.1204 = EUR 3.49 (unrounded values), **EUR 18.63 contribution**. Sold direct: 29 × EUR 1.49 = EUR 43.21 revenue and EUR 39.72 contribution.

**What this means.**
- **As built, one escrow per invoice barely breaks even on mainnet.** Chain fees alone are EUR 0.62 per invoice at today's ADA price (0.348 + 0.035 + 0.237). Via Sokosumi that leaves EUR 0.055 per invoice, and above an ADA price of about EUR 0.19 the invoice loses money ((0.763 − 0.088 non-chain cost) ÷ 0.620 × EUR 0.1721). **The monthly batch is a precondition for launch, not an optimisation.**
- **Chain costs scale with the ADA price.** At ADA = EUR 0.50, chain costs per invoice are EUR 1.80 in A and EUR 0.09 in B.
- **Further levers (est., not measured):**
  - Masumi Payment Service batching across customers.
  - Reference scripts upstream. A script action that references the validator instead of carrying it could fall to about 0.42 ADA (1.4 KB of transaction plus 15 lovelace per byte of reference script).
  - The Batch API for checks that are not interactive.
  - Prompt caching of the fixed 1,860-token schema.
- **The free check is a real cost.** 1,000 free checks cost about EUR 41 in LLM fees.

---

## 6. Go-to-market

1. **GC supplier onboarding (hypothesis, no GC has been asked).**
   - A GC publishes its recipient profile once, and every subcontractor that invoices that GC uses it.
   - Large GCs already publish such rules: STRABAG, Züblin and Max Bögl (§3).
   - The pitch to the GC is fewer invoices that its AP cannot book, possibly paid from its AP budget for all its subcontractors.
   - We found no source for how many subcontractors a GC has. The "40-200 per GC" in our plan is an assumption, to be validated in the first GC interview.
   - We found no count of GCs either. Destatis reports that construction firms with 20+ employees buy in services worth 27.7% of their turnover, a broader category than subcontracting ([Destatis Kostenstruktur 2024](https://www.destatis.de/DE/Themen/Branchen-Unternehmen/Bauen/Publikationen/Downloads-Baugewerbe-Struktur/statistischer-bericht-kostenstruktur-baugewerbe-2040530247005.xlsx)).
2. **Sokosumi marketplace.**
   - Sokosumi lists 12 Coworkers and 40 agents from 7 vendors ([Sokosumi](https://www.sokosumi.com/ai-coworkers)).
   - 37 of the 40 agents are tagged research, design and analysis, or creative. Prices run from 30 to 1,850 credits per run, median 190 ([public agent API](https://api.sokosumi.com/v1/agents)).
   - A German listing for §13b progress invoices would be the marketplace's only finance and back-office offer that we found.
3. **Handwerk software, sold at wholesale.**
   - E-invoice software in the trades is fragmented. The top tools in the ZDH survey are Lexware (8.1%), IN-Software/INFORM (4.3%) and DATEV (3.5%).
   - Trade ERPs that create e-invoices make no claim to check recipient rules: [Plancraft](https://plancraft.com/de-de/preise), [ToolTime](https://www.tooltime.app/preise), [Das Programm](https://das-programm.io/preise).
   - We would offer the acceptance check as an API or agent.
4. **Chambers (HWK).**
   - The Munich and Oberbayern chamber has about 80,000 member businesses.
   - Chambers inform members about e-invoicing, and the ZDH lobbies on the deadline (§1).
   - We see chambers as a channel for events and information, not for resale (assumption).
5. **Tax advisors: honest constraints.**
   - [§62a StBerG](https://www.gesetze-im-internet.de/stberg/__62a.html) lets a tax practice give service providers access to client data under a written secrecy agreement, so a practice can work with us under such an agreement.
   - Practices work inside DATEV, a cooperative with over 40,000 members ([DATEV](https://www.datev.de/web/de/berufsgruppenuebergreifend/ueber-datev/das-unternehmen)).
   - DATEV runs its own e-invoice platform, which validates EN 16931 and receives through Peppol or e-mail ([DATEV](https://www.datev.de/web/de/berufsgruppenuebergreifend/themen-im-fokus/e-rechnung-mit-datev/datev-e-rechnungsplattform)). It also sells invoice writing for EUR 7 a month, which needs a DUO contract.
   - So we integrate with DATEV through export, and we do not compete with it.
   - Under [§2](https://www.gesetze-im-internet.de/stberg/__2.html) and [§5 StBerG](https://www.gesetze-im-internet.de/stberg/__5.html), assigning accounts to documents (Kontieren) is help in tax matters reserved to advisors. Abnahme must not decide tax treatment; the §13b status comes from the recipient's own profile.
   - Whether a check tool counts as help in tax matters is **not verified**. It needs a legal opinion before launch.

---

## 7. Competition

All prices are net unless noted, read from each vendor's own pricing page on 30 Oct 2026.

| Product | What it does | Price | Checks the recipient's own rules? | Paid only after the buyer accepts? |
|---|---|---|---|---|
| [RechneX](https://rechnex.de/preise) | Create, convert PDF to XRechnung/ZUGFeRD, validate | EUR 2.99 create, EUR 3.99 PDF conversion; Pro EUR 19 a month | No. Its own wording: "Die technische Prüfung ersetzt nicht die Kontrolle von Inhalt und Empfängervorgaben" | No. A 14-day technical guarantee, which excludes wrong inputs (AGB §9(4)) |
| [invoice-converter.com](https://invoice-converter.com/en/pricing) | PDF to XRechnung/ZUGFeRD with a KoSIT check | EUR 5 per conversion; EUR 10-35 a month | No | Refund for technical failure; "downstream rejections" excluded |
| [rechnungswandler.de](https://rechnungswandler.de) | Browser converter | 10 free a month; EUR 2.99 per 24 h; EUR 6.99 a month | No | No |
| [PDF24](https://tools.pdf24.org/de/e-rechnung-erstellen), [sevdesk generator](https://www.sevdesk.de/e-rechnungsgenerator) | Form or PDF to e-invoice | free | No | n/a |
| [Lexware Office](https://www.lexware.de/preise) | Accounting; create and send e-invoices in every plan | from EUR 7.90 a month | No (checks completeness) | No |
| [sevdesk](https://sevdesk.de/preise) | Accounting with e-invoices | EUR 9.90-34.90 a month | No | No |
| [DATEV Auftragswesen next](https://www.datev.de/web/de/unternehmen/loesungen/rechnungswesen/schnittstellen-und-softwarelandschaft/datev-auftragswesen-next) | Create and send XRechnung/ZUGFeRD | EUR 7 a month, plus a DUO contract | No | No |
| Trade ERPs: [Plancraft](https://plancraft.com/de-de/preise), [ToolTime](https://www.tooltime.app/preise), [Das Programm](https://das-programm.io/preise), [HERO](https://hero-software.de/preise) | Quotes, jobs and invoices for trades | EUR 39.90-345 a month | No | No |
| [easybill](https://www.easybill.de/preise), [Billomat](https://www.billomat.com/preise) | Invoicing with XRechnung/ZUGFeRD | EUR 9-119 a month | No | No |
| [W System](https://wsystem.dev/pricing) (x402) | Validate and create EN 16931/XRechnung, pay per call in USDC on Base | USD 0.03 validate, USD 0.08 create | No (EN 16931 rules only) | No. Peppol plans charge on delivery, not on acceptance |
| [Apify e-rechnung-pruefer](https://apify.com/app-to-go/e-rechnung-pruefer) | KoSIT 1.6.3 as a service | USD 0.004 per invoice | No | n/a |
| [B2Brouter](https://www.b2brouter.net/de/preise), [Recommand](https://recommand.eu/en/pricing) | Peppol access | free basic; EUR 0.30 per document | No | No |
| [KoSIT validator](https://github.com/itplr-kosit/validator), Mustang | Open-source validators | free | n/a | n/a |

We looked at 33 products and could read the pages of 29. Storecove and Banqup prices could not be read; two smaller converter sites were offline.

**Our difference.**
1. **The buyer runs the test, not the converter.** The acceptance profile is hashed and pinned in the escrow before money moves. The converter cannot change the test after the lock.
2. **The converter is paid only after acceptance.** A defect freezes the money in the escrow until the converter cures it.
3. **The test checks the recipient's own rules,** not only EN 16931.
4. **The verifier is open.** Any converter, an incumbent included, can sell into the same test.

Among the 29 products whose pages we could read, none offered 1, 2 or 3.

**Moat (honest).**
- The code is open source and is not a moat. A competitor can rebuild the validation in weeks.
- What could become one:
  - **Recipient profiles.** Each GC profile serves every subcontractor that bills that GC, and a subcontractor that bills five GCs needs five profiles. Once GCs publish their profile with us, a new converter has to match it.
  - **The acceptance record.** A dated, hash-pinned protocol per invoice, kept as the subcontractor's evidence of when a proper invoice arrived. Its legal weight is untested.
  - **Distribution through GCs.**

**Risks.**

| Risk | What we know |
|---|---|
| Price floor | Free tools exist, and Lexware Office includes e-invoices from EUR 7.90 a month. |
| Cheap x402 competition | W System validates for USD 0.03 a call. |
| Weaker VAT argument | The BMF states that BT-10 errors are irrelevant for VAT, and that business-rule errors do not void an e-invoice (§1). |
| Mandate delay | ZDH lobbying for a one-year delay for firms above EUR 800k. |
| ADA price | Chain fees are paid in ADA. |
| Sokosumi revenue share | Unknown. |
| All-or-nothing batch escrow | The V2 escrow releases or refunds the whole batch (§4). |
| Unproven demand | GC adoption has not been tested. |
| Wrong extraction | The LLM can extract wrongly; the checks catch errors only in the fields they pin. |
| Tax-advice rules | StBerG questions are open (§6). |
| Team | A single founder. |

---

## 8. Roadmap

| Step | What | Dependency |
|---|---|---|
| 1. Mainnet | Monthly batch escrow; public agent endpoints; extended recipient profile fields (BT-13 order number, BT-19 cost centre, §48b certificate). | The settlement stablecoin: Masumi's docs name **USDCx** as the mainnet stablecoin ([Masumi](https://www.masumi.network/dev/masumi/core-concepts/tokens)), while almost all live registry prices are still in USDM. We follow what Sokosumi pays out. |
| 2. Delivery | E-mail to the AP inbox first: 93.4% of trades businesses receive e-invoices by e-mail and 0.3% by Peppol (ZDH survey). Peppol later, through an access point partner (B2Brouter, Recommand). | none |
| 3. ZUGFeRD hybrid | STRABAG takes PDF or ZUGFeRD by e-mail, and XRechnung only through a separately agreed channel. Max Bögl takes ZUGFeRD with the XML as the leading file. Hybrid output is needed for some GCs. | `@e-invoice-eu/core` renders ZUGFeRD formats |
| 4. Recipient-profile network | GCs publish and sign their profiles; the hash of each profile version is registered; converters compete on the same test. | GC adoption |
| 5. Upstream cost work | Reference scripts and cross-customer batching in the Masumi Payment Service (§5). | Masumi maintainers |
| 6. "Fällig" | The same state machine escrows the invoice amount itself. The legal hook: under [§650g Abs. 4 BGB](https://www.gesetze-im-internet.de/bgb/__650g.html) a final invoice counts as reviewable unless the client raises a reasoned objection within 30 days. | **A EUR e-money token on Cardano:** none is listed among the 87 Cardano tokens in [CoinGecko's coin list](https://api.coingecko.com/api/v3/coins/list?include_platform=true), and EURC is listed on 10 other chains but not on Cardano. **Licensing:** BaFin counts escrow services that take in purchase prices as money remittance ([BaFin ZAG Merkblatt](https://www.bafin.de/SharedDocs/Veroeffentlichungen/DE/Merkblatt/mb_111222_zag.html)); the route is a licensed payment institution that holds the funds. |

---

## 9. Regulatory and trust

- **Archiving (GoBD).**
  - Invoices must be kept for 8 years since the Fourth Bureaucracy Relief Act took effect on 1 Jan 2025 ([§147 Abs. 3 AO](https://www.gesetze-im-internet.de/ao_1977/__147.html), [§14b UStG](https://www.gesetze-im-internet.de/ustg_1980/__14b.html)).
  - The structured part must be kept "unversehrt in seiner ursprünglichen Form" (BMF 2025, Rn. 60).
  - Abnahme hands over the original XML, its sha256 and the acceptance protocol. Archiving stays with the customer or its accounting tool.
  - Only 34.5% of trades firms in the ZDH survey use a GoBD-compliant archive system, which is a partner opportunity.
- **Data protection (DSGVO).**
  - Invoice text contains personal data: names, contacts and IBANs.
  - Anthropic's Data Processing Addendum is part of its Commercial Terms and includes the EU Standard Contractual Clauses ([DPA](https://www.anthropic.com/legal/data-processing-addendum)).
  - **Anthropic's own API offers no EU-only processing.** Inference geography is "us" or "global" only ([data residency](https://platform.claude.com/docs/en/manage-claude/data-residency)).
  - AWS Bedrock has EU cross-region profiles that route within EU regions. We verified this for Claude Sonnet 5.5 ([AWS](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5-5.html)), not yet for Opus 5.5.
  - EU processing is therefore a deployment decision before the first customer. The deterministic parser needs no LLM for structured inputs.
  - **On chain, only hashes are published.** The internal review found that the SENDEN `input_hash` equals `sha256("SENDEN AR-2026-0087")`, so invoice numbers can be guessed from the chain (`audit/raw/part2-forensics.md`). The input must be salted before mainnet.
- **Payment licensing (ZAG).**
  - We escrow only the **agent fee**, never invoice amounts. In the agent hop, our buyer agent pays a converter from our own funds, so we are the payer, not an intermediary for third parties' money. On Sokosumi, Sokosumi is the payer.
  - BaFin treats escrow services that take in third parties' purchase prices as Finanztransfergeschäft ([§1 Abs. 1 S. 2 Nr. 6 ZAG](https://www.gesetze-im-internet.de/zag_2018/__1.html), [BaFin](https://www.bafin.de/SharedDocs/Veroeffentlichungen/DE/Merkblatt/mb_111222_zag.html)). That is why "Fällig" needs a licensed partner.
  - A legal opinion on the fee escrow is still budgeted (§11).
- **Liability.**
  - Our promise is narrow: the delivered invoice passed the pinned test, identified by its profile hash. It is not a promise that the invoice is correct for tax purposes, or that the GC will pay.
  - The BMF says the recipient must still check the invoice (BMF 2025, Rn. 35a).
  - On-chain "acceptance" is acceptance of the conversion service between agents. It is not the legal acceptance (Abnahme) of the construction work.
  - Terms of service and professional liability insurance are still to be done.

---

## 10. Traction from the hackathon (facts only)

The build ran from Fri 30 Oct 09:00 to Sat 31 Oct 15:00, on Cardano preprod (test network, no real money). There are **no customers, no pilots and no letters of intent**.

| Fact | Value | How to check |
|---|---|---|
| Preprod transactions referenced in the repo | **97 confirmed**: agent registrations, escrow actions, x402 payments and wallet top-ups; 57.2 tADA in fees in total | Every transaction hash in `README.md`, `plan/EVIDENCE.md` and `plan/SOKOSUMI.md`, queried on Koios `tx_info` on 30 Oct 2026 |
| Escrow runs recorded | 16 run logs: 13 accepted, 2 refused, 1 failed on purpose (an injected fault; the money stayed frozen in `Disputed`) | [`plan/EVIDENCE.md`](../plan/EVIDENCE.md) |
| Refuse → cure → accept on the Masumi V2 escrow | 8 min 9 s from payment request to `Withdrawn` | `a57c43ee…` to `8f21ca18…` |
| Paid Sokosumi Task | Paid in credits. Sokosumi's own wallet locked 1 tUSDM for our Coworker, which withdrew it after the deadline. | `d9c69f50…`, `5d61bf3f…` |
| Agents on the Masumi registry | 2 (RechnungsMeister, Abnahme-Büro). Both entries point to `127.0.0.1`, so they are not reachable from outside. | `8548d4f7…`, `f63a51dc…` |
| Tests | 261: 260 pass, 1 optional LLM test skipped. Re-run on 30 Oct 2026 against a live KoSIT 1.6.3; CI runs them on every push. | `npm test` |
| Internal security review (not a third-party audit) | 2 parts, 14 review tracks, **147 findings**: 6 high, 38 medium, 73 low, 30 info. Two refuters challenged each high and medium finding, and all 44 stood. Two fix rounds followed, each fix with a regression test. | `audit/raw/part1-result.json`, `audit/raw/part2-result.json` |
| Upstream contribution | Bug in the Masumi Payment Service 0.28.0-0.30.0: V2 refunds after a seller-authorised refund never run automatically. Issue [#1327](https://github.com/masumi-network/masumi-payment-service/issues/1327) and fix [PR #1328](https://github.com/masumi-network/masumi-payment-service/pull/1328), both open on 30 Oct 2026. | GitHub |

What the demo does not prove:
- The first-pass defect is seeded on purpose.
- The team runs every agent.
- Mailpit stands in for the GC's inbox.
- No single recorded run covers the whole flow from Sokosumi to the e-mail.

The full list is in the [README](../README.md#what-this-proves-and-what-it-doesnt).

---

## 11. Team and the ask

**Team:** Ömür Altunbey, Founder.

**The ask: [TEAM FILLS: amount] pre-seed, for [TEAM FILLS: months] of runway.**

The suggestion below is for illustration. Every line is an assumption for the team to replace.

| Use of funds (suggestion, est.) | EUR | Assumption |
|---|---|---|
| Founder salary, 18 months | [TEAM FILLS] | |
| First hire: senior engineer (Cardano / Masumi Payment Service, e-invoicing), from month 1 | ~135,000 | EUR 90k a year fully loaded, 18 months |
| Second hire: customer success and sales with a construction background, from month 6 | ~90,000 | EUR 75k a year fully loaded, 12 months |
| Legal opinions: ZAG (fee escrow), StBerG (check tool), DSGVO/AVV, terms of service | ~40,000 | estimate |
| Pilots with 3 GCs and their subcontractors in Munich; Sokosumi listing; chamber events | ~60,000 | estimate |
| Infrastructure, chain fees, LLM, insurance | ~25,000 | EUR 240 a month of infrastructure (§5), plus insurance and chain float |
| Buffer | ~50,000 | about 10-15% |

**Milestones the money should buy** (suggestion):
1. Mainnet launch with the monthly batch escrow, before the 1 Jan 2027 deadline or as close to it as possible.
2. Signed recipient profiles from 3 GCs.
3. 300 paying subcontractors.
4. A measured bounce rate before and after Abnahme.
5. A confirmed Sokosumi revenue share.

---

### Method and sources

- **Fetch dates.** Web sources were fetched on 30 Oct 2026. bundesfinanzministerium.de blocked direct fetches, so the BMF letters of 2024 and 2026 were read as copies hosted by ZDH, and the 2025 letter from a mirror of the BMF file.
- **Chain data.** Transaction fees come from Koios `tx_info` on preprod. Mainnet fee parameters come from Koios `cli_protocol_params`.
- **Token counts.** Measured with Anthropic's `count_tokens` endpoint. It is free, so no model output was generated.
- **Not legal advice.** Statements of law are our reading of the cited texts.
