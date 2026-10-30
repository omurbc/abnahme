# Sokosumi Coworker "Abnahme-Büro" (stream E)

Every command name and flag below comes from `sokosumi --help`, the CLI 1.0.4 source (`dist/src/cli/commands/*.js`), the bundled
skill (`sokosumi skills path` → `sokosumi/SKILL.md`) and the official
[agent guide](https://www.masumi.network/tum-hackathon/agent-guide.md). Subcommand `--help` only prints the global usage.
Run everything from the repo root:

```sh
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"   # Node 24 first; the default node here is 18
sokosumi --version                                   # 1.0.4, installed globally with Node 24
```

## Our records (own account, created Fri 30 Oct 10:02-10:04)

| Record | Value |
|---|---|
| Account | Preprod user, platform role `user` |
| TUM organization | `TUM-Hackathon`, ID `01a17942-e6dd-724f-bae6-458b6a0f715a`, slug `tum-hackathon-u4ve65`, role member, `taskSeatEligible: true` |
| Vendor | `Abnahme`, slug `abnahme-tum26`, ID `01a18c0c-2ef6-71f9-ab8d-3f75e9b431bb`, role admin |
| Coworker | `Abnahme-Büro`, ID `01a18c0c-c2b5-72ea-93e6-a678359b9cc2`, capability `tasks` |
| TUM workspace access | access ID `01a18c0c-c3e9-71e8-b420-23fab975cab3`, **GRANTED** 10:34 (approved by the TUM workspace owner) |
| Runtime key | in the OS vault (`runtime key-import` → `{"stored":true}`), never in `.env`. The Keychain item trusts the `node@24` binary, not the worker: any Node 24 script run by this macOS user reads it (and the CLI's OAuth token) without a prompt. For real use, run the worker under its own macOS account |
| `.env` | `COWORKER_ID`, `SOKOSUMI_ORGANIZATION_ID`, `SOKOSUMI_ORGANIZATION_SLUG` set |

**The Personal Workspace path does not work on preprod with CLI 1.0.4.** `coworkers register --personal` and
`workspaces list --personal` both fail with Core `404 route_not_found` on `GET /v1/users/me/workspace-access`
(the call is made before anything is created, so no stray record exists). We therefore use the TUM organization directly.
Credits come from the TUM organization pool (245 at 10:05), not from the personal workspace.

## A. Operator only (browser), done

1. `sokosumi --preprod auth login`, then `sokosumi --preprod auth whoami --json`. The CLI refreshes the token itself
   (refresh token in the vault). If a later CLI call says unauthenticated, run `auth login` again.
2. Join the TUM workspace: https://preprod.sokosumi.com/join/GTAHB3OQFWgg8rGetMfleiqgeL6_ltdW
3. A TUM workspace owner or admin approves the access request of Coworker `Abnahme-Büro` (Vendor `Abnahme`).
   Then the agent re-runs `connect` and gets `GRANTED` (done, 10:34).

## B. Non-interactive (run by the agent), done

```sh
sokosumi --preprod workspaces list --json
sokosumi --preprod vendors me --json
sokosumi --preprod coworkers list --scope owned --json
sokosumi --preprod workspaces check 01a17942-e6dd-724f-bae6-458b6a0f715a --json          # taskSeatEligible true
sokosumi --preprod vendors create --name "Abnahme" --slug abnahme-tum26 --json
sokosumi --preprod coworkers register --vendor-id 01a18c0c-2ef6-71f9-ab8d-3f75e9b431bb --name "Abnahme-Büro" --capability tasks --workspace-id 01a17942-e6dd-724f-bae6-458b6a0f715a --json
sokosumi --preprod coworkers api-key 01a18c0c-c2b5-72ea-93e6-a678359b9cc2 --json | sokosumi --preprod runtime key-import --coworker-id 01a18c0c-c2b5-72ea-93e6-a678359b9cc2 --api-key-stdin
# after approval (never register again):
sokosumi --preprod coworkers connect 01a18c0c-c2b5-72ea-93e6-a678359b9cc2 --vendor-id 01a18c0c-2ef6-71f9-ab8d-3f75e9b431bb --workspace-id 01a17942-e6dd-724f-bae6-458b6a0f715a --json
```

Do not rerun `api-key | key-import` after the successful import: it mints a new key.

## C. Processes

| Process | Command | Needed for |
|---|---|---|
| MPS 0.29.0 | `mps/mps.sh up -d` | SENDEN (paid), and the escrow inside PRÜFEN with stream D's `runAbnahme` |
| KoSIT 1.6.3 | `kosit/start.sh` | PRÜFEN |
| Mailpit | `mail/start.sh` (container `abnahme-mailpit`, SMTP 127.0.0.1:1025, UI http://127.0.0.1:8025) | SENDEN |
| Gutachter | `cd gutachter && npm run seller` (loads `../.local/env/gutachter-seller.env`, no secrets) | PRÜFEN with stream D's `runAbnahme` only |
| RechnungsMeister | `node --env-file=.local/env/rechnungsmeister.env --import=./scripts/env-guard.mjs rechnungsmeister/server.mjs` | PRÜFEN with stream D's `runAbnahme` only |
| Worker (exactly one) | `node --env-file=.local/env/buero.env --import=./scripts/env-guard.mjs worker.mjs` | everything |
| Refund-repair loop (exactly one) | `node --env-file=.local/env/mps-admin.env --import=./scripts/env-guard.mjs mps/refund-repair.mjs --loop` | refunds of refused PRÜFEN and stuck payouts on MPS 0.29.0 (`plan/MPS.md`) |
| Eve (`npm start`) | **not needed**, see F | |

Generate the `.local/env/*.env` files first with `node scripts/env-split.mjs` (see `plan/MPS.md`, "Env files per process"); rerun it
after every change to `.env`. The `buero` profile holds `MPS_BUYER_TOKEN` (writes), `MPS_READ_TOKEN` (reads before FundsLocked),
Blockfrost and the Gutachter buyer mnemonic. It holds no `ADMIN_KEY` and no Anthropic key; the guard refuses to start if either is present.
`ABNAHME_IMPL=local node --env-file=.local/env/buero-local.env --import=./scripts/env-guard.mjs worker.mjs` uses `buero/abnahme-local.mjs` instead of stream D's `buero/abnahme.mjs`:
the real extraction, XRechnung build, KoSIT validation and semantic checks, but **no escrow purchase and no tx hashes**.
Extraction follows `EXTRACT_MODE` (`llm` by default, uses `ANTHROPIC_API_KEY`; `fixed` only for the `*.fixed.txt` layout).

## D. Tasks (TUM workspace)

The first line of the description picks the route (`buero/sokosumi.mjs`). A description holds at most 16,000 characters.

- `PRÜFEN` (unpaid). The two control lines `Empfänger: bau-isar` (or `hv-giesing`) and `Betrag: 18.400,00` (expected gross
  total) go **directly below line 1**, then the invoice text. A control line inside the invoice text neither sets nor hides
  them, and a duplicate control line is refused. At most 2 PRÜFEN run at once; the others wait and get a queue comment.
  Progress goes into Task comments. Accepted → COMPLETED with the protocol, the tx table and
  `Senden: kostenpflichtig, Sokosumi bucht dafür Credits (Escrow 1 tUSDM); nur für abgenommene Rechnungen. Auftrag dafür: „SENDEN <Rechnungsnummer>“.`
  Refused → COMPLETED with the German defect list, 0 credits, and where the escrow refund stands ("Rückerstattung freigegeben",
  refund authorized; an operator completes a refund that MPS 0.29.0 does not collect, upstream #1327). Accepted, but with an
  invoice number the Büro cannot e-mail → COMPLETED with the protocol and no SENDEN offer. An escrow run that ends FAILED with its
  journal still open is resumed once by the worker, 5 minutes later, without a new purchase. Any other error → FAILED with the
  reason (`gate-failed`).
- `SENDEN <Rechnungsnummer>` (paid, 1 tUSDM through the template's masumiPayment flow). Refused with FAILED **before any payment
  request** ("Es wurde nichts berechnet") if paid tasks are off, or if no COMPLETED PRÜFEN Task **of the same Sokosumi user**
  accepted that invoice (a later refusing PRÜFEN withdraws the acceptance). It is also refused for free by two different guards in
  `.local/sent-ledger.json`:
  - **Doppelversand:** the same invoice number or XML sha256 was already sent, or another SENDEN for it is running.
  - **Same supply:** the same supply (same AP inbox, line items and Leistungsdatum) was already sent under another invoice number.
    The § 14c UStG note appears only when the invoice shows VAT.

  Then the worker probes SMTP (refused for free if Mailpit does not answer) and **reserves** the invoice in the ledger before
  it requests payment, so a second SENDEN for the same invoice fails for free. The reservation pins the acceptance: the XML
  sha256, the inbox and the accepting PRÜFEN Task. After FundsLocked the worker reads the Task again (a Task cancelled meanwhile
  gets nothing) and mails exactly the pinned XML, re-hashed, to the pinned inbox; a PRÜFEN of the same number in between changes
  neither. A refusal there ends FAILED and never submits a result. Every FAILED text says whether credits were
  booked: after the payment request, Sokosumi has booked credits that a FAILED Task does not refund. A SENDEN whose mail went out
  but whose result missed the MPS deadline (the worker was down) ends COMPLETED with the send result and a note that the Büro is
  not paid for it.

**Unclear send (operator, `buero/resolve.mjs`).** A FAILED SENDEN that says "mit ungeklärtem Ausgang" names a Message-ID: the
worker stopped, or the connection broke, after the message was handed to SMTP. An SMTP refusal (a 4xx/5xx reply) is
"nichts versendet" and frees the number by itself. Search Mailpit (http://127.0.0.1:8025) for the Message-ID, stop the worker
(one SIGTERM, it finishes its pass), then from the repo root:

```sh
node buero/resolve.mjs AR-2026-0087 sent       # the mail is in Mailpit: the number stays locked (Doppelversand)
node buero/resolve.mjs AR-2026-0087 not-sent   # it is not: the number is free for one new SENDEN
```

and start the worker again. The CLI takes the worker lock, so it refuses while a worker runs. `not-sent` also frees a reservation
that a SENDEN Task left behind ("läuft bereits der SENDEN-Auftrag …" for a Task that is no longer running); `sent` is refused
for a mere reservation, because nothing was handed to SMTP.

```sh
SLUG=tum-hackathon-u4ve65; CW=01a18c0c-c2b5-72ea-93e6-a678359b9cc2
# G2: unpaid PRÜFEN
{ echo PRÜFEN; echo "Empfänger: bau-isar"; echo "Betrag: 18.400,00"; cat fixtures/b-abschlag-13b-bau-isar.txt; } > .local/pruefen-b.txt
sokosumi --preprod tasks create --organization-slug $SLUG --coworker-id $CW --name "Prüfen AR-2026-0087" --description "$(cat .local/pruefen-b.txt)" --status READY --json
sokosumi --preprod tasks get TASK_ID --organization-slug $SLUG --json
sokosumi --preprod tasks events TASK_ID --organization-slug $SLUG --json
# G4: paid SENDEN for the accepted invoice (needs E first)
sokosumi --preprod tasks create --organization-slug $SLUG --coworker-id $CW --name "Senden AR-2026-0087" --description "SENDEN AR-2026-0087" --status READY --json
sokosumi --preprod runtime receipt TASK_ID --coworker-id $CW --json     # seller receipt, after Withdrawn
```

## E. Paid tasks (G4)

`isPaidReady()` needs `docs/registration-state.json` at `RegistrationConfirmed` plus `.local/mps-runtime.env` (present).
The coordinator fills `supportedPaymentSourceIndex` and `sellerVkey` after the Abnahme-Büro registration confirms
(template README step 5). Only then: `PAID_TASKS_ENABLED=true` in `.env`, `node scripts/env-split.mjs`, and restart the worker. The template's `npm run api`
is **not** needed for Sokosumi paid tasks: Sokosumi buys from the `masumiPayment` event and never calls the agent API.

## F. Eve is not needed

The template's `answer()` (Eve + `ZAI_*` OpenAI-compatible model) is replaced: PRÜFEN calls `runAbnahme`, SENDEN sends mail.
`worker.mjs` no longer calls `client.health()`, so `npm start` does not have to run and `ZAI_API_KEY`/`ZAI_BASE_URL` stay empty.
`worker.mjs` does not import `comments.mjs` and never reads Task comments; it only posts progress and queue comments.
Consequence: follow-up user comments on a Task get no reply. `ZAI_MODEL` is still read once, by
`payment-registration.mjs`, as the registry `Capability.name` (`claude-opus-5-5`). Claude itself is only called through the official
SDK in `einvoice/extract.mjs`.

## Status

| Step | State |
|---|---|
| CLI 1.0.4 installed (Node 24) | done |
| Login, TUM workspace joined | done (operator) |
| Vendor, Coworker, runtime key, `.env` | done |
| TUM workspace access GRANTED | done, 10:34 (approved by the TUM workspace owner) |
| G2 unpaid PRÜFEN COMPLETED | done: Task `01a18c29-f636-7378-aa12-8a4eb654a255`, COMPLETED 09:35:36Z, **ABNAHME_IMPL=local** (no escrow), ABGENOMMEN AR-2026-0087, 0 credits |
| G4 paid SENDEN FundsLocked | done: Task `01a18c2a-6912-7478-9755-8872eb2ff753`, FundsLocked [`d9c69f50…2859`](https://preprod.cardanoscan.io/transaction/d9c69f508f1f15299cdd3cc056ff4444b9ba0fcadf00e197cd14f7286c952859) (block 5352737), ResultSubmitted [`68b5a6fc…242e`](https://preprod.cardanoscan.io/transaction/68b5a6fc55deb0d28481d4ac4976532ca4dcf88d419eb896a4ae658c60f4242e), COMPLETED 09:39:50Z, 100 credits (TUM pool) |
| Mailpit delivery | Message-ID `<1bc07905-682d-4513-9f3c-2d2c541f90d8@abnahme.local>`, `250 2.0.0 Ok: queued as 0vC5CRzIiDK69V1YJl57Qn` |
| Doppelversand | Task `01a18c2e-6de2-76ca-b42e-5d48cbef591e` (second `SENDEN AR-2026-0087`): FAILED before any payment request, 0 credits |
| SENDEN Withdrawn + seller receipt | Withdrawn [`5d61bf3f…7146`](https://preprod.cardanoscan.io/transaction/5d61bf3f11db7fb2e4a110e98ea44f1699e7fb8d779866d5513cb5e83e0a7146) 10:22:14Z; `settlement.mjs`: receipt `settled: true`, net +1000000 tUSDM units at the Abnahme-Büro seller address (journal stage `settled`) |
| PRÜFEN with stream D's real escrow | Task `01a18c4b-3a89-717e-905d-6fd3d92b67c5`, COMPLETED 10:24:26Z, 17 progress comments, 0 credits. FundsLocked `e88c7599…`, ResultSubmitted `8515a0d9…`, Disputed `75177063…` (BR-AE-02, ABN-BT48), cure `c03d4aea…`, AuthorizeWithdrawal `af74d6d7…`, Withdrawn `378ee7a6…`, all confirmed on Blockfrost (FundsLocked [`e88c7599…a0c1`](https://preprod.cardanoscan.io/transaction/e88c7599eb2a2dd42127fd1ee182ebbb5d4418923548fa070a8ec9c00fdea0c1), Withdrawn [`378ee7a6…b5a9`](https://preprod.cardanoscan.io/transaction/378ee7a6d7d3ab70f62be5e519a70e00ca24d5a17d12e88ab9ac85b141abb5a9)). Inspections fell back to local KoSIT (x402 answered HTTP 402), but both x402 payments were charged on chain without a report: [`9d022f95…`](https://preprod.cardanoscan.io/transaction/9d022f95fd23769805ac8a276090cd17a6ef8f84057d5a335ab58411f4e360f1) (10:16:23Z) and [`8f4755d3…`](https://preprod.cardanoscan.io/transaction/8f4755d394c67f7d5ec31828219b8bf9fd94ed0e8102d6ba446673f5dd905f83) (10:20:24Z). Fixed in `4621ab5` (one signed payment, resent until it settles) |
