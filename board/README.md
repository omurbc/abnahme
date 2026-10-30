# Abnahme-Board

A live web view of the Abnahme agents for the demo and the booth: what the Büro-Agent, RechnungsMeister and Gutachter already write, drawn as one escrow timeline per invoice, updated over Server-Sent Events. Plain Node (`node:http`), no framework, no new dependency, no external fonts or CDNs. It works offline.

## Start

```sh
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"     # Node 24.2+
node scripts/env-split.mjs                            # once: writes .local/env/board.env (Blockfrost + read-only MPS key)
node --env-file=.local/env/board.env --import=./scripts/env-guard.mjs board/server.mjs
# → http://127.0.0.1:8787   (BOARD_PORT to change it)
```

In the background, with a log file:

```sh
nohup node --env-file=.local/env/board.env --import=./scripts/env-guard.mjs board/server.mjs >> .local/board.log 2>&1 &
```

`?theme=dark` or `?theme=light` in the URL forces a theme (handy for recording). The moon button toggles it and remembers the choice.

## What each view shows

| View | Content | Source |
|---|---|---|
| Product header | Value proposition, "How it works", the planned mainnet price, "Order on Sokosumi" | static |
| **Live** (`#live`, or `#live/<journal id>`) | The board's own demo run while it runs, else the newest job that is still moving, else the newest job. Invoice card, the four agents with the money rails (Masumi escrow 1 tUSDM, x402 1 tADA per inspection), the escrow stepper (Funds locked → Work delivered → Inspection 1 → Defect notice (Mängelrüge, § 640(2)) → Cure (Nachbesserung, § 635) → Inspection 2 → Acceptance (Abnahme, § 640(1)) → Paid (§ 641(1)) → E-invoice sent), each step with time, tx link, confirmations. The refusal branch (Refund authorized → Money back), the protective defect notice (ESCROW-1) and deemed acceptance (§ 640(2)) get their own steps. Panels: the MANGEL stamp with the defects (English line plus the German KoSIT text), the cure diff (e.g. BT-48: empty → DE287654321, with its source), the ABGENOMMEN stamp, the payout and the e-mail card. The acceptance log is the agent's own German journal. | journals, RechnungsMeister job files, Gutachter log, MPS, Blockfrost, send ledger + Mailpit |
| **History** (`#history`) | Every job in the journal: status, invoice, recipient, amount, path, inspection mode, origin (Sokosumi Task, CLI or board), start, duration. Click a row to open it in Live. | same |
| **Evidence** (`#evidence`) | Every preprod tx with type, time, Cardanoscan link, rail (escrow, x402, registry, Sokosumi, funding), run and source. Filters per rail. | journals, `gutachter/payments.log.json`, `plan/EVIDENCE.md`, `README.md` |

What is live and what is not:

- **Live:** the journals in `.local/abnahme-journal/` (re-read when their mtime changes, every 2 s), RechnungsMeister job files, the Gutachter log, the Sokosumi Task files, the send ledger. MPS `GET /purchase` and `GET /payment` (every 6 s while a job runs, else every 60 s) give tx hashes before the journal has them and the block height of each. Blockfrost `/blocks/latest` (every 20 s) turns heights into confirmations; `/txs/{hash}` is asked once for x402 txs of the live job. Mailpit `GET /api/v1/messages` every 10 s.
- **Matching rules, kept strict:** an e-mail belongs to a job only if that job's purchase accepted exactly the mailed XML (sha256) before it was sent (`.local/abnahmen.json` + `.local/sent-ledger.json`). The "Demo mode" note appears only when `DEMO_SEED_DEFECT=1` actually caused the job's first defect. A run without progress for 45 min shows as "Stalled". An old ALARM line is not shown after a later resume settled the job.
- **Static:** the product header and the pricing card ("planned mainnet price").

## Demo button

"Start demo" (two clicks: the first arms it for 5 s) starts **one** real escrow run, a fresh copy of `fixtures/b-abschlag-13b-bau-isar.txt` with a new invoice number `AR-2026-D<hhmmss>` (the engine refuses to buy twice for identical text):

```sh
node --env-file=.local/env/buero.env --import=./scripts/env-guard.mjs buero/run.mjs <temp copy> bau-isar 18400.00 --follow
```

**Each click spends 1 tUSDM, plus 1 tADA per x402 inspection.** The button is disabled while that run lives. The lock is kept in `.local/board-demo.json`, so a board restart does not allow a second run. The run's output goes to `.local/board-demo.log`, and `run.mjs` appends its tx table to `plan/EVIDENCE.md` as usual. The child gets a clean environment (`PATH`, `HOME`) and only its own env file, never the board's keys.

## Security

- **Loopback only.** The server binds `127.0.0.1` and refuses any other peer, plus any `Host` header other than `127.0.0.1:<port>` / `localhost:<port>` (DNS rebinding).
- **Read-only, except the demo button.** Every other route is `GET`; others get 405. No request goes to the RechnungsMeister API (its job files are read instead, so no job token is ever used), and all MPS calls are `GET`s with the read-only key (`canRead`, no wallet scope).
- **The demo POST** needs the board's own `Origin`, `Sec-Fetch-Site: same-origin` if sent, a per-start random nonce from the page (`x-board-nonce`, compared in constant time) and `Content-Type: application/json`. Without CORS headers, no other page can send it or read the nonce.
- **No secrets leave the server.** The `board` env profile holds only `BLOCKFROST_API_KEY_PREPROD` and `MPS_READ_TOKEN`, and `env-guard` refuses to start with any other project secret. Journals and job files are reduced to safe fields first (`safeJournal`, `safeRmJob`, `safeLedger` in `model.mjs`): job tokens, nonces, invoice texts and the delivered XML never reach a response, and absolute local paths in engine messages are cut to their file name. Shown invoice data is the fictional fixture data. Strict CSP (`default-src 'none'`, scripts and styles only from the board itself), `no-store`, `nosniff`, `no-referrer`.

## Files and tests

| File | Role |
|---|---|
| `server.mjs` | aggregation, pollers, SSE (`/api/events`), `/api/state`, `/api/jobs/<id>`, `/api/evidence`, `POST /api/demo` |
| `model.mjs` | pure functions: journal (+ job file, payments, mail, MPS txs) → timeline, summary, evidence |
| `public/` | `index.html`, `app.js`, `styles.css`, `favicon.svg` |
| `fixtures/` | five real journals of recorded preprod runs (cure with x402 + e-mail, deemed acceptance, refusal, protective notice, CHEAT refusal) and their RechnungsMeister jobs, with `job_token`, `token`, `response` and the KoSIT report XML dropped |

```sh
node --test board/*.test.mjs     # also part of npm test
```

`model.test.mjs` checks every branch on the real journals, plus the running states cut from them. `server.test.mjs` runs the server on a temporary copy with a fake fetch and a fake demo runner: request guards, the one-run lock, the mail link, and that keys only leave as read-only requests to their own service.
