# Gutachter: x402 KoSIT inspection, 1 tADA per call (Cardano preprod)

An x402 seller (`seller.mjs`) and a buyer (`buy.mjs`), based on the Cardano Foundation
[x402-express template](https://developers.cardano.org/templates/x402-express/) with its pinned
packages (`@x402/*` 2.26.0, `@evolution-sdk/evolution` 0.5.14). Payments are verified and settled by
the Cardano Foundation hosted preprod facilitator, `https://x402.preprod.dev.ecosyseng.cf-deployments.org`.

```text
buy.mjs ── POST /inspect (XML) ──────────► seller.mjs                 (no payment: 402 + requirements)
buy.mjs:   signs a 1 tADA preprod tx (spend cap 1 tADA per payment, 20 charged payments per rolling 24 h)
buy.mjs ── POST /inspect + PAYMENT-SIGNATURE ► seller.mjs ─ /verify ─► facilitator
                                              seller.mjs ─ XML ─────► KoSIT daemon (200 accept / 406 reject)
                                              seller.mjs ─ /settle ─► facilitator ─► chain
buy.mjs ◄─ 200 {verdict, httpStatus, report} + PAYMENT-RESPONSE (tx hash)
```

## Run

Node 24 (`export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`). No script loads the whole `../.env`: `npm run seller` loads
`../.local/env/gutachter-seller.env` (no secrets; the seller refuses to start if it holds one of the project's secrets),
`npm run buy` and `npm run balance` load `../.local/env/gutachter-buyer.env` (buyer mnemonic and Blockfrost only).
Generate both from the repo root with `node scripts/env-split.mjs`, and rerun it after every change to `.env`.

```sh
cd gutachter
npm install
npm run wallet                    # once: appends GUTACHTER_* wallets to ../.env, prints addresses only, then regenerates ../.local/env/
npm run balance                   # buyer balance via Blockfrost (needs about 1.2 tADA per call)
../kosit/start.sh                 # KoSIT daemon on 127.0.0.1:8090 (stream C)
npm run seller                    # terminal 1: Gutachter on 127.0.0.1:4021
npm run buy -- fixtures/xrechnung-ok.xml       # terminal 2: pays 1 tADA, prints ACCEPTABLE + tx hash
npm run buy -- fixtures/xrechnung-no-bt10.xml  # pays 1 tADA, prints REJECT (BR-DE-15)
npm test                          # verdicts, replay ledger, resend, bind host (no chain, no KoSIT, no wallet)
```

Without KoSIT: `GUTACHTER_STUB=1 npm run seller` answers every paid inspection with a fixed ACCEPTABLE.

From code (Büro-Agent): `import {buyInspection} from './gutachter/buy.mjs'`, then
`await buyInspection(xml)` returns `{httpStatus, payer, txHash, verdict, receipt, result}`.

## Endpoint

`POST /inspect`, body = raw XRechnung UBL XML, price 1 tADA (`{amount:'1000000', asset:'lovelace'}`).

| Handler answer | Meaning | Charged? |
| --- | --- | --- |
| 200 `{verdict:'ACCEPTABLE', httpStatus:200, report}` | KoSIT accepted | yes |
| 200 `{verdict:'REJECT', httpStatus:406, report}` | KoSIT rejected; the inspection is complete | yes |
| 400 | body is not XML | no |
| 503 | KoSIT unreachable | no |
| 502 | KoSIT answered something other than 200/406 | no |
| 409 | this payment was already used for a different body | no |

`@x402/express` runs the handler after `/verify` and before `/settle`, buffers the response, and
cancels settlement when the handler status is 400 or higher. So a KoSIT outage returns 503 and
nothing is settled on chain. Every response carries `Cache-Control: no-store` and no `X-Powered-By`. `GET /health` answers `{ok:true}` only; the
config (stub mode, KoSIT and facilitator URLs, payTo) is in the startup log. A 502/503 names the cause only: the KoSIT
URL and KoSIT's raw error page go to the seller log, not to the buyer.

One payment buys one inspection. `ledger.mjs` keeps a file ledger (`.local/ledger.json`, gitignored) keyed by the
payment's canonical tx hash (the nonce may name any input of the tx, in any letter case, so it is not used as the key).
The first paid request binds tx, sha256 of the body and the answer.
A resend of a known payment is answered before the x402 middleware, because the hosted facilitator rejects `/verify`
(`nonce_not_on_chain`) once the tx is in a block. Same body: the stored answer, KoSIT is not called again, with the
stored settle receipt; if the first settle answer was lost (e.g. a 504), the seller calls `/settle` once more for the
stored payment, which the facilitator resumes without broadcasting again. Different body: 409.

## Env (set in `../.env`, delivered through `../.local/env/gutachter-*.env`)

| Var | Default | Used by |
| --- | --- | --- |
| `GUTACHTER_PORT` | `4021` | seller, buyer |
| `GUTACHTER_HOST` | `127.0.0.1` | seller (bind address) |
| `GUTACHTER_LEDGER` | `gutachter/.local/ledger.json` | seller (replay ledger) |
| `GUTACHTER_URL` | `http://localhost:$GUTACHTER_PORT` | buyer |
| `KOSIT_URL` | `http://127.0.0.1:8090/` | seller |
| `GUTACHTER_STUB` | unset (`1` = fixed ACCEPTABLE) | seller |
| `FACILITATOR_URL` | CF hosted preprod facilitator | seller |
| `GUTACHTER_SELLER_ADDRESS` | from `npm run wallet` | seller (payTo, keyless) |
| `GUTACHTER_SELLER_MNEMONIC` | from `npm run wallet` | nobody at runtime (spends the seller's income); in no generated env file, keep it offline |
| `GUTACHTER_BUYER_MNEMONIC`, `GUTACHTER_BUYER_ADDRESS` | from `npm run wallet` | buyer |
| `BLOCKFROST_API_KEY_PREPROD` | required | buyer, balance |
| `GUTACHTER_MAX_PAYMENTS_PER_DAY` | `20` | buyer (refuses to sign more charged payments per rolling 24 h, counted in `payments.log.json`) |

## Wallets (preprod)

- Buyer (payer): `addr_test1qpx5k8hyheckf8z6c9c0mmhneaypgzpuh5xyh9ds535nqe3u6zxsgctw2ew65jmvam34trmc8s7zd7dnvwrqhaesk6xqy9r5xp`
- Seller (payTo): `addr_test1qzmzrgq7ux2zmn2gn8g7ddwnewu2cuwpluxf9aatn6yjeyfv68x94frsck5pt7hgq5pjk7edjxshy5ep46aw09cuex4qg6x5ce`

## Payments

`buy.mjs` signs one payment and writes its tx hash to `payments.log.json` before the first paid send
(`status: 'sent'`). When the answer says the payment may still settle (`settlement_pending`,
`duplicate_settlement`, a receipt without a tx such as a 504 on the facilitator's `/settle`, a 502/504 or a dropped
connection), it resends the SAME signed header with backoff (5 s, x1.5, up to 30 s) for up to 3 minutes and never
signs a new payment. The entry then ends as `settled` (with the verdict), `not-charged` or `unknown`
(check the tx on cardanoscan before paying again).

First payment: [5820e591b57f7baac9ea31818499dc37615a9697032919da83d183a0039ac4a9](https://preprod.cardanoscan.io/transaction/5820e591b57f7baac9ea31818499dc37615a9697032919da83d183a0039ac4a9) (30 Oct 2026, 1 tADA, verdict ACCEPTABLE)

## Limits

- Settlement needs 1 confirmation (the block after the payment's block). In the 30 Oct escrow runs (10:16 and 10:20 UTC)
  that block came 58-121 s after `/settle` started, and the seller answered after about 61 s with a 402 whose receipt
  had no tx, although both payments landed. The hosted facilitator sits behind nginx (default proxy timeout 60 s), so
  this is most likely a gateway timeout on `/settle`. The resend loop above covers it; a buyer that gives up after
  the 3 minutes leaves the entry at `unknown`.
- Budget: `buy.mjs` refuses an offer above 1 tADA and refuses to sign once `payments.log.json` holds 20 payments of the last
  24 h that may have been charged (`sent`, `unknown`, `settled`). The Büro loop then falls back to the local KoSIT daemon.
- `payTo` must be a dedicated receive address: the facilitator accepts any output of at least the price to `payTo`,
  including change, so a `payTo` that also receives the buyer's change would accept a payment that pays nothing.
- The ledger has no expiry. Delete `.local/ledger.json` only when no payment can still be resent.
- Fixtures: `fixtures/xrechnung-ok.xml` is `01.01a-INVOICE_ubl.xml` from the official
  [itplr-kosit/xrechnung-testsuite](https://github.com/itplr-kosit/xrechnung-testsuite);
  `xrechnung-no-bt10.xml` is the same file without `cbc:BuyerReference` (BT-10). `placeholder.xml` is for stub mode only.
  `tx-5820e591.b64` is the signed CBOR of the first paid inspection (public on chain), used by `buy.test.mjs`.
