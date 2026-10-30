# Security

Abnahme is a hackathon build. It runs on Cardano **preprod** only: every wallet holds test ADA and test USDM, and no mainnet key exists. Report a vulnerability privately, not in a public issue: use GitHub private vulnerability reporting on this repository (Security tab, "Report a vulnerability"; enabled when the repository becomes public on 31 Oct 2026). Until then, or if the form is not available, e-mail altunbeyomur36@gmail.com.

This file lists what is pinned, the risks we accept for the demo, and how each one gets fixed afterwards. Findings come from the internal security review of 30 Oct 2026 (not a third-party audit).

## What is pinned

| Artifact | Pin | Where |
|---|---|---|
| KoSIT validator 1.6.3 jar | sha256 `799e64be…a7c9`, checked on every start | `kosit/start.sh` |
| XRechnung configuration 2026-08-31 | sha256 `2530cd10…21a8`, checked on every start. The rules tree is re-extracted from the verified zip before each container start, and compared with it when a validator is already running | `kosit/start.sh` |
| `eclipse-temurin:21-jre` (21.0.13+9) | index digest `0b99b337…` | `kosit/start.sh` |
| `axllent/mailpit:v1.32.0` | index digest `0790692b…` | `mail/start.sh` |
| `ghcr.io/masumi-network/masumi-payment-service:0.29.0` | digest `c7408906…` | `mps/docker-compose.yml` |
| `postgres:15` | index digest `64b99032…` | `mps/docker-compose.yml` |
| MPS setup build context | commit `71455701ac22…` (tag `0.29.0`) | `mps/docker-compose.yml` |
| `node:20-slim` (setup image base) | index digest `2cf067cf…` | `mps/docker-compose.yml` |
| npm dependencies | `package-lock.json` and `gutachter/package-lock.json` (sha512, registry.npmjs.org only), installed with `npm ci` | |
| Node.js | `>=24.2.0`, enforced by `engine-strict=true` in `.npmrc` | `package.json`, `gutachter/package.json` |
| GitHub Actions | full commit SHAs | `.github/workflows/ci.yml` |

CI fails if an image reference in these three files has no `@sha256:` digest, or if the build context is not a 40-hex commit. To move a pin, resolve the new digest with `docker buildx imagetools inspect <image>:<tag> --format '{{json .Manifest.Digest}}'` and change it deliberately in one commit.

KoSIT and Mailpit containers started by these scripts from now on run as `nobody`, with a read-only root filesystem, no capabilities, `no-new-privileges`, and memory and process limits (the running ones predate this, see below). Every port the containers publish is bound to `127.0.0.1`.

## Accepted risks for the demo

### 1. The Masumi Payment Service runs on end-of-life Node 20

`masumi-payment-service:0.29.0` holds the three hot-wallet keys and serves the admin API. It runs Node 20.20.2. So does the setup image we build, which receives `ENCRYPTION_KEY`, `ADMIN_KEY`, the wallet mnemonics and the Blockfrost key at runtime.

- Node 20 reached end of life on 30 April 2026, and 20.20.2 is its last release. Node shipped security releases in June, July and October 2026, each fixing at least one HIGH issue. End-of-life lines are always affected. The July set includes CVE-2026-58040 (HTTPS Agent session reuse can skip hostname verification) and CVE-2026-58044 (HTTP parser header truncation enables request smuggling). MPS makes HTTPS calls to Blockfrost and serves HTTP.
- `pnpm audit` on the 0.29.0 lockfile reports 9 critical and 65 high advisories. Most sit in dev and build tools or the static admin UI. A runtime subset is on the server path: `express>body-parser`, `express>proxy-addr`, `hono`, and `undici` and `ip-address` under `@meshsdk`.
- The image has no cosign signature, no build provenance and no GitHub attestation. Its only link to source is the `org.opencontainers.image.revision=71455701…` label.
- No exploit against MPS was demonstrated.

Why we accept it for the demo: preprod funds only, the API listens on `127.0.0.1:38127` only, Postgres is not published, the runtime keys are wallet-scoped, and the image and build context are now pinned, so they cannot change underneath us.

Upgrade path, after the demo (not yet rehearsed):

1. Move to MPS **0.30.0** (released 27 Oct 2026). Its `pnpm audit` reports 0 critical and 1 high, and it runs on `node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205`.
2. Do it on a copy of the `abnahme_mps_pgdata` volume, never on the live one. The 0.30.0 release notes say: "Apply the included Init migration before using the new payment-service Init guard".
3. In `mps/docker-compose.yml`, pin the 0.30.0 service image by digest and the build context to the 0.30.0 commit. Switch the inline setup Dockerfile to the same digest-pinned Node 24 base as upstream.
4. Check the result: `/api/v1/health`, wallet listing with `mps/wallets.mjs`, and that each wallet-scoped runtime key still sees only its own wallet and gets 401 on admin routes.

### 2. The running KoSIT container still has the older JRE

The live `abnahme-kosit` container was started before the pin. It runs `jdk-21.0.12.1+1` as root without the hardening flags. The OpenJDK Vulnerability Advisory of 20 Oct 2026 lists 21.0.12.1 as affected: 38 CVEs for JDK 21, three of them in `xml/jaxp` (CVE-2026-87290, CVE-2026-83400 and CVE-2026-87367), which is the stack that parses untrusted invoice XML. No exploit against KoSIT was demonstrated. The container holds no secrets, and its rules mount is read-only.

`kosit/start.sh` now leaves a running validator alone and prints a note when its image differs from the pin. To move to the pinned 21.0.13+9 image and the hardened flags, run `kosit/start.sh --replace` at a quiet moment. The validator is down for about 15 seconds, so the Gutachter answers 503 meanwhile and charges nothing.

### 3. The running Mailpit container was started without the hardening flags

The image bytes equal the pinned digest. Only the flags differ. Recreating the container deletes the messages in the demo inbox, so do it only after the evidence is captured: `docker rm -f abnahme-mailpit && mail/start.sh`.

### 4. The Sokosumi CLI is outside every lockfile

The worker reads the Coworker credential through `@masumi_network/sokosumi`. That package is a global install found through `PATH`: `sokosumi-runtime.mjs` runs `sokosumi skills path` and imports private modules from the reported path. Version 1.0.4 was published by hand without provenance and ships no shrinkwrap, so about 40 transitive packages resolve by semver range on each global install. Today's tree matches a fresh resolution and `npm audit` reports 0.

Until it is fixed, install exactly `npm install --global @masumi_network/sokosumi@1.0.4` and keep `PATH` free of user-writable directories ahead of it. The fix is to add `"@masumi_network/sokosumi": "1.0.4"` to the root `package.json`, so the lockfile covers its tree. Then resolve it with `import.meta.resolve('@masumi_network/sokosumi/package.json')`, assert the version, and stop trusting `PATH`.

### 5. `@x402/*` 2.26.0 in the Gutachter

`@x402/cardano@2.26.0` is the only version of that package published by hand, without provenance. All four `@x402/*` 2.26.0 packages are flagged high through `zod@3.25.76` (GHSA-mrhx-c7xc-m3w5). On the seller, `zod` parses only facilitator responses, and the buyer-controlled `PAYMENT-SIGNATURE` header goes through `JSON.parse`, so the advisory is not reachable from an untrusted party. This was checked by reading the code, not by fuzzing.

The fix, after the final evidence runs: pin all four to exactly `2.29.0`, which is CI-published with provenance and needs `zod ^4.6.6`. Then rerun the Gutachter tests and one paid inspection. In the same change, pin `express` exactly to `4.22.3`, which the lockfile already holds.

### 6. Root `npm audit` findings are in the template agent only

The three root advisories (`eve@0.71.0` and `@ai-sdk/provider-utils` via `undici`, and `zod@4.6.5`) sit in the Masumi template agent behind `npm start`. Abnahme's code paths load only `@anthropic-ai/sdk`, `@e-invoice-eu/core`, `@opentelemetry/api` and `standardwebhooks`. If the template agent is used, bump `zod` to 4.6.7 and `eve` to 0.90.0.

### 7. One MPS stack per host

The compose project name `abnahme-mps`, the container names and the volume `abnahme_mps_pgdata` are fixed. `mps/mps.sh` from **any** checkout on the same host therefore drives the live stack, and `mps/mps.sh down -v` from any checkout deletes the encrypted wallets. Keep one checkout per host for MPS. Because the image references now carry digests, expect the next `mps/mps.sh up -d` to recreate the service and Postgres containers once. They keep the same image bytes, and the volume is kept.
