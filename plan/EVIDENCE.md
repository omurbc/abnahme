
## Escrow run 2026-10-30T09-06-44-587Z-90ef74: ACCEPTED

Fixture `fixtures/b-abschlag-13b-bau-isar.txt`, recipient `bau-isar`, expected 18400.00 EUR, x402 inspection. Finished 2026-10-30T09:15:13.009Z, 8.5 min. Purchase `cmvur06xh001001pgldbav1qu`.
RechnungsMeister demo switches are in its job file (`.local/rechnungsmeister-jobs/`), reported by `/status` as `demo`.

| Step | Time (UTC) | Tx | Explorer |
|---|---|---|---|
| FundsLocked | 2026-10-30T09:08:47.000Z | `a57c43ee103097f67b6650b2db896682ef254fef0c3dcf0f8e03d82cce9d1cab` | https://preprod.cardanoscan.io/transaction/a57c43ee103097f67b6650b2db896682ef254fef0c3dcf0f8e03d82cce9d1cab |
| ResultSubmitted | 2026-10-30T09:09:22.000Z | `20ca2cf5c3a9acc46b89e076a606e6bd4ff094254aa996eafbf9edcb307ead26` | https://preprod.cardanoscan.io/transaction/20ca2cf5c3a9acc46b89e076a606e6bd4ff094254aa996eafbf9edcb307ead26 |
| Disputed | 2026-10-30T09:10:56.000Z | `995c6c489cb537edecdfe565fba78565560c6a6b2ef438fc527a3d6f22669c77` | https://preprod.cardanoscan.io/transaction/995c6c489cb537edecdfe565fba78565560c6a6b2ef438fc527a3d6f22669c77 |
| ResultSubmitted (cure) | 2026-10-30T09:11:47.000Z | `6c63b8f64ae0684b717fc9c4b39dc4ad4edf71aa940d4361d78b14db02476f5c` | https://preprod.cardanoscan.io/transaction/6c63b8f64ae0684b717fc9c4b39dc4ad4edf71aa940d4361d78b14db02476f5c |
| AuthorizeWithdrawal | 2026-10-30T09:13:43.000Z | `4b6d275e39d47fd21f5a70b2c6a7b3115b39f99b281bb3a1fe8b548065047c50` | https://preprod.cardanoscan.io/transaction/4b6d275e39d47fd21f5a70b2c6a7b3115b39f99b281bb3a1fe8b548065047c50 |
| Withdrawn | 2026-10-30T09:14:53.000Z | `8f21ca18ad0aa9ee7e10ac9f9022a47a02e360a33c4329a74d7218dab66d4435` | https://preprod.cardanoscan.io/transaction/8f21ca18ad0aa9ee7e10ac9f9022a47a02e360a33c4329a74d7218dab66d4435 |
| x402 inspection 1 |  | `7dc0c48aeea27ad28af8329a6eab14730aa77756ca1f4e95d6261293034ced60` | https://preprod.cardanoscan.io/transaction/7dc0c48aeea27ad28af8329a6eab14730aa77756ca1f4e95d6261293034ced60 |
| x402 inspection 2 |  | `f846f7980834260f46e297643936ab5f07b2ad27ed4b182f564b1cccdc5c6d9b` | https://preprod.cardanoscan.io/transaction/f846f7980834260f46e297643936ab5f07b2ad27ed4b182f564b1cccdc5c6d9b |

<details><summary>Abnahmeprotokoll</summary>

- Auftrag 2026-10-30T09-06-44-587Z-90ef74: Rechnung für Bau Isar Generalunternehmer GmbH, erwarteter Betrag 18.400,00 €, Prüfprofil 0d799b1362b6…
- Angebot von RechnungsMeister (Auftrag 8ccf6d10-c802-4332-a2aa-cb10a5d68680): 1 tUSDM, Ergebnis bis 10:31, Freigabe ab 10:51. Eingabe-Hash geprüft.
- Kauf an den Masumi Payment Service übergeben; 1 tUSDM wird in der Escrow auf Cardano gesperrt.
- Geld gesperrt (FundsLocked). Warte auf das Ergebnis des RechnungsMeisters.
- Ergebnis auf Cardano eingereicht (ResultSubmitted). Starte die Abnahmeprüfung.
- Prüfung 1 (Gutachter über x402, 1 tADA): Ergebnis-Hash (Datum (Blockfrost)) stimmt, KoSIT abgelehnt.
- Mängel: [BR-AE-02] Bei Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG, Kategorie „AE“) müssen die USt-IdNr. des Verkäufers (BT-31) und die USt-IdNr. des Käufers (BT-48) bzw. dessen Registernummer (BT-47) angegeben sein. [ABN-BT48] Die USt-IdNr. des Käufers (BT-48) fehlt; bei § 13b muss DE287654321 angegeben sein.
- Mängelrüge auf Cardano: Rückerstattung verlangt, die Escrow geht in den Streitfall (Disputed).
- Streitfall bestätigt (Disputed). Das Geld ist eingefroren. Sende das Prüfprotokoll an den RechnungsMeister.
- RechnungsMeister bessert nach (Versuch 2): buyerVatId = DE287654321 (Quelle: input_data.invoiceText).
- Nachbesserung 1 auf Cardano eingereicht. Prüfe erneut.
- Prüfung 2 (Gutachter über x402, 1 tADA): Ergebnis-Hash (Datum (Blockfrost)) stimmt, KoSIT akzeptiert.
- Nachbesserung besteht die Abnahme. Gebe die Zahlung frei (AuthorizeWithdrawal).
- Freigabe auf Cardano beauftragt (cancel-refund-request → AuthorizeWithdrawal).
- Zahlung freigegeben (WithdrawAuthorized). Warte auf die Auszahlung an den RechnungsMeister.
- ABGENOMMEN. Der RechnungsMeister hat die Zahlung aus der Escrow erhalten (Withdrawn).

</details>
### G3 GO/NO-GO (stream D): GO. The V2 dispute → cure → accept loop works on preprod

The run above was started with RechnungsMeister in `DEMO_SEED_DEFECT=1` (disclosed demo mode: BT-48 removed on attempt 1 only).
The cure (`buyerVatId = DE287654321`) was taken verbatim from the invoice text.
Inspections were paid through the x402 Gutachter. Both escrow result hashes were read from the on-chain datum via Blockfrost, not only from MPS.

Independent check (Blockfrost `/txs/{hash}` + `/scripts/datum/{data_hash}`, escrow `addr_test1wzs4e6wc…n37w4g`):

| Tx | Block | Datum state after tx | Datum result_hash |
|---|---|---|---|
| `a57c43ee…` FundsLocked | 5352653 | FundsLocked | empty |
| `20ca2cf5…` SubmitResult | 5352655 | ResultSubmitted | `dae17dd3…` (attempt 1, defective) |
| `995c6c48…` SetRefundRequested | 5352661 | Disputed | `dae17dd3…` |
| `6c63b8f6…` SubmitResult (cure, from Disputed) | 5352662 | Disputed | `f6f07330…` (attempt 2) |
| `4b6d275e…` AuthorizeWithdrawal (MPS `cancel-refund-request`) | 5352667 | WithdrawAuthorized | `f6f07330…` |
| `8f21ca18…` Withdraw (MPS auto-withdraw) | 5352669 | escrow spent | 1 tUSDM output to the RechnungsMeister selling wallet `addr_test1qpdym62f…c92yck` |

All six txs have `valid_contract: true`.

Observed timings (block time, UTC):
- payment request 09:06:44
- FundsLocked 09:08:47 (+2:03)
- ResultSubmitted 09:09:22 (+0:35)
- Disputed 09:10:56 (+1:34)
- cure 09:11:47 (+0:51)
- AuthorizeWithdrawal 09:13:43 (+1:56)
- Withdrawn 09:14:53 (+1:10)

Payment request to Withdrawn: 8 min 9 s. No cooldown wait was needed, because in MPS 0.29.0 each party's action resets the other party's on-chain cooldown to 0.
Deadlines used: payBy +10, submitResult +25, unlock +45, externalDisputeUnlock +65 min.

## Escrow run 2026-10-30T09-17-08-516Z-a0d3cb: REFUSED

Fixture `fixtures/b-abschlag-13b-bau-isar.txt`, recipient `bau-isar`, expected 18400.00 EUR, INSPECT_MODE=local, --follow. Finished 2026-10-30T10:03:19.268Z, 46.2 min. Purchase `cmvurdkvq002g01pgicriw2mh`.
RechnungsMeister demo switches are in its job file (`.local/rechnungsmeister-jobs/`), reported by `/status` as `demo`.

| Step | Time (UTC) | Tx | Explorer |
|---|---|---|---|
| FundsLocked | 2026-10-30T09:19:11.000Z | `06c6c89226fc72a194d98744b6426af7876af3c5a1a868b8a23c6e6e4a5766aa` | https://preprod.cardanoscan.io/transaction/06c6c89226fc72a194d98744b6426af7876af3c5a1a868b8a23c6e6e4a5766aa |
| ResultSubmitted | 2026-10-30T09:19:44.000Z | `e96658ab794f93c2c3b443c62f219fcfffadc37ec8454f32b325c75a8ae185c0` | https://preprod.cardanoscan.io/transaction/e96658ab794f93c2c3b443c62f219fcfffadc37ec8454f32b325c75a8ae185c0 |
| Disputed | 2026-10-30T09:21:16.000Z | `f3ed68bd8c0e685f2473c0ea8600a87e16c2e70f90091d686836fa2d4cf20cbd` | https://preprod.cardanoscan.io/transaction/f3ed68bd8c0e685f2473c0ea8600a87e16c2e70f90091d686836fa2d4cf20cbd |
| ResultSubmitted (cure) | 2026-10-30T09:22:50.000Z | `00082a65c4350bfa1c0be0bd144be15d9ac23afdfa20b4887adf86af77dc9777` | https://preprod.cardanoscan.io/transaction/00082a65c4350bfa1c0be0bd144be15d9ac23afdfa20b4887adf86af77dc9777 |
| AuthorizeRefund | 2026-10-30T09:41:36.000Z | `adbfbd343b66577ede5d40b727d61effe655fbfb09d0f431f043d377d4e34cf3` | https://preprod.cardanoscan.io/transaction/adbfbd343b66577ede5d40b727d61effe655fbfb09d0f431f043d377d4e34cf3 |

<details><summary>Abnahmeprotokoll</summary>

- Auftrag 2026-10-30T09-17-08-516Z-a0d3cb: Rechnung für Bau Isar Generalunternehmer GmbH, erwarteter Betrag 18.400,00 €, Prüfprofil 0d799b1362b6…
- Angebot von RechnungsMeister (Auftrag 5bc49a2c-617a-4b3a-b4ef-687e50b37a1c): 1 tUSDM, Ergebnis bis 10:42, Freigabe ab 11:02. Eingabe-Hash geprüft.
- Kauf an den Masumi Payment Service übergeben; 1 tUSDM wird in der Escrow auf Cardano gesperrt.
- Geld gesperrt (FundsLocked). Warte auf das Ergebnis des RechnungsMeisters.
- Ergebnis auf Cardano eingereicht (ResultSubmitted). Starte die Abnahmeprüfung.
- Prüfung 1 (lokaler KoSIT-Prüfer): Ergebnis-Hash (Datum (Blockfrost)) stimmt NICHT, KoSIT akzeptiert.
- Mängel: [ABN-HASH] Der Hash der gelieferten Daten (ce86910ea912…) stimmt nicht mit dem Hash in der Escrow auf Cardano (641b498c7eaf…) überein.
- Mängelrüge auf Cardano: Rückerstattung verlangt, die Escrow geht in den Streitfall (Disputed).
- Streitfall bestätigt (Disputed). Das Geld ist eingefroren. Sende das Prüfprotokoll an den RechnungsMeister.
- RechnungsMeister bessert nach (Versuch 2).
- Nachbesserung 1 auf Cardano eingereicht. Prüfe erneut.
- Prüfung 2 (lokaler KoSIT-Prüfer): Ergebnis-Hash (Datum (Blockfrost)) stimmt NICHT, KoSIT akzeptiert.
- Mängel: [ABN-HASH] Der Hash der gelieferten Daten (295fa47abec1…) stimmt nicht mit dem Hash in der Escrow auf Cardano (529e0f69ade9…) überein.
- Rechnung abgelehnt. Der RechnungsMeister kann nicht nachbessern (Nachbesserung ausgeschöpft.) und gibt die Rückerstattung frei.
- Escrow noch RefundAuthorized; Beobachtung beendet.

</details>
### Refund path (stream D): money withheld, but the refund is stuck in MPS 0.29.0 automation

The run above was RechnungsMeister in `CHEAT=1` (disclosed demo mode: every submitted result hash differs from the delivered bytes), with `INSPECT_MODE=local`.
What happened:
- The buyer read `result_hash` from the on-chain datum and caught the mismatch on both attempts (`ABN-HASH`).
- It disputed once.
- After the second failed delivery, RechnungsMeister called `POST /payment/authorize-refund`. MPS sent AuthorizeRefund only at 09:41:36. That is the seller on-chain cooldown from the cure tx (about +12.5 min) plus the extra 7-minute `sellerCoolDownTime < now - cooldownTime` guard in `lock-and-query-payments`, about 19 min after the request.
- The seller was never paid. The escrow sits in **RefundAuthorized** with an empty on-chain `result_hash` (checked via Blockfrost datum).

Blocker: the 1 tUSDM is not paid back automatically.
- In MPS tx-sync (`src/services/transactions/tx-sync/tx/index.ts`, `decodedNewContract?.resultHash ?? decodedOldContract.resultHash`; same code in 0.30.0 and main), the database keeps the old `resultHash` after AuthorizeRefund clears it on chain.
- Auto-refund (`automatic-decisions`) and `collect-refund` both require `resultHash: null`, so `WithdrawRefund` is never queued ("Found V2 auto withdraw refund requests count 0").
- The funds are safe: only the buyer can spend a RefundAuthorized escrow, with no deadline. But collecting them needs an operator action, either a DB correction to match the chain or a hand-built WithdrawRefund tx.
- So the cure → accept path is the one to demo. A refusal currently ends in RefundAuthorized, not RefundWithdrawn.

## Escrow run 2026-10-30T11-50-07-364Z-6cb506: ACCEPTED

Fixture `fixtures/b-abschlag-13b-bau-isar.txt`, recipient `bau-isar`, expected 18400.00 EUR, x402 inspection. Finished 2026-10-30T11:59:08.055Z, 9.0 min. Purchase `cmvuwuaol006m01pggweybsm5`.
RechnungsMeister demo switches are in its job file (`.local/rechnungsmeister-jobs/`), reported by `/status` as `demo`.

| Step | Time (UTC) | Tx | Explorer |
|---|---|---|---|
| FundsLocked | 2026-10-30T11:53:06.000Z | `470f87f0e958b03880e2b9f70b3d17de559bfdffc06e87987679c4cbccaf78cd` | https://preprod.cardanoscan.io/transaction/470f87f0e958b03880e2b9f70b3d17de559bfdffc06e87987679c4cbccaf78cd |
| ResultSubmitted | 2026-10-30T11:54:09.000Z | `1cc604a50e62dc851c5174663659317a463020306f12af4aafbb54bcf8e87caa` | https://preprod.cardanoscan.io/transaction/1cc604a50e62dc851c5174663659317a463020306f12af4aafbb54bcf8e87caa |
| Disputed | 2026-10-30T11:55:10.000Z | `00427fcc32ccc56ea8f2bbc6f3557c9d00eedc2e8a19195c6acd3429d69314ba` | https://preprod.cardanoscan.io/transaction/00427fcc32ccc56ea8f2bbc6f3557c9d00eedc2e8a19195c6acd3429d69314ba |
| ResultSubmitted (cure) | 2026-10-30T11:55:52.000Z | `98e643d850707b51fedd1a838dfbd44683b4dfd9d071f61495753c42544aa134` | https://preprod.cardanoscan.io/transaction/98e643d850707b51fedd1a838dfbd44683b4dfd9d071f61495753c42544aa134 |
| AuthorizeWithdrawal | 2026-10-30T11:58:16.000Z | `e0693e65daeb2e03be6eaa5936c595f0ae9fdb5db9d12a9636ae10be77a561a6` | https://preprod.cardanoscan.io/transaction/e0693e65daeb2e03be6eaa5936c595f0ae9fdb5db9d12a9636ae10be77a561a6 |
| Withdrawn | 2026-10-30T11:58:51.000Z | `49fa546bc27f522e70b48cfe68742e44be98eb1dd7da41065aff09a00e2432f7` | https://preprod.cardanoscan.io/transaction/49fa546bc27f522e70b48cfe68742e44be98eb1dd7da41065aff09a00e2432f7 |
| x402 inspection 1 |  | `4991bca3b5c973dc74fdfe3ec8761620a5ec44e9efa6480d4c96907806af3743` | https://preprod.cardanoscan.io/transaction/4991bca3b5c973dc74fdfe3ec8761620a5ec44e9efa6480d4c96907806af3743 |
| x402 inspection 2 |  | `138b9c0a11d991f1306277a23e2273bcd60ac5c75d92e9944df4d24684714a4e` | https://preprod.cardanoscan.io/transaction/138b9c0a11d991f1306277a23e2273bcd60ac5c75d92e9944df4d24684714a4e |

<details><summary>Abnahmeprotokoll</summary>

- Auftrag 2026-10-30T11-50-07-364Z-6cb506: Rechnung für Bau Isar Generalunternehmer GmbH, erwarteter Betrag 18.400,00 €, Prüfprofil 64a8294cadfa…
- Angebot von RechnungsMeister (Auftrag de5e4180-6059-4487-9451-c7b51c386805): 1 tUSDM, Ergebnis bis 13:15, Freigabe ab 13:35. Eingabe-Hash geprüft.
- Kauf an den Masumi Payment Service übergeben; 1 tUSDM wird in der Escrow auf Cardano gesperrt.
- Geld gesperrt (FundsLocked). Warte auf das Ergebnis des RechnungsMeisters.
- Ergebnis auf Cardano eingereicht (ResultSubmitted). Starte die Abnahmeprüfung.
- Prüfung 1 (Gutachter über x402, 1 tADA): Ergebnis-Hash (Datum (Blockfrost)) stimmt, KoSIT abgelehnt.
- Mängel: [BR-AE-02] Bei Steuerschuldnerschaft des Leistungsempfängers (Kategorie „AE“) müssen beim Verkäufer die USt-IdNr. (BT-31), die Steuernummer (BT-32) oder die USt-IdNr. des Steuervertreters (BT-63) und beim Käufer die USt-IdNr. (BT-48) oder die Registernummer (BT-47) angegeben sein. [ABN-BT48] Die USt-IdNr. des Käufers (BT-48) fehlt; bei § 13b muss DE287654321 angegeben sein.
- Mängelrüge auf Cardano: Rückerstattung verlangt, die Escrow geht in den Streitfall (Disputed).
- Streitfall bestätigt (Disputed). Das Geld ist eingefroren. Sende das Prüfprotokoll an den RechnungsMeister.
- RechnungsMeister bessert nach (Versuch 2): buyerVatId = DE287654321 (Quelle: input_data.invoiceText).
- Nachbesserung 1 auf Cardano eingereicht. Prüfe erneut.
- Prüfung 2 (Gutachter über x402, 1 tADA): Ergebnis-Hash (Datum (Blockfrost)) stimmt, KoSIT akzeptiert.
- Nachbesserung besteht die Abnahme. Gebe die Zahlung frei (AuthorizeWithdrawal).
- Freigabe auf Cardano beauftragt (cancel-refund-request → AuthorizeWithdrawal).
- Zahlung freigegeben (WithdrawAuthorized). Warte auf die Auszahlung an den RechnungsMeister.
- ABGENOMMEN. Der RechnungsMeister hat die Zahlung aus der Escrow erhalten (Withdrawn).

</details>

## Escrow run 2026-10-30T12-02-48-533Z-bbebcd: ACCEPTED

Fixture `/tmp/abnahme-audit/p2-live/s5-b-var-B.txt`, recipient `bau-isar`, expected 18400.00 EUR, INSPECT_MODE=local. Finished 2026-10-30T12:09:47.354Z, 7.0 min. Purchase `cmvuxamb8008h01pg1vqcde08`.
RechnungsMeister demo switches are in its job file (`.local/rechnungsmeister-jobs/`), reported by `/status` as `demo`.

| Step | Time (UTC) | Tx | Explorer |
|---|---|---|---|
| FundsLocked | 2026-10-30T12:03:29.000Z | `ca06594e2f7d2ba12edf9da6442372eaf629e4f5b331c20655a98f235a027e6b` | https://preprod.cardanoscan.io/transaction/ca06594e2f7d2ba12edf9da6442372eaf629e4f5b331c20655a98f235a027e6b |
| ResultSubmitted | 2026-10-30T12:05:03.000Z | `ab08b94cb663e92399beec48594e9553ddbb57e056a7e6399f5712ef04e82f5c` | https://preprod.cardanoscan.io/transaction/ab08b94cb663e92399beec48594e9553ddbb57e056a7e6399f5712ef04e82f5c |
| Disputed | 2026-10-30T12:06:09.000Z | `fa102762c795d0e4e66ce1e9578dd101e8fcb415f63b518016def75845d871a1` | https://preprod.cardanoscan.io/transaction/fa102762c795d0e4e66ce1e9578dd101e8fcb415f63b518016def75845d871a1 |
| ResultSubmitted (cure) | 2026-10-30T12:07:41.000Z | `2f4d4a005da09fbd00e43836fdd4a32adcc951e2624f2123c68a81548dbe2780` | https://preprod.cardanoscan.io/transaction/2f4d4a005da09fbd00e43836fdd4a32adcc951e2624f2123c68a81548dbe2780 |
| AuthorizeWithdrawal | 2026-10-30T12:08:30.000Z | `062923aa93a02d1e30ad36f042ea2e51603c31d5d01a1bfab02a100a9cb875a6` | https://preprod.cardanoscan.io/transaction/062923aa93a02d1e30ad36f042ea2e51603c31d5d01a1bfab02a100a9cb875a6 |
| Withdrawn | 2026-10-30T12:09:26.000Z | `53666e4a0e87ef50fb5c0db1b63f827fe4a3c004296c1e1c69f2e1a2418e933f` | https://preprod.cardanoscan.io/transaction/53666e4a0e87ef50fb5c0db1b63f827fe4a3c004296c1e1c69f2e1a2418e933f |

<details><summary>Abnahmeprotokoll</summary>

- Auftrag 2026-10-30T12-02-48-533Z-bbebcd: Rechnung für Bau Isar Generalunternehmer GmbH, erwarteter Betrag 18.400,00 €, Prüfprofil 64a8294cadfa…
- Angebot von RechnungsMeister (Auftrag 177eb24f-7ad4-40b4-be0d-17a8881d41bc): 1 tUSDM, Ergebnis bis 13:27, Freigabe ab 13:47. Eingabe-Hash geprüft.
- Kauf an den Masumi Payment Service übergeben; 1 tUSDM wird in der Escrow auf Cardano gesperrt.
- Geld gesperrt (FundsLocked). Warte auf das Ergebnis des RechnungsMeisters.
- Ergebnis auf Cardano eingereicht (ResultSubmitted). Starte die Abnahmeprüfung.
- Prüfung 1 (lokaler KoSIT-Prüfer): Ergebnis-Hash (Datum (Blockfrost)) stimmt NICHT, KoSIT abgelehnt.
- Mängel: [ABN-HASH] Der Hash der gelieferten Daten (4a8888d16b0a…) stimmt nicht mit dem Hash in der Escrow auf Cardano (65c5c247d775…) überein. [ABN-HASH] Der Ergebnis-Hash im Datum auf Cardano weicht vom Stand des Payment Service ab. [BR-AE-02] Bei Steuerschuldnerschaft des Leistungsempfängers (Kategorie „AE“) müssen beim Verkäufer die USt-IdNr. (BT-31), die Steuernummer (BT-32) oder die USt-IdNr. des Steuervertreters (BT-63) und beim Käufer die USt-IdNr. (BT-48) oder die Registernummer (BT-47) angegeben sein. [ABN-BT48] Die USt-IdNr. des Käufers (BT-48) fehlt; bei § 13b muss DE287654321 angegeben sein.
- Mängelrüge auf Cardano: Rückerstattung verlangt, die Escrow geht in den Streitfall (Disputed).
- Streitfall bestätigt (Disputed). Das Geld ist eingefroren. Sende das Prüfprotokoll an den RechnungsMeister.
- RechnungsMeister bessert nach (Versuch 2): buyerVatId = DE287654321 (Quelle: input_data.invoiceText).
- Nachbesserung 1 auf Cardano eingereicht. Prüfe erneut.
- Prüfung 2 (lokaler KoSIT-Prüfer): Ergebnis-Hash (Datum (Blockfrost)) stimmt, KoSIT akzeptiert.
- Nachbesserung besteht die Abnahme. Gebe die Zahlung frei (AuthorizeWithdrawal).
- Freigabe auf Cardano beauftragt (cancel-refund-request → AuthorizeWithdrawal).
- Zahlung freigegeben (WithdrawAuthorized). Warte auf die Auszahlung an den RechnungsMeister.
- ABGENOMMEN. Der RechnungsMeister hat die Zahlung aus der Escrow erhalten (Withdrawn).

</details>

## Escrow run 2026-10-30T12-02-48-533Z-3fa6cf: ACCEPTED

Fixture `/tmp/abnahme-audit/p2-live/s5-b-var-A.txt`, recipient `bau-isar`, expected 18400.00 EUR, INSPECT_MODE=local. Finished 2026-10-30T12:10:57.951Z, 8.2 min. Purchase `cmvuxama0008c01pgtgbg2u56`.
RechnungsMeister demo switches are in its job file (`.local/rechnungsmeister-jobs/`), reported by `/status` as `demo`.

| Step | Time (UTC) | Tx | Explorer |
|---|---|---|---|
| FundsLocked | 2026-10-30T12:03:29.000Z | `ca06594e2f7d2ba12edf9da6442372eaf629e4f5b331c20655a98f235a027e6b` | https://preprod.cardanoscan.io/transaction/ca06594e2f7d2ba12edf9da6442372eaf629e4f5b331c20655a98f235a027e6b |
| ResultSubmitted | 2026-10-30T12:05:03.000Z | `ab08b94cb663e92399beec48594e9553ddbb57e056a7e6399f5712ef04e82f5c` | https://preprod.cardanoscan.io/transaction/ab08b94cb663e92399beec48594e9553ddbb57e056a7e6399f5712ef04e82f5c |
| Disputed | 2026-10-30T12:07:41.000Z | `f2fdd26ae2cf901edb2420b8bcd9ea2f0eefc7873f9e79280485dd9292a50507` | https://preprod.cardanoscan.io/transaction/f2fdd26ae2cf901edb2420b8bcd9ea2f0eefc7873f9e79280485dd9292a50507 |
| ResultSubmitted (cure) | 2026-10-30T12:08:30.000Z | `842af98d3362325364d870a6fed24ca29d8bc49a92075a37d26df317141ab8f2` | https://preprod.cardanoscan.io/transaction/842af98d3362325364d870a6fed24ca29d8bc49a92075a37d26df317141ab8f2 |
| AuthorizeWithdrawal | 2026-10-30T12:09:26.000Z | `c218266b414f0b326f45d2f74dce1c1b9d20f25b6c1b13a818b307cb2061c537` | https://preprod.cardanoscan.io/transaction/c218266b414f0b326f45d2f74dce1c1b9d20f25b6c1b13a818b307cb2061c537 |
| Withdrawn | 2026-10-30T12:10:36.000Z | `f0f5bbb94c370ebe23de8edc0b4840832ccecf41260eefaee650211976392b7f` | https://preprod.cardanoscan.io/transaction/f0f5bbb94c370ebe23de8edc0b4840832ccecf41260eefaee650211976392b7f |

<details><summary>Abnahmeprotokoll</summary>

- Auftrag 2026-10-30T12-02-48-533Z-3fa6cf: Rechnung für Bau Isar Generalunternehmer GmbH, erwarteter Betrag 18.400,00 €, Prüfprofil 64a8294cadfa…
- Angebot von RechnungsMeister (Auftrag 8c86b8e4-9ba2-46e4-85dc-d9cafbc61cde): 1 tUSDM, Ergebnis bis 13:27, Freigabe ab 13:47. Eingabe-Hash geprüft.
- Kauf an den Masumi Payment Service übergeben; 1 tUSDM wird in der Escrow auf Cardano gesperrt.
- Geld gesperrt (FundsLocked). Warte auf das Ergebnis des RechnungsMeisters.
- Ergebnis auf Cardano eingereicht (ResultSubmitted). Starte die Abnahmeprüfung.
- Prüfung 1 (lokaler KoSIT-Prüfer): Ergebnis-Hash (Datum (Blockfrost)) stimmt, KoSIT abgelehnt.
- Mängel: [BR-AE-02] Bei Steuerschuldnerschaft des Leistungsempfängers (Kategorie „AE“) müssen beim Verkäufer die USt-IdNr. (BT-31), die Steuernummer (BT-32) oder die USt-IdNr. des Steuervertreters (BT-63) und beim Käufer die USt-IdNr. (BT-48) oder die Registernummer (BT-47) angegeben sein. [ABN-BT48] Die USt-IdNr. des Käufers (BT-48) fehlt; bei § 13b muss DE287654321 angegeben sein.
- Mängelrüge auf Cardano: Rückerstattung verlangt, die Escrow geht in den Streitfall (Disputed).
- Streitfall bestätigt (Disputed). Das Geld ist eingefroren. Sende das Prüfprotokoll an den RechnungsMeister.
- RechnungsMeister bessert nach (Versuch 2): buyerVatId = DE287654321 (Quelle: input_data.invoiceText).
- Nachbesserung 1 auf Cardano eingereicht. Prüfe erneut.
- Prüfung 2 (lokaler KoSIT-Prüfer): Ergebnis-Hash (Datum (Blockfrost)) stimmt, KoSIT akzeptiert.
- Nachbesserung besteht die Abnahme. Gebe die Zahlung frei (AuthorizeWithdrawal).
- Freigabe auf Cardano beauftragt (cancel-refund-request → AuthorizeWithdrawal).
- Zahlung freigegeben (WithdrawAuthorized). Warte auf die Auszahlung an den RechnungsMeister.
- ABGENOMMEN. Der RechnungsMeister hat die Zahlung aus der Escrow erhalten (Withdrawn).

</details>

## Escrow run 2026-10-30T11-46-39-564Z-4debad: ACCEPTED

Fixture `fixtures/a-reparatur-hv-giesing.txt`, recipient `hv-giesing`, expected 527.17 EUR, INSPECT_MODE=local, --follow. Finished 2026-10-30T12:42:22.336Z, 55.7 min. Purchase `cmvuwpud2006301pggjrwlw6q`.
RechnungsMeister demo switches are in its job file (`.local/rechnungsmeister-jobs/`), reported by `/status` as `demo`.

| Step | Time (UTC) | Tx | Explorer |
|---|---|---|---|
| FundsLocked | 2026-10-30T11:48:19.000Z | `bdb84f45e8cf1720bf29cc0adf31d2bc12dbfd7bfd99fc27190aaed12971f253` | https://preprod.cardanoscan.io/transaction/bdb84f45e8cf1720bf29cc0adf31d2bc12dbfd7bfd99fc27190aaed12971f253 |
| ResultSubmitted | 2026-10-30T11:49:18.000Z | `d79cf09e69e5642f0950ddd1ee47a0171aa4ca8d724ec7e5783260b1c918eb61` | https://preprod.cardanoscan.io/transaction/d79cf09e69e5642f0950ddd1ee47a0171aa4ca8d724ec7e5783260b1c918eb61 |
| Withdrawn (deemed acceptance) | 2026-10-30T12:42:00.000Z | `1ec56faf0d1167beb8d7b3b2e6388bd5d3cea39ee86a3a7e5cc7a5d3fdbc3dd1` | https://preprod.cardanoscan.io/transaction/1ec56faf0d1167beb8d7b3b2e6388bd5d3cea39ee86a3a7e5cc7a5d3fdbc3dd1 |

<details><summary>Abnahmeprotokoll</summary>

- Auftrag 2026-10-30T11-46-39-564Z-4debad: Rechnung für Hausverwaltung Giesing GmbH, erwarteter Betrag 527,17 €, Prüfprofil a9c6f943c29d…
- Angebot von RechnungsMeister (Auftrag 84f3bd78-70d7-4e88-ad75-4e4d241ff5c2): 1 tUSDM, Ergebnis bis 13:11, Freigabe ab 13:31. Eingabe-Hash geprüft.
- Kauf an den Masumi Payment Service übergeben; 1 tUSDM wird in der Escrow auf Cardano gesperrt.
- Geld gesperrt (FundsLocked). Warte auf das Ergebnis des RechnungsMeisters.
- Ergebnis auf Cardano eingereicht (ResultSubmitted). Starte die Abnahmeprüfung.
- Prüfung 1 (lokaler KoSIT-Prüfer): Ergebnis-Hash (Datum (Blockfrost)) stimmt, KoSIT akzeptiert.
- ABGENOMMEN. Die Escrow zahlt den RechnungsMeister automatisch nach der Freigabezeit (13:31) aus.
- Escrow abgeschlossen: Withdrawn.

</details>

## Audit part 2: live preprod scenario matrix (2026-10-30, commit beca8f3)

Run by the "Live preprod scenarios" auditor with our own wallets, the running RechnungsMeister (`DEMO_SEED_DEFECT=1`, no `CHEAT`) and the running Gutachter. Full report: `audit/raw/part2-live.md`. Every tx below was checked on Blockfrost (`/txs/{hash}`): all 30 have `valid_contract: true`. The escrow txs were also checked through `/txs/{hash}/utxos` and `/scripts/datum/{hash}`. Times are block times (UTC).

**Correction to the run section `2026-10-30T12-02-48-533Z-bbebcd` above:** its two `[ABN-HASH]` lines are false (audit finding LIVE-1). MPS batched that escrow's SubmitResult with `…3fa6cf`'s into one tx (`ab08b94c…`). The buyer read output #0, which is the other escrow's datum. Its own output #1 holds `4a8888d1…`, which matches the delivery. The dispute was still justified by the seeded BT-48 defect.

| # | Scenario | Result | Key txs | Verdict |
|---|---|---|---|---|
| 1 | Dispute → cure → accept, fixture b, x402 inspections | BR-AE-02 + ABN-BT48 → Disputed → cure (BT-48 from the invoice text) → x402 ACCEPTABLE → AuthorizeWithdrawal → Withdrawn, 9.0 min, one KoSIT call per payment | FundsLocked `470f87f0e958b03880e2b9f70b3d17de559bfdffc06e87987679c4cbccaf78cd`, ResultSubmitted `1cc604a50e62dc851c5174663659317a463020306f12af4aafbb54bcf8e87caa`, Disputed `00427fcc32ccc56ea8f2bbc6f3557c9d00eedc2e8a19195c6acd3429d69314ba`, cure `98e643d850707b51fedd1a838dfbd44683b4dfd9d071f61495753c42544aa134`, AuthorizeWithdrawal `e0693e65daeb2e03be6eaa5936c595f0ae9fdb5db9d12a9636ae10be77a561a6`, Withdrawn `49fa546bc27f522e70b48cfe68742e44be98eb1dd7da41065aff09a00e2432f7`, x402 `4991bca3b5c973dc74fdfe3ec8761620a5ec44e9efa6480d4c96907806af3743`, `138b9c0a11d991f1306277a23e2273bcd60ac5c75d92e9944df4d24684714a4e` | PASS |
| 2 | Lying delivery: bytes differ from the committed `result_hash` (lie injected on the RM → Büro `/status` channel; RM itself cannot lie without `CHEAT=1`) | ABN-HASH against the Blockfrost datum → Disputed → retransmit cure → accepted → Withdrawn, 7.5 min | FundsLocked `ebf5fd3419b3211fa7ba3abd1021d9f9ae2d7031b0db4ece8d524073337ec4d1`, ResultSubmitted `76874ae07bd4121e3180970eaf390e3dfe5be284f503d3ed23d4788b092a2f46`, Disputed `497708fad9402e37617d778e027ff58954d506c5d17c06fb16bdd2da22291155`, cure `448cfb303b48120c65f287b5576b35c8615ded2cfa6f3473b51d4ca5c2b86734`, AuthorizeWithdrawal `3c0ed71fc138475e8b5b6abc6c358addaf241ca98f0f08af2ca65c4c8ebe16e1`, Withdrawn `7c06d4a13873afadafaf4b2b0e7fcfc3f29986fcb092fda6be7803fd173347ac` | PASS |
| 3 | x402 replay of a settled header | Resend with the same body: 200, cached report, same receipt, no new payment. Different body: 409. Duplicate in flight: 402 `settlement_pending`. One on-chain payment | `96d84abddd87ab0f1e2e4841589d28cdf40fc551f4783386000990d2d5ca87b3` | PASS |
| 4 | x402 capped budget (`GUTACHTER_MAX_PAYMENTS_PER_DAY=1`) / empty wallet | Refused before signing, the Büro falls back to local KoSIT; an empty wallet fails in the client. No tx | none | PASS (the cap fails open on a non-numeric value: LIVE-4) |
| 5 | Two concurrent purchases, same purchasing wallet | MPS batched both locks and both SubmitResults; both escrows Withdrawn. Buyer B read A's datum → false ABN-HASH (LIVE-1). A's dispute waited 67 s for the wallet (LIVE-2) | lock `ca06594e2f7d2ba12edf9da6442372eaf629e4f5b331c20655a98f235a027e6b`, SubmitResult `ab08b94cb663e92399beec48594e9553ddbb57e056a7e6399f5712ef04e82f5c`, Disputed `fa102762c795d0e4e66ce1e9578dd101e8fcb415f63b518016def75845d871a1` / `f2fdd26ae2cf901edb2420b8bcd9ea2f0eefc7873f9e79280485dd9292a50507`, cure `2f4d4a005da09fbd00e43836fdd4a32adcc951e2624f2123c68a81548dbe2780` / `842af98d3362325364d870a6fed24ca29d8bc49a92075a37d26df317141ab8f2`, AuthorizeWithdrawal `062923aa93a02d1e30ad36f042ea2e51603c31d5d01a1bfab02a100a9cb875a6` / `c218266b414f0b326f45d2f74dce1c1b9d20f25b6c1b13a818b307cb2061c537`, Withdrawn `53666e4a0e87ef50fb5c0db1b63f827fe4a3c004296c1e1c69f2e1a2418e933f` / `f0f5bbb94c370ebe23de8edc0b4840832ccecf41260eefaee650211976392b7f` | FAIL (verdict wrong, funds correct) |
| 5b | Two concurrent x402 inspections, one-UTxO wallet | Both clients built the identical tx; one settled, the other got 409; one charge | `2e92cf4a4383c062fcbaba5062024554eb6ae289048c03e211d7b6156dff537d` | PASS (log merge: LIVE-5) |
| 6 | Dispute 119.8 s before unlock (after the unlock − 3 min rule) | MPS answered HTTP 200 and never built the tx. The seller was paid at unlock + 10:20. The purchase went `WaitingForManualAction` only after the payout | (escrow of #7) | PASS on chain (LIVE-3) |
| 7 | Deemed acceptance, fixture a, `hv-giesing`, 527.17 | Round 0 accepted at 3.1 min, no further buyer tx; MPS auto-withdrew for RM at unlock + 10:20 | FundsLocked `bdb84f45e8cf1720bf29cc0adf31d2bc12dbfd7bfd99fc27190aaed12971f253`, ResultSubmitted `d79cf09e69e5642f0950ddd1ee47a0171aa4ca8d724ec7e5783260b1c918eb61`, Withdrawn `1ec56faf0d1167beb8d7b3b2e6388bd5d3cea39ee86a3a7e5cc7a5d3fdbc3dd1` | PASS |

Gutachter buyer top-up (20 tADA from the Büro purchasing wallet, `mps/fund.mjs`): `f9380000c10080865a27abbf035b2d27f32292c8ec93f6fd75b6eb37ddde12f1`. Spend: 5 tUSDM moved purchasing → RM selling, 16.60 tADA in fees in total. The RM selling wallet is down to 8.97 tADA: top it up before the final evidence runs (LIVE-6).

## Escrow run 2026-10-30T13-29-14-578Z-0041d9: ACCEPTED

Fixture `/tmp/b-g1-live.txt`, recipient `bau-isar`, expected 18400.00 EUR, x402 inspection, --follow. Finished 2026-10-30T13:39:05.147Z, 9.8 min. Purchase `cmvv0drmb00e001pg5vzg9gl3`.
RechnungsMeister demo switches are in its job file (`.local/rechnungsmeister-jobs/`), reported by `/status` as `demo`.

| Step | Time (UTC) | Tx | Explorer |
|---|---|---|---|
| FundsLocked | 2026-10-30T13:31:18.000Z | `f976004e41eb606041db12f1312d7a267338b4c28ad1bb184189f6c5265b9191` | https://preprod.cardanoscan.io/transaction/f976004e41eb606041db12f1312d7a267338b4c28ad1bb184189f6c5265b9191 |
| ResultSubmitted | 2026-10-30T13:32:57.000Z | `4f50ed76aa5deb493f6107a8bcf07486a37601c68fb83583eb60ef95a4dda049` | https://preprod.cardanoscan.io/transaction/4f50ed76aa5deb493f6107a8bcf07486a37601c68fb83583eb60ef95a4dda049 |
| Disputed | 2026-10-30T13:33:53.000Z | `5f2d1236fab2cc5463fb192f928ae083849180a252d80b17e01cf5d569774e6f` | https://preprod.cardanoscan.io/transaction/5f2d1236fab2cc5463fb192f928ae083849180a252d80b17e01cf5d569774e6f |
| ResultSubmitted (cure) | 2026-10-30T13:35:01.000Z | `b36ed2dbd05d165a31b5c41098aaf20292e96eb88d685ecf48a6721a31a80551` | https://preprod.cardanoscan.io/transaction/b36ed2dbd05d165a31b5c41098aaf20292e96eb88d685ecf48a6721a31a80551 |
| AuthorizeWithdrawal | 2026-10-30T13:38:02.000Z | `b65e79d1de603bf7b62e31fcd5d4b78562871fe8c2b9e97f395b7ff0b8366600` | https://preprod.cardanoscan.io/transaction/b65e79d1de603bf7b62e31fcd5d4b78562871fe8c2b9e97f395b7ff0b8366600 |
| Withdrawn | 2026-10-30T13:38:50.000Z | `239c0dab2b87be3ece943b840dd63c6d5d85274c736b973d808d47a8f085541c` | https://preprod.cardanoscan.io/transaction/239c0dab2b87be3ece943b840dd63c6d5d85274c736b973d808d47a8f085541c |
| x402 inspection 1 |  | `6c2b9e77358f07a8d3c94baf95a3e20ceeed86d3b04b320703048b2a156311a9` | https://preprod.cardanoscan.io/transaction/6c2b9e77358f07a8d3c94baf95a3e20ceeed86d3b04b320703048b2a156311a9 |
| x402 inspection 2 |  | `caa5f314453d928794e5e169e73cc8cbcdcf7e6a533c0aeb95210cf57e126eac` | https://preprod.cardanoscan.io/transaction/caa5f314453d928794e5e169e73cc8cbcdcf7e6a533c0aeb95210cf57e126eac |

<details><summary>Abnahmeprotokoll</summary>

- Auftrag 2026-10-30T13-29-14-578Z-0041d9: Rechnung für Bau Isar Generalunternehmer GmbH, erwarteter Betrag 18.400,00 €, Prüfprofil 64a8294cadfa…
- Angebot von RechnungsMeister (Auftrag fa86a275-225b-489d-9007-484ad1276dd4): 1 tUSDM, Ergebnis bis 14:54, Freigabe ab 15:14. Eingabe-Hash geprüft.
- Kauf an den Masumi Payment Service übergeben; 1 tUSDM wird in der Escrow auf Cardano gesperrt.
- Geld gesperrt (FundsLocked). Der RechnungsMeister liest jetzt die Rechnung aus und erstellt die XRechnung; warte auf das Ergebnis.
- Ergebnis auf Cardano eingereicht (ResultSubmitted). Starte die Abnahmeprüfung.
- Prüfung 1 (Gutachter über x402, 1 tADA): Ergebnis-Hash (Datum (Blockfrost)) stimmt, KoSIT abgelehnt.
- Mängel: [BR-AE-02] Bei Steuerschuldnerschaft des Leistungsempfängers (Kategorie „AE“) müssen beim Verkäufer die USt-IdNr. (BT-31), die Steuernummer (BT-32) oder die USt-IdNr. des Steuervertreters (BT-63) und beim Käufer die USt-IdNr. (BT-48) oder die Registernummer (BT-47) angegeben sein. [ABN-BT48] Die USt-IdNr. des Käufers (BT-48) fehlt; bei § 13b muss DE287654321 angegeben sein.
- Mängelrüge auf Cardano: Rückerstattung verlangt, die Escrow geht in den Streitfall (Disputed).
- Streitfall bestätigt (Disputed). Das Geld ist eingefroren. Sende das Prüfprotokoll an den RechnungsMeister.
- RechnungsMeister bessert nach (Versuch 2): buyerVatId = DE287654321 (Quelle: input_data.invoiceText).
- Nachbesserung 1 auf Cardano eingereicht. Prüfe erneut.
- Prüfung 2 (Gutachter über x402, 1 tADA): Ergebnis-Hash (Datum (Blockfrost)) stimmt, KoSIT akzeptiert.
- Nachbesserung besteht die Abnahme. Gebe die Zahlung frei (AuthorizeWithdrawal).
- Freigabe auf Cardano beauftragt (cancel-refund-request → AuthorizeWithdrawal).
- Zahlung freigegeben (WithdrawAuthorized). Warte auf die Auszahlung an den RechnungsMeister.
- ABGENOMMEN. Der RechnungsMeister hat die Zahlung aus der Escrow erhalten (Withdrawn).
- Escrow abgeschlossen: Withdrawn.

</details>
