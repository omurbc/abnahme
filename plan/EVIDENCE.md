
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
