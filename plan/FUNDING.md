# Wallet funding (Cardano Preprod)

All three wallets are MPS hot wallets on our local Masumi Payment Service (payment source `Web3CardanoV2`, Preprod).
Addresses only. The mnemonics are in `.local/mps-secrets.env` (never commit, never paste).

| # | Role | Address | tADA | tUSDM |
|---|---|---|---|---|
| 1 | Büro-Agent **selling** (Abnahme-Büro, Sokosumi Coworker) | `addr_test1qzgq06w4v4c0r63pft0wskzz58333w572qvul8cn2xwteg0mszt6smvwxweg9c38sydjwfuhvdt6v3zs8xew5szv8nusuw03qc` | min 30, ideally 1000 | none |
| 2 | RechnungsMeister **selling** | `addr_test1qpdym62fzyfmn35yrgr89qsr6nm50uxzpnndgewua7wx5qelmupkas792z774gh5ruwkd553dcf8ada86jjyf8hmvdssc92yck` | min 30, ideally 1000 | none |
| 3 | Büro-Agent **purchasing** (buys RechnungsMeister via MPS `/purchase`) | `addr_test1qpk4e2h3q36hz6tu3l9ycahvtl4q9nrufdmuu739gqetnl9zx6fhrmwf6zu84nh2rcmg8etm0yz8tk8yujdwh0psjclqusukag` | min 50, ideally 1000 | min 5, as much as the dispenser gives |

Why these amounts:
- Selling wallets: registration mint tx (NFT output plus fee), 5 tADA collateral for script txs, and fees for submit-result / authorize / withdraw on every escrow cycle.
- Purchasing wallet: every FundsLocked tx needs about 5 tADA per lock plus about 7 tADA batch overhead (MPS e2e `tests/e2e/utils/walletFunding.ts`), plus fees for request-refund and cancel-refund-request. Each escrow cycle also locks the price in tUSDM (template price 1 tUSDM, unit `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d`).

## How to fund (human operator)

1. tADA: https://docs.cardano.org/cardano-testnets/tools/faucet/ → network **Preprod**, paste address 1, then 2, then 3. One request gives far more than the minimum.
   If the faucet rate-limits you after the first address, fund only one wallet; MPS `POST /api/v1/wallet/transfer-funds` can move tADA from that hot wallet to the other two (needs your OK, it is a funds transfer).
2. tUSDM: https://dispenser.masumi.network/ → Preprod, address 3 (purchasing). Email verification can be slow.

## Check balances

```sh
PATH="/opt/homebrew/opt/node@24/bin:$PATH" node --env-file=.local/env/mps-admin.env mps/wallets.mjs
```

Status is tracked in `plan/MPS.md`.

## Stream B: x402 Gutachter buyer wallet (gate G1, Fri 11:00)

(Re-appended: an earlier copy of this section was overwritten. Please append, do not rewrite this file.)

| Role | Address | tADA |
|---|---|---|
| Gutachter x402 **buyer** (pays 1 tADA per inspection) | `addr_test1qpx5k8hyheckf8z6c9c0mmhneaypgzpuh5xyh9ds535nqe3u6zxsgctw2ew65jmvam34trmc8s7zd7dnvwrqhaesk6xqy9r5xp` | **20** (any amount of 3 or more unblocks G1) |
| Gutachter x402 seller payTo (receives payments, no funding needed) | `addr_test1qzmzrgq7ux2zmn2gn8g7ddwnewu2cuwpluxf9aatn6yjeyfv68x94frsck5pt7hgq5pjk7edjxshy5ep46aw09cuex4qg6x5ce` | 0 |

- Faucet: https://docs.cardano.org/cardano-testnets/tools/faucet/ (network Preprod). If the faucet rate-limits you, any funded preprod wallet can send 20 tADA to the buyer address instead.
- Check: `cd gutachter && npm run balance` or https://preprod.cardanoscan.io/address/addr_test1qpx5k8hyheckf8z6c9c0mmhneaypgzpuh5xyh9ds535nqe3u6zxsgctw2ew65jmvam34trmc8s7zd7dnvwrqhaesk6xqy9r5xp
- Secrets: `GUTACHTER_BUYER_MNEMONIC`, `GUTACHTER_SELLER_MNEMONIC` in `.env` (gitignored).
