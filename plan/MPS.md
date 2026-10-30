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

**Start procedure: the repair loop belongs to MPS.** Once MPS answers the health check, start exactly one refund-repair loop and
leave it running beside the worker. Without it, the refund of a refused PRÜFEN stays `RefundAuthorized` (#1327), a payout after a
batched cure stays `WaitingForManualAction` (LB2-1), and a refund RechnungsMeister decided can stay in `WaitingForManualAction`
(DELTA-SELLER-2); see the three sections below. A second instance, or a one-off pass while the loop runs, is refused by its lock
`.local/refund-repair.lock`. It checks its own profile and refuses to start with any other (DELTA-SECRETS-5).

```sh
node --env-file=.local/env/mps-admin.env --import=./scripts/env-guard.mjs mps/refund-repair.mjs --loop   # exactly one, next to the worker
```

## Env files per process (audit SECRETS-1)

No long-running process and no root `npm` script loads the whole `.env`. `npm run wallet` in `gutachter/` reads `.env` and
`.local/secrets.env` only to reuse existing wallets, and appends new ones to `.local/secrets.env` (600), never to `.env`.
`node scripts/env-split.mjs` (rerun after every change to `.env` or a key file) writes
`.local/env/<profile>.env` (dir 700, files 600): every non-secret setting of `.env` plus only the secrets of that profile.
It prints names, never values. Long-running processes add the guard `--import=./scripts/env-guard.mjs`, which refuses to start
when a project secret outside the profile is present (for example when `.env` is loaded too). The entry points also check their
own fixed profile in code (`requireProfile`, DELTA-SECRETS-5), whatever the command line loaded: `worker.mjs` (`buero`, or
`buero-local` with `ABNAHME_IMPL=local`), `buero/run.mjs` (`buero`), `rechnungsmeister/server.mjs`, `board/server.mjs`,
`mps/refund-repair.mjs` (`mps-admin`); the Gutachter seller has its own check. The check also refuses names that only look secret
(`*_TOKEN`, `*_KEY`, …) exported in the starting shell, so start them from a shell without such exports.
The worker runs the `sokosumi` CLI with `PATH` and `HOME` only (DELTA-SECRETS-1); the CLI takes its credentials from the OS vault.

| Profile | Secrets | Processes |
|---|---|---|
| `gutachter-seller` | none | `gutachter/seller.mjs` (`npm run seller` in `gutachter/`) |
| `gutachter-buyer` | buyer mnemonic, Blockfrost | `npm run buy`, `npm run balance` in `gutachter/` |
| `rechnungsmeister` | Anthropic, RM `MPS_RUNTIME_TOKEN` | `rechnungsmeister/server.mjs` |
| `buero` | `MPS_BUYER_TOKEN`, `MPS_READ_TOKEN`, Blockfrost, Gutachter buyer mnemonic | `worker.mjs`, `buero/run.mjs` |
| `buero-local` | Anthropic, Blockfrost | `worker.mjs` with `ABNAHME_IMPL=local` |
| `mps-admin` | `ADMIN_KEY`, Blockfrost | one-shot operator scripts (`mps/*.mjs`, registration scripts); the long-running `mps/refund-repair.mjs --loop` |
| `buero-api` | Büro selling `MPS_RUNTIME_TOKEN` | template `agent-api.mjs` |
| `eve` | `ZAI_API_KEY` | template `start.mjs` |
| `board` | Blockfrost, `MPS_READ_TOKEN` | `board/server.mjs` (read-only demo board) |

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
| Büro-Agent | `payment-registration.mjs` (template, edited: name, description, tags, port) | `Abnahme-Büro`, `e-rechnung, xrechnung, handwerk` | `http://127.0.0.1:21951` (`BUERO_API_PORT`, default 21951) | **registered** (`RegistrationConfirmed`), NFT mint [`f63a51dc…`](https://preprod.cardanoscan.io/transaction/f63a51dc57282b2a680ce12ef25f4d80d74f65ed12a19330af1986d00bc0fc22), state in `docs/registration-state.json` |
| RechnungsMeister | `mps/rechnungsmeister-registration.mjs` (copy of the template script with its own state files) | `RechnungsMeister`, same tags, Capability `claude` | `http://127.0.0.1:${AGENT_API_PORT}` = 21950 | **registered** (`RegistrationConfirmed`), NFT mint [`8548d4f7…`](https://preprod.cardanoscan.io/transaction/8548d4f7a4a8667a91ccbd068d41ad6070062bc5794d1e6fe72159b625836333), state in `docs/rechnungsmeister-registration-state.json` |

Both NFTs were minted on 30 Oct at 09:04:57Z (block 5352641). The earlier blockers (empty `AGENT_AUTHOR`, unfunded selling wallets,
empty `ZAI_MODEL`) were cleared first. Both `apiBaseUrl` values point to `127.0.0.1`, so the registry entries are not reachable from outside.

The commands used (the same commands poll the state):

```sh
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
node --env-file=.local/env/mps-admin.env mps/rechnungsmeister-registration.mjs register
node --env-file=.local/env/mps-admin.env payment-registration.mjs register
# poll each (every ~30 s) until state is RegistrationConfirmed:
node --env-file=.local/env/mps-admin.env mps/rechnungsmeister-registration.mjs
node --env-file=.local/env/mps-admin.env payment-registration.mjs
```

After confirmation, both state files got `supportedPaymentSourceIndex` 0 (read from the confirmed registry entry) and `sellerVkey` (the vkey in the wallet table above), as template README step 5 says.

## Can one payment service buy from its own registered agent? Yes.

Evidence:
- The MPS e2e suite does exactly this. `tests/e2e/setup/globalSetup.ts` builds one `ApiClient` (one `TEST_API_URL`) and registers agents with the source's own selling wallets.
  `tests/e2e/helperFunctions.ts` `createPaymentWithCustomTiming` (seller, `POST /payment`) and `createPurchase` (buyer, `POST /purchase`) both call that same `global.testApiClient`.
  `tests/e2e/v2/flows/batch-verification.test.ts` (V2) creates payments for `pickAgentForSlot(Web3CardanoV2, 0)`, then purchases them on the same server and waits for FundsLocked / ResultSubmitted / Disputed. Same in 0.29.0 and in main (a846392).
- `POST /purchase` (0.29.0 `src/routes/api/purchases/index.ts`) only needs a V2 source for the `smartContractAddress` and at least one Purchasing hot wallet. It does not check whether the seller is local.
  The one seller check: the agent NFT holder must be a verification-key address. Ours is, since the selling hot wallet receives the NFT.
- Buyer and seller key hashes differ (purchasing `6d5c…` vs sellers `9007…`, `5a4d…`). The ideation spec says the contract needs that.
- Run by us on preprod since 30 Oct: every Büro-Agent escrow run in `plan/EVIDENCE.md` buys from our own registered RechnungsMeister on this one MPS (first FundsLocked [`a57c43ee…`](https://preprod.cardanoscan.io/transaction/a57c43ee103097f67b6650b2db896682ef254fef0c3dcf0f8e03d82cce9d1cab), 09:08:47Z). Before that, `GET /api/v1/rail-readiness?network=Preprod` reported CardanoV2 `isReady: true`, `isPurchaseReady: true`.

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

## Refunds stuck in RefundAuthorized (upstream #1327): `mps/refund-repair.mjs`

MPS 0.29.0 does not collect the refund of a refused PRÜFEN by itself (masumi-payment-service #1327; our fix PR #1328 is open).
After the seller's AuthorizeRefund, tx-sync keeps the purchase's old `resultHash` (`decodedNewContract?.resultHash ?? decodedOldContract.resultHash`),
although the datum's `result_hash` is now empty. The V2 auto-refund job selects only `resultHash: null`, so the purchase stays
`RefundAuthorized` / `WaitingForExternalAction` with 1 tUSDM in the escrow ("Found V2 auto withdraw refund requests count 0").
Campaign 1 hit it on all 5 refusals. The workaround runs with the admin profile:

```sh
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
node --env-file=.local/env/mps-admin.env --import=./scripts/env-guard.mjs mps/refund-repair.mjs          # one pass; exit 1 if a request failed
node --env-file=.local/env/mps-admin.env --import=./scripts/env-guard.mjs mps/refund-repair.mjs --loop   # a pass every 60 s, next to the worker
```

Each pass:
1. Lists `GET /purchase?network=Preprod&filterPaymentSourceType=Web3CardanoV2&filterOnChainState=RefundAuthorized&limit=100`, paging with `cursorId`.
   Without `filterPaymentSourceType` (or a contract filter), 0.29.0 lists V1 purchases only. That is why a plain `GET /purchase?network=Preprod` came back empty.
2. Keeps only purchases with a non-null `resultHash`, `NextAction` `WaitingForExternalAction` without an error, and a confirmed AuthorizeRefund as `CurrentTransaction`.
3. Checks on chain (Blockfrost) that this tx's own escrow output (datum `input_hash` = the purchase's) is unspent, has state `RefundAuthorized` (field 18, constructor 5) and an empty `result_hash` (field 11).
4. Calls `POST /request-repair/preview {kind: Purchase, network, blockchainIdentifier, txHash}`. Only if MPS derives `RefundAuthorized` with `resultHash: null`
   does it call `POST /request-repair` with the preview's `requestVersion`, never with `force`. MPS then sends WithdrawRefund by itself (45 s to 3:23 in the campaign).

Between the preview and each write it re-reads the record (`POST /purchase/resolve-blockchain-identifier`, for payments
`/payment/…`). If MPS state, next action, result hash or current tx changed since the listing (another actor, or a one-off pass),
it writes nothing and logs `skip … changed after the listing`; a change after the re-read fails on the preview's `requestVersion`.
Only one instance runs: the pass and the loop both take `.local/refund-repair.lock` and refuse to start beside each other.
It is idempotent: a repaired purchase has `resultHash: null` and is not picked again. It prints one line per action (`repaired`, `skip`, `error`)
plus a pass summary, and never prints a key. The Büro's REFUSED protocol still names the operator step ("Hinweis für den Betreiber … #1327").
Done by hand before the script existed: A8, B5 and B3 (campaign 1), then A4 and A9b (both refunded in one WithdrawRefund,
[`3278fb11…`](https://preprod.cardanoscan.io/transaction/3278fb112d2c43858294e1a2cf43abe876bd30585ca7e158078e0367c506540b), 30 Oct 15:37:20Z).
The first live run (30 Oct 15:52Z) found 0 stuck purchases. Remove the refund half once MPS ships the #1328 fix.

## Seller payouts stuck in WithdrawAuthorized (LB2-1, CAMPAIGN2-1): same script, `repairStuckWithdrawals`

**Cause (MPS 0.29.0, read in the source; unchanged on `main` a846392 and `dev` 99686769; not #1327).** A batched V2 SubmitResult
gives all its escrows ONE shared Transaction row (`payments/submit-result/service.ts`, "V2 batch shared-Transaction pre-submit").
tx-sync handles the entries one by one, in sorted-input order. The first entry's handler marks the shared row `Confirmed`.
For every later entry, the idempotency guard in `handleV2PaymentTransaction` (`packages/payment-source-v2/src/services/tx-sync/handlers.ts`)
checks `CurrentTransaction.txHash === tx_hash && status === Confirmed && onChainState === newState`. A cure (Disputed → Disputed)
already has `onChainState === newState`, so the guard returns without a log line. The payment keeps `SubmitResultInitiated`.
When the buyer's AuthorizeWithdrawal lands, the transition table maps `(SubmitResultInitiated, WithdrawAuthorized)` to
`WaitingForManualAction` / "Unexpected state change detected. Possible a action was executed externally". MPS never builds the Withdraw.
Escrows whose state changes in the batch (first deliveries, disputes) are not affected. The shared row's
`previousOnChainState`/`newOnChainState` is last-writer-wins too, which is why D3's cure is labelled `FundsLocked>ResultSubmitted`.

Evidence (campaign 2, 30 Oct):
- Cure batch `91e1b067…`: D4b (#0, input `a173fb93…#0`, first in sorted order) got its `WaitingForExternalAction` at 16:16:18.820Z.
  D4 (#1) and D1-2 (#2) have no action after `SubmitResultInitiated`. The shared row's `updatedAt` is 16:16:18.820Z: nothing wrote it later.
- Mixed batch `92c282d8…`: two lane-A first deliveries (inputs `b0f74880…#0/#1`) came first, and D3's cure (`f6312a30…#3`) was skipped.
- After the AuthorizeWithdrawals `f8c5881d…` (D4, D1-2) and `a6a9f43e…` (D3): exactly these 3 of 19 payments were in `WaitingForManualAction`.

**Repair (supported admin endpoints only).** `error-state-recovery` on its own is not safe here. It repoints the payment to the newest
`Confirmed` row of its `TransactionHistory`, and the AuthorizeWithdrawal is not in that history yet (it is only the current tx).
The newest history row is the spent cure tx, so the Withdraw would be built from a spent UTxO. `retryPreviousAction: true` would
submit the cure again. So the script does, per payment:
1. Lists `GET /payment?network=Preprod&filterPaymentSourceType=Web3CardanoV2&filterOnChainState=WithdrawAuthorized&limit=100` (cursor paging).
2. Acts on `WaitingForManualAction` with an `errorType` right away. It also acts on `WaitingForExternalAction` with no change for more
   than 15 min, but only when `resultHash` is null. Any other action unchanged for more than 15 min (for example `WithdrawInitiated`)
   gets a `skip … no automatic repair` alarm line and nothing else.
3. Requires a confirmed current tx with `newOnChainState` WithdrawAuthorized. Checks on Blockfrost that its own escrow output
   (datum `input_hash` = the payment's) is unique and unspent, has state WithdrawAuthorized (field 18, constructor 4), and has a
   non-empty `result_hash` equal to MPS's `resultHash`.
4. Calls `POST /request-repair/preview {kind: Payment, network, blockchainIdentifier, txHash}`. It must derive `WithdrawAuthorized`
   at that output index with that result hash. Then `POST /request-repair` with the `requestVersion`, never `force`. This links the
   AuthorizeWithdrawal into the history (and fills a null `resultHash` from the datum).
5. Re-reads the payment with `POST /payment/resolve-blockchain-identifier` (`includeHistory: "true"`, a string in 0.29.0). Only if the newest
   `Confirmed` history row is the AuthorizeWithdrawal does it call `POST /payment/error-state-recovery {blockchainIdentifier, network, updatedAt}`
   (no `retryPreviousAction`). The response must show `WaitingForExternalAction` on the AuthorizeWithdrawal.
6. MPS's auto-withdraw then queues `WithdrawRequested` and sends the Withdraw by itself.

If MPS parks the same payment again after a repair (for example a per-item collection failure, which MPS 0.29.0 records in the
same `WaitingForManualAction` shape), the loop does not clear it every minute: it repairs one payment at most once per hour and
three times per loop process, then logs one `alarm …` line with MPS's `errorType` and `errorNote` and leaves it to an operator
(DELTA-OPERATOR-1). Every `repaired` line carries the error note it cleared. A restart of the loop resets the count.

Side effect: request-repair rewrites the payment's AuthorizeWithdrawal row to `WithdrawAuthorized>WithdrawAuthorized`, so the seller
history shows that label for this tx (the buyer side keeps `Disputed>WithdrawAuthorized`).

**Live recovery, 30 Oct.** All three are `Withdrawn`, and RechnungsMeister received 3 × 1 tUSDM:

| Escrow | Payment | Stuck output | Repair + clear (Z) | Withdraw (on chain) |
|---|---|---|---|---|
| D3 | `cmvv5sduj012j01pg0fa2reof` | `a6a9f43e…#0` | 18:06:36 / 18:06:45, by hand (same calls) | [`d6d48469…`](https://preprod.cardanoscan.io/transaction/d6d484694ce2d8af2f1bae88d11cb41e9495124782dbf91be33da0cae614da08), block 5354075, 18:07:43 |
| D4 | `cmvv632v2017d01pgqagm2159` | `f8c5881d…#1` | 18:14:50, one pass of the script | [`4d580b35…`](https://preprod.cardanoscan.io/transaction/4d580b35eb441be0ed25701c9f4c1ef254fd6cbbc267fcb877d6a95d2590c17a), block 5354098, 18:15:25 |
| D1-2 | `cmvv5sdu7012g01pgc4uwjooy` | `f8c5881d…#2` | 18:14:52, same pass | same tx `4d580b35…` (batched) |

The buyer purchases followed to `Withdrawn` / `None`. Afterwards no V2 payment or purchase was left in `WithdrawAuthorized`.
The trigger cannot be switched off by configuration: the L1 SubmitResult batch size is hardcoded (`SUBMIT_RESULT_BATCH_SIZE = 7`
in `payments/submit-result/service.ts`), so the `--loop` is the safety net. It only picks up the new mode after a restart.
Upstream issue: [masumi-payment-service#1331](https://github.com/masumi-network/masumi-payment-service/issues/1331), fix [#1332](https://github.com/masumi-network/masumi-payment-service/pull/1332).

## Refunds RechnungsMeister decided while MPS holds the payment (DELTA-SELLER-2): same script, `repairHeldRefunds`

RechnungsMeister decides the refund of a refused cure when it is due (`refundOrHold` in `rechnungsmeister/server.mjs`: job phase
`refund-pending`, reasons in `refundReasons`, one `ALARM job …` line). MPS `authorize-refund` takes a Disputed payment in
`WaitingForExternalAction` only, and RechnungsMeister's scoped key cannot move it out of another state. MPS 0.29.0 holds a cured
payment elsewhere in two cases: a failed cure tx leaves `WaitingForManualAction` with an error
(`packages/payment-source-v2/src/services/request-failure.ts`), and a cure in a batched SubmitResult keeps `SubmitResultInitiated`
without an error (the LB2-1 cause above).

Each pass reads `.local/rechnungsmeister-jobs/*.json` (it uses only `phase`, `closed` and the blockchainIdentifier, and logs no
token). Only if a job is `refund-pending` and not closed does it list
`GET /payment?network=Preprod&filterPaymentSourceType=Web3CardanoV2&filterOnChainState=Disputed`. Payments without such a decision
are never touched. For a payment with one:
1. `WaitingForExternalAction`: nothing to do; RechnungsMeister sends the refund on its next tick.
2. `WaitingForManualAction` with an error: the LB2-1 repair. The current tx must be Confirmed, and its own escrow output (datum
   `input_hash` = the payment's) unique, unspent and Disputed (field 18, constructor 3), with MPS's `resultHash`. Then: preview (it
   must derive Disputed at that output with that hash), re-read, `request-repair` with the `requestVersion` (never forced; it links
   the tx into the history), re-read with history (the newest Confirmed row must be this tx), `error-state-recovery` without
   `retryPreviousAction`. The response must show `WaitingForExternalAction` on that tx. RechnungsMeister then sends
   `authorize-refund` on its next tick (5 s). The DELTA-OPERATOR-1 backoff applies: once an hour, three times per loop process,
   then one alarm.
3. Any other action unchanged for more than 15 min, above all `SubmitResultInitiated`: **alarm only**, one `alarm …` line per
   payment, no write. A chain check that fails in case 2 raises an alarm as well.

Why case 3 is not repaired: no supported endpoint leaves `SubmitResultInitiated`. `error-state-recovery` refuses a payment that is
not in `WaitingForManualAction` with an error; `request-repair` repoints the tx but leaves `NextAction` as it is;
`authorize-refund` and `submit-result` take `WaitingForExternalAction` only; and the wallet-timeout job only handles a Pending or
missing current tx, while the batched row is Confirmed. The 1 tUSDM then stays in Disputed. What is left: Masumi admin arbitration
(`WithdrawDisputed` with the admins' multisig, valid only after `externalDisputeUnlockTime`, `vested_pay.ak`), or an MPS fix or a
manual correction of the payment's NextAction by the MPS operator, outside the API and not automated here. The V2 contract sets no
deadline for the seller's AuthorizeRefund, so RechnungsMeister still sends the decided refund once MPS shows
`WaitingForExternalAction`. Not run against the live MPS yet; tested against a fake MPS and Blockfrost
(`mps/refund-repair.test.mjs`).

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
