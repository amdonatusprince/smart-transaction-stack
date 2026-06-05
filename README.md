# Smart Transaction Stack

Live Solana transaction infrastructure prototype for the Advanced Infrastructure Challenge.

It submits real Jito bundles, watches Yellowstone/Geyser streams, tracks lifecycle stages, records evidence, and uses an OpenAI agent to make autonomous retry decisions after a blockhash-expiry fault.

## What This Builds

- `txstack doctor` verifies Solana RPC, Yellowstone gRPC, Jito, wallet balance, and OpenAI config.
- `txstack run` submits real bundles and records lifecycle evidence.
- `txstack fault:blockhash-expiry` injects an expired-blockhash failure and asks the AI agent to decide the retry.
- `txstack dashboard` opens a local read-only dashboard over real stored evidence.
- `txstack export` writes judge-ready JSONL and CSV.

No lifecycle mock data is generated. Devnet tests use real devnet RPC values only; Jito bundle tests require mainnet because Jito bundle infrastructure is not exposed on devnet.

## Setup

```bash
pnpm install
cp .env.example .env
```

Edit `.env`:

- `SOLANA_RPC_URL`
- `YELLOWSTONE_ENDPOINT`
- `YELLOWSTONE_X_TOKEN`
- `PAYER_KEYPAIR_PATH`
- `OPENAI_API_KEY`

The payer needs enough SOL for real mainnet fees and small Jito tips.

## Commands

```bash
pnpm run doctor
pnpm dev -- run --count 10 --live
pnpm dev -- fault:blockhash-expiry --live
pnpm run dashboard
pnpm run export
```

Live submission commands require `--live` so an operator cannot spend SOL by accident.

## README Questions

### 1. What does the delta between `processed_at` and `confirmed_at` tell you about network health?

It measures how long optimistic processing took to receive cluster vote confidence. Small deltas usually mean healthy propagation and voting. Larger deltas suggest leader, propagation, vote, or congestion issues around the submitted slot.

### 2. Why should you never use finalized commitment when fetching a blockhash for a time-sensitive transaction?

Finalized blockhashes are safer from fork risk but much older. Solana blockhashes expire after a short recent-blockhash window, so using finalized can burn valuable lifetime before the transaction is even signed or submitted.

### 3. What happens to your bundle if the Jito leader skips their slot?

Bundles execute within a leader slot and do not cross slot boundaries. If the targeted Jito leader skips the slot, the bundle may not land and can become pending, failed, or invalid depending on block-engine handling and expiry. The stack detects that through Jito status plus Yellowstone absence and can retry with a refreshed blockhash.

## Architecture Document

See [docs/architecture.md](docs/architecture.md) for the full judged architecture write-up and [docs/architecture-animated.html](docs/architecture-animated.html) for the animated execution walkthrough. Publish one or both to a public Google Doc, Notion page, Figma board, or static URL before submission.
