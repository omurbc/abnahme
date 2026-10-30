# Gutachter: x402 KoSIT inspection, 1 tADA per call (Cardano preprod)

An x402 seller (`seller.mjs`) and a buyer (`buy.mjs`), based on the Cardano Foundation
[x402-express template](https://developers.cardano.org/templates/x402-express/) with its pinned
packages (`@x402/*` 2.26.0, `@evolution-sdk/evolution` 0.5.14). Payments are verified and settled by
the Cardano Foundation hosted preprod facilitator, `https://x402.preprod.dev.ecosyseng.cf-deployments.org`.

```text
buy.mjs ── POST /inspect (XML) ──────────► seller.mjs                 (no payment: 402 + requirements)
buy.mjs:   signs a 1 tADA preprod tx (spend cap 1.5 tADA per payment)
buy.mjs ── POST /inspect + PAYMENT-SIGNATURE ► seller.mjs ─ /verify ─► facilitator
                                              seller.mjs ─ XML ─────► KoSIT daemon (200 accept / 406 reject)
                                              seller.mjs ─ /settle ─► facilitator ─► chain
buy.mjs ◄─ 200 {verdict, httpStatus, report} + PAYMENT-RESPONSE (tx hash)
```

## Run

Node 24 (`export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`). All scripts read `../.env`.

```sh
cd gutachter
npm install
npm run wallet                    # once: appends GUTACHTER_* wallets to ../.env, prints addresses only
npm run balance                   # buyer balance via Blockfrost (needs about 1.2 tADA per call)
../kosit/start.sh                 # KoSIT daemon on 127.0.0.1:8090 (stream C)
npm run seller                    # terminal 1: Gutachter on :4021
npm run buy -- fixtures/xrechnung-ok.xml       # terminal 2: pays 1 tADA, prints ACCEPTABLE + tx hash
npm run buy -- fixtures/xrechnung-no-bt10.xml  # pays 1 tADA, prints REJECT (BR-DE-15)
npm test                          # verdict mapping tests (no chain, no KoSIT)
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

`@x402/express` runs the handler after `/verify` and before `/settle`, buffers the response, and
cancels settlement when the handler status is 400 or higher. So a KoSIT outage returns 503 and
nothing is settled on chain. Every response carries `Cache-Control: no-store`. `GET /health` shows the config.

## Env (`../.env`)

| Var | Default | Used by |
| --- | --- | --- |
| `GUTACHTER_PORT` | `4021` | seller, buyer |
| `GUTACHTER_URL` | `http://localhost:$GUTACHTER_PORT` | buyer |
| `KOSIT_URL` | `http://127.0.0.1:8090/` | seller |
| `GUTACHTER_STUB` | unset (`1` = fixed ACCEPTABLE) | seller |
| `FACILITATOR_URL` | CF hosted preprod facilitator | seller |
| `GUTACHTER_SELLER_ADDRESS` | from `npm run wallet` | seller (payTo, keyless) |
| `GUTACHTER_SELLER_MNEMONIC` | from `npm run wallet` | nobody at runtime (spends the seller's income) |
| `GUTACHTER_BUYER_MNEMONIC`, `GUTACHTER_BUYER_ADDRESS` | from `npm run wallet` | buyer |
| `BLOCKFROST_API_KEY_PREPROD` | required | buyer, balance |

## Wallets (preprod)

- Buyer (payer): `addr_test1qpx5k8hyheckf8z6c9c0mmhneaypgzpuh5xyh9ds535nqe3u6zxsgctw2ew65jmvam34trmc8s7zd7dnvwrqhaesk6xqy9r5xp`
- Seller (payTo): `addr_test1qzmzrgq7ux2zmn2gn8g7ddwnewu2cuwpluxf9aatn6yjeyfv68x94frsck5pt7hgq5pjk7edjxshy5ep46aw09cuex4qg6x5ce`

## Payments

Every settled payment is appended to `payments.log.json` as `{time, txHash, verdict}`.

First payment: _pending (buyer wallet awaiting faucet funding)_

## Limits

- If the facilitator stops waiting before the block lands (`settlement_pending`), the buyer gets a 402
  although the tx may be on chain. Check the payer on preprod.cardanoscan.io before retrying, or it pays twice.
- A paid retry re-runs the handler (KoSIT is side-effect free, so this is safe).
- Fixtures: `fixtures/xrechnung-ok.xml` is `01.01a-INVOICE_ubl.xml` from the official
  [itplr-kosit/xrechnung-testsuite](https://github.com/itplr-kosit/xrechnung-testsuite);
  `xrechnung-no-bt10.xml` is the same file without `cbc:BuyerReference` (BT-10). `placeholder.xml` is for stub mode only.
