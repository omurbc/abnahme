# Masumi Payment Service (local, Cardano Preprod)

## Run

Payment Service **0.29.0**, the version that the official dev quickstart pins
(`masumi-network/masumi-services-dev-quickstart` @ 9b48523). The template d93783b dates from 26 Oct, before 0.30.0 came out on 27 Oct.
The compose file is `mps/docker-compose.yml`, taken from that quickstart. It runs the payment service only, without the registry service. Run every command from the repo root:

```sh
mps/mps.sh up -d                    # start (setup container seeds only an empty DB, then exits 0)
mps/mps.sh ps -a                    # abnahme-mps-setup "Exited (0)", service "healthy"
mps/mps.sh rm -f payment-setup      # then: the exited setup container keeps ADMIN_KEY, ENCRYPTION_KEY, Blockfrost and both
                                    # seed mnemonics in its config (docker inspect); the next up recreates it from the image
mps/mps.sh logs -f payment-service
mps/mps.sh down                     # stop, data stays in volume abnahme_mps_pgdata
# NEVER `down -v`: it deletes the encrypted wallets (mnemonics are also in .local/mps-secrets.env)
curl -s http://127.0.0.1:38127/api/v1/health      # {"status":"success","data":{"status":"ok"}}
```

- API: `http://127.0.0.1:38127/api/v1` (= `MPS_URL`), Swagger at `/docs`, admin UI at `/admin`. It listens on loopback only.
- Postgres `abnahme-mps-postgres` is not published on the host. To inspect it: `docker exec -it abnahme-mps-postgres psql -U postgres`.
- The service image is amd64-only and runs under OrbStack/Rosetta. The setup image `masumi-payment-setup:0.29.0` is built locally from the 0.29.0 source.

## Env files per process (audit SECRETS-1)

No process loads the whole `.env`. `node scripts/env-split.mjs` (rerun after every change to `.env` or a key file) writes
`.local/env/<profile>.env` (dir 700, files 600): every non-secret setting of `.env` plus only the secrets of that profile.
It prints names, never values. Long-running processes add the guard `--import=./scripts/env-guard.mjs`, which refuses to start
when a project secret outside the profile is present (for example when `.env` is loaded too); the Gutachter seller has the check built in.

| Profile | Secrets | Processes |
|---|---|---|
| `gutachter-seller` | none | `gutachter/seller.mjs` (`npm run seller` in `gutachter/`) |
| `gutachter-buyer` | buyer mnemonic, Blockfrost | `npm run buy`, `npm run balance` in `gutachter/` |
| `rechnungsmeister` | Anthropic, RM `MPS_RUNTIME_TOKEN` | `rechnungsmeister/server.mjs` |
| `buero` | `MPS_BUYER_TOKEN`, `MPS_READ_TOKEN`, Blockfrost, Gutachter buyer mnemonic | `worker.mjs`, `buero/run.mjs` |
| `buero-local` | Anthropic, Blockfrost | `worker.mjs` with `ABNAHME_IMPL=local` |
| `mps-admin` | `ADMIN_KEY`, Blockfrost | one-shot operator scripts (`mps/*.mjs`, registration scripts) |
| `buero-api` | Büro selling `MPS_RUNTIME_TOKEN` | template `agent-api.mjs` |
| `eve` | `ZAI_API_KEY` | template `start.mjs` |

`GUTACHTER_SELLER_MNEMONIC` and the MPS secrets (`ENCRYPTION_KEY`, the hot-wallet mnemonics) are in no profile.
Compose still reads `.local/mps.env` and `.local/mps-secrets.env` through `mps/mps.sh`.

## Private files (gitignored, mode 600)

| File | Contents | Used by |
|---|---|---|
| `.local/mps.env` | `ADMIN_KEY` | `.local/env/mps-admin.env` (operator scripts), compose. Never the buyer loop |
| `.local/mps-secrets.env` (+ `.backup`) | `ENCRYPTION_KEY`, 3 wallet mnemonics | compose and `mps/wallets.mjs add-rm` only. Before real money: keep the mnemonics and the backup off this machine, only `ENCRYPTION_KEY` on the host |
| `.local/mps-runtime.env` | `MPS_RUNTIME_TOKEN`: ReadAndPay key scoped to the Büro selling wallet | template `paid-task.mjs`, `agent-api.mjs` |
| `.local/rechnungsmeister-runtime.env` | `MPS_RUNTIME_TOKEN`: ReadAndPay key scoped to the RM selling wallet | RechnungsMeister's agent-api fork |
| `.local/buero-buyer-runtime.env` | `MPS_BUYER_TOKEN`: ReadAndPay key scoped to the Büro purchasing wallet | Büro-Agent buyer loop (`/purchase`, refunds) |
| `.local/buero-read-runtime.env` | `MPS_READ_TOKEN`: Read key (canRead only, no wallet scope, Preprod), `mps/read-key.mjs`, key `cmvuvjeyq005h01pguqn7xnxh` | Büro-Agent buyer loop (purchase reads before FundsLocked, seller-side payment history) |
| `.local/env/*.env` | generated per-process files, see above | every process |

## Wallets (payment source `cmvupe9jg00044gnyq53exk4m`, Web3CardanoV2, contract `addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g`)

| Role | Type | walletId | vkey | Address | State file |
|---|---|---|---|---|---|
| Büro-Agent seller (Abnahme-Büro, Sokosumi Coworker) | Selling | `cmvupe9jh00094gnyhb6y7uoe` | `9007e9d5…cbca1` | `addr_test1qzgq06w4v4c0r63pft0wskzz58333w572qvul8cn2xwteg0mszt6smvwxweg9c38sydjwfuhvdt6v3zs8xew5szv8nusuw03qc` | `docs/payment-state.json` |
| RechnungsMeister seller | Selling | `cmvupfmdg000101pgndd6fgf2` | `5a4de949…6a03` | `addr_test1qpdym62fzyfmn35yrgr89qsr6nm50uxzpnndgewua7wx5qelmupkas792z774gh5ruwkd553dcf8ada86jjyf8hmvdssc92yck` | `docs/rechnungsmeister-payment-state.json` |
| Büro-Agent buyer | Purchasing | `cmvupe9jh00084gny5iw6og8j` | `6d5caaf1…b9fc` | `addr_test1qpk4e2h3q36hz6tu3l9ycahvtl4q9nrufdmuu739gqetnl9zx6fhrmwf6zu84nh2rcmg8etm0yz8tk8yujdwh0psjclqusukag` | `docs/buero-purchasing-state.json` |

How wallets were made: the seed creates one Purchasing and one Selling hot wallet per payment source from
`PURCHASE_WALLET_PREPROD_MNEMONIC` / `SELLING_WALLET_PREPROD_MNEMONIC`. We generated these ourselves (MeshWallet.brew in the setup image), so they never appear in docker logs.
The RM selling wallet was added with `PATCH /api/v1/payment-source-extended {id, AddSellingWallets:[{walletMnemonic, note, collectionAddress:null}]}`.
For more wallets, `POST /api/v1/wallet {network}` returns a fresh mnemonic, which you then add with the same PATCH.
To list: `GET /api/v1/wallet/list?paymentSourceId=…` (admin), or run `node --env-file=.local/env/mps-admin.env mps/wallets.mjs` (adds balances).
No collection address is set, so payouts stay in each selling wallet.

Funding needs: `plan/FUNDING.md`.

## Registration

Metadata goes into the on-chain NFT, so it is final once registered (a change needs a V2 `/registry/update` or a new registration).

| Agent | Script | Name / tags | apiBaseUrl | Status |
|---|---|---|---|---|
| Büro-Agent | `payment-registration.mjs` (template, edited: name, description, tags, port) | `Abnahme-Büro`, `e-rechnung, xrechnung, handwerk` | `http://127.0.0.1:21951` (`BUERO_API_PORT`, default 21951) | runtime key created; **not registered** |
| RechnungsMeister | `mps/rechnungsmeister-registration.mjs` (copy of the template script with its own state files) | `RechnungsMeister`, same tags, Capability `claude` | `http://127.0.0.1:${AGENT_API_PORT}` = 21950 | runtime key created; **not registered** |

Blocked on: (1) `AGENT_AUTHOR` is empty in `.env` (the template refuses to register without it), (2) both selling wallets hold 0 tADA,
(3) Büro only: `ZAI_MODEL` is empty, so its NFT would carry an empty `Capability.name`. Set it before registering the Büro-Agent.

Once those are done:

```sh
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
node --env-file=.local/env/mps-admin.env mps/rechnungsmeister-registration.mjs register
node --env-file=.local/env/mps-admin.env payment-registration.mjs register
# poll each (every ~30 s) until state is RegistrationConfirmed:
node --env-file=.local/env/mps-admin.env mps/rechnungsmeister-registration.mjs
node --env-file=.local/env/mps-admin.env payment-registration.mjs
```

After confirmation, add to `docs/registration-state.json` (and to the RM file) the `supportedPaymentSourceIndex` (expected 0; read it from the confirmed registry entry) and `sellerVkey` (the vkey in the table above), as template README step 5 says.

## Can one payment service buy from its own registered agent? Yes.

Evidence:
- The MPS e2e suite does exactly this. `tests/e2e/setup/globalSetup.ts` builds one `ApiClient` (one `TEST_API_URL`) and registers agents with the source's own selling wallets.
  `tests/e2e/helperFunctions.ts` `createPaymentWithCustomTiming` (seller, `POST /payment`) and `createPurchase` (buyer, `POST /purchase`) both call that same `global.testApiClient`.
  `tests/e2e/v2/flows/batch-verification.test.ts` (V2) creates payments for `pickAgentForSlot(Web3CardanoV2, 0)`, then purchases them on the same server and waits for FundsLocked / ResultSubmitted / Disputed. Same in 0.29.0 and in main (a846392).
- `POST /purchase` (0.29.0 `src/routes/api/purchases/index.ts`) only needs a V2 source for the `smartContractAddress` and at least one Purchasing hot wallet. It does not check whether the seller is local.
  The one seller check: the agent NFT holder must be a verification-key address. Ours is, since the selling hot wallet receives the NFT.
- Buyer and seller key hashes differ (purchasing `6d5c…` vs sellers `9007…`, `5a4d…`). The ideation spec says the contract needs that.
- Not yet run by us on preprod. `GET /api/v1/rail-readiness?network=Preprod` reports CardanoV2 `isReady: true`, `isPurchaseReady: true`.

Caveat for stream D: the buyer key is wallet-scoped. MPS assigns the purchasing wallet to a purchase only at funds lock, so before FundsLocked, `purchase/resolve-blockchain-identifier` with `MPS_BUYER_TOKEN` returns 404
(0.29.0 filters every purchase read on `smartContractWalletId`, which is null until the lock). Poll with `MPS_READ_TOKEN` until then (`node --env-file=.local/env/mps-admin.env mps/read-key.mjs`, once):
canRead only, no wallet scope, Preprod. It reads every purchase and payment on this MPS, but cannot pay, refund, transfer funds, reveal a mnemonic or mint keys
(live check 30 Oct: 401 on `GET /wallet?includeSecret=true`, `/api-key`, `/wallet/transfer-funds`, `/purchase`, `/purchase/request-refund`, `/payment`).
The buyer process never holds `ADMIN_KEY`: an admin key skips every wallet scope (`auth-middleware.ts`), so it would give the buyer the sellers' wallets too.
A scoped key still limits which purchasing wallets MPS uses (`HotWalletLimit`).
The runtime keys are not usage-limited (audit SECRETS-8, not applied: it changes the live purchase path). To cap the buyer key at
N purchases, PATCH `/api/v1/api-key` with the admin profile: `{id: <runtimeKeyId in docs/buero-purchasing-state.json>, usageLimited: true,
UsageCreditsToAddOrRemove: [{unit: '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d', amount: '<N>000000'}]}`
(the unit MPS stores in `PaidFunds`); a purchase past the credits fails with 400 `Insufficient funds`; `usageLimited: false` lifts the cap.
Side note: the V2 CI job runs only `tests/e2e/v2/flows/` (batch-verification, source-isolation). `cancel-refund-request-flow.test.ts` runs in the V1 job, so V2 cancel-refund-request is still not covered by CI (matches BUILD_PLAN).

## Ports (stream D, Fri 30 Oct)

| Process | Listens on | Env var (default) | Registered apiBaseUrl |
|---|---|---|---|
| RechnungsMeister `rechnungsmeister/server.mjs` (seller MIP-003) | `127.0.0.1:21950` | `AGENT_API_PORT` (21950, set in `.env`) | `mps/rechnungsmeister-registration.mjs` → `http://127.0.0.1:21950` |
| Abnahme-Büro, template `agent-api.mjs` (`npm run api`) | `127.0.0.1:21951` | `BUERO_API_PORT` (21951, not set in `.env`, default applies) | `payment-registration.mjs` → `http://127.0.0.1:21951` |
| Eve (template agent) | `127.0.0.1:21949` | `EVE_PORT` | none |
| x402 Gutachter `gutachter/seller.mjs` | `127.0.0.1:4021` (`GUTACHTER_HOST`) | `GUTACHTER_PORT` | none |
| KoSIT daemon | `127.0.0.1:8090` | `KOSIT_URL` | none |
| MPS | `127.0.0.1:38127` | `MPS_PORT` | none |

Change made: `agent-api.mjs` line 18 now reads `BUERO_API_PORT||21951` (was `AGENT_API_PORT||21950`), so the template Büro API
no longer collides with RechnungsMeister and matches what `payment-registration.mjs` mints. Both registration scripts were already correct and
are unchanged. Checked with `registrationUrl()` under `--env-file=.env`: RM → `:21950`, Büro → `:21951`.
