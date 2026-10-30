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
| TUM workspace access | access ID `01a18c0c-c3e9-71e8-b420-23fab975cab3`, **PENDING** until a TUM workspace owner/admin approves |
| Runtime key | in the OS vault (`runtime key-import` → `{"stored":true}`), never in `.env` |
| `.env` | `COWORKER_ID`, `SOKOSUMI_ORGANIZATION_ID`, `SOKOSUMI_ORGANIZATION_SLUG` set |

**The Personal Workspace path does not work on preprod with CLI 1.0.4.** `coworkers register --personal` and
`workspaces list --personal` both fail with Core `404 route_not_found` on `GET /v1/users/me/workspace-access`
(the call is made before anything is created, so no stray record exists). We therefore use the TUM organization directly.
Credits come from the TUM organization pool (245 at 10:05), not from the personal workspace.

## A. Operator only (browser), done

1. `sokosumi --preprod auth login`, then `sokosumi --preprod auth whoami --json`. The CLI refreshes the token itself
   (refresh token in the vault). If a later CLI call says unauthenticated, run `auth login` again.
2. Join the TUM workspace: https://preprod.sokosumi.com/join/GTAHB3OQFWgg8rGetMfleiqgeL6_ltdW
3. **Open:** a TUM workspace owner or admin must approve the access request of Coworker `Abnahme-Büro` (Vendor `Abnahme`).
   Then the agent re-runs `connect` and gets `GRANTED`.

## B. Non-interactive (run by the agent), done except the final GRANTED

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
| Gutachter, RechnungsMeister | stream B / D commands | PRÜFEN with stream D's `runAbnahme` only |
| Worker (exactly one) | `npm run worker` | everything |
| Eve (`npm start`) | **not needed**, see F | |

`ABNAHME_IMPL=local npm run worker` uses `buero/abnahme-local.mjs` instead of stream D's `buero/abnahme.mjs`:
the real extraction, XRechnung build, KoSIT validation and semantic checks, but **no escrow purchase and no tx hashes**.
Extraction follows `EXTRACT_MODE` (`llm` by default, uses `ANTHROPIC_API_KEY`; `fixed` only for the `*.fixed.txt` layout).

## D. Tasks (TUM workspace)

The first line of the description picks the route (`buero/sokosumi.mjs`):

- `PRÜFEN` (unpaid). Then the invoice text, plus two control lines anywhere: `Empfänger: bau-isar` (or `hv-giesing`) and
  `Betrag: 18.400,00` (expected gross total). Progress goes into Task comments. Accepted → COMPLETED with the protocol,
  the tx table and `Senden: 1 tUSDM (nur für abgenommene Rechnungen)`. Refused → COMPLETED with the German defect list, no charge.
  Any error → FAILED with the reason (`gate-failed`).
- `SENDEN <Rechnungsnummer>` (paid, 1 tUSDM through the template's masumiPayment flow). Refused with FAILED **before any payment
  request** if no PRÜFEN accepted that invoice, if it was already sent, or if paid tasks are off. After FundsLocked the § 14c guard
  (`.local/sent-ledger.json`, same invoice number or XML sha256) runs again; a duplicate ends FAILED and never submits a result.

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
(template README step 5). Only then: `PAID_TASKS_ENABLED=true` in `.env` and restart the worker. The template's `npm run api`
is **not** needed for Sokosumi paid tasks: Sokosumi buys from the `masumiPayment` event and never calls the agent API.

## F. Eve is not needed

The template's `answer()` (Eve + `ZAI_*` OpenAI-compatible model) is replaced: PRÜFEN calls `runAbnahme`, SENDEN sends mail.
`worker.mjs` no longer calls `client.health()`, so `npm start` does not have to run and `ZAI_API_KEY`/`ZAI_BASE_URL` stay empty.
`comments.mjs` still imports `client.mjs`, but it only talks to Eve for a Task with a `.local/TASK_ID-session.json`, and our flows never
write one. Consequence: follow-up user comments on a finished Task get no reply. `ZAI_MODEL` is still read once, by
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
| § 14c duplicate | Task `01a18c2e-6de2-76ca-b42e-5d48cbef591e` (second `SENDEN AR-2026-0087`): FAILED before any payment request, 0 credits |
| Withdrawn + seller receipt | TBD (unlockTime 10:11:56Z) |
