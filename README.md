# Smart Transaction Stack

Live Solana transaction infrastructure prototype for the Advanced Infrastructure Challenge.

The stack submits real Jito bundles, watches Yellowstone/Geyser streams, tracks transaction lifecycle stages, records evidence, and uses an OpenAI agent to make the autonomous retry decision after a blockhash-expiry fault.

## Submission Status

| Requirement | Status | Evidence |
| --- | --- | --- |
| Open-source code | Covered | This repository contains the TypeScript/Node implementation. |
| Architecture document | Covered | [docs/architecture.md](docs/architecture.md) and [docs/architecture-animated.html](docs/architecture-animated.html). |
| Working prototype | Covered in code, requires operator-funded live run for final evidence | Mainnet Jito path is implemented behind `--live`. |
| Yellowstone/Geyser streaming | Covered | `src/yellowstone/client.ts` tracks signature and slot commitment updates. |
| Jito bundles | Covered | `src/jito/jsonRpcClient.ts` calls `sendBundle`; `src/solana/bundleBuilder.ts` builds signed bundle transactions. |
| Dynamic tips | Covered | `src/jito/tipOracle.ts` reads live Jito tip-floor data and clamps by safety rails. |
| AI agent demonstration | Covered in code, requires live evidence run | `fault:blockhash-expiry` asks OpenAI for the retry decision. |
| 10 real lifecycle logs | Not generated yet | Run `pnpm dev -- run --count 10 --faults blockhash-expiry,compute-exceeded --live`. |
| At least 2 failure cases | Not generated yet | Use `blockhash-expiry` and `compute-exceeded` fault modes during the live run. |

No lifecycle mock data is generated. `data/lifecycle/` stays empty until real bundle submissions write evidence.

## What This Builds

- `doctor`: verifies Solana RPC, Yellowstone gRPC, Jito, wallet balance, and OpenAI config.
- `run`: submits real bundles and records lifecycle evidence.
- `fault:blockhash-expiry`: injects an expired-blockhash failure and asks the AI agent to decide the retry.
- `dashboard`: opens a local read-only dashboard over real stored evidence.
- `export`: writes judge-ready JSONL and CSV.

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

The payer must hold enough SOL for real mainnet transaction fees and small Jito tips.

## Read-Only Tests

These do not spend SOL:

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm run test:live:devnet
pnpm run doctor
pnpm run test:live:mainnet
```

`test:live:devnet` reads real devnet RPC values. `test:live:mainnet` reads real Jito mainnet tip accounts, tip floor, and leader data without submitting bundles.

## Live Evidence Run

Final bounty evidence requires real bundle submissions. Use a funded mainnet payer and OpenAI key:

```bash
pnpm dev -- run --count 10 --faults blockhash-expiry,compute-exceeded --live
pnpm run export
pnpm run dashboard
```

Expected evidence files after the run:

```text
data/lifecycle/txstack.sqlite
data/lifecycle/lifecycle-<timestamp>.jsonl
data/lifecycle/lifecycle-<timestamp>.csv
```

Dashboard:

```text
http://localhost:8787
```

## Operational Observations To Include After Live Run

After running the 10 real submissions, update this section with:

- min/median/max `processed_at -> confirmed_at` delta
- fastest and slowest landed bundles
- tip range used in lamports
- number of finalized submissions
- number of failed submissions
- failure classifications observed
- whether the blockhash-expiry retry resubmitted successfully

The README answers below are correct operationally, but the final submission will score higher if these are backed by the exported run data.

## Required README Questions

### Question 1: What does the delta between `processed_at` and `confirmed_at` tell you about network health at the time of submission?

The `processed_at -> confirmed_at` delta measures how long it took for a transaction that was observed in a processed slot to receive enough cluster vote confidence to become confirmed.

A small delta usually means:

- the leader produced and propagated the block normally
- validators received the block quickly
- voting was healthy
- the transaction was not stuck behind abnormal fork or propagation delays

A large delta can indicate:

- network congestion or propagation lag
- slow vote lockout progress
- leader or shred propagation issues
- temporary fork uncertainty
- a generally unhealthy submission window

This delta is more useful than a single landed/not-landed boolean because it shows the quality of the landing window. A transaction can land but still reveal poor network conditions if confirmation lags after processing.

### Question 2: Why should you never use finalized commitment when fetching a blockhash for a time-sensitive transaction?

Finalized blockhashes are older than confirmed or processed blockhashes. For time-sensitive transactions, that age matters because Solana blockhashes are only valid for a short recent-blockhash window.

Using `finalized` for a fresh bundle can waste a meaningful part of the blockhash lifetime before the transaction is even signed, sent to Jito, propagated, auctioned, and executed. That increases the chance of `BlockhashNotFound` or blockheight-expiry failures.

This stack fetches blockhashes with `confirmed` commitment because it balances recency and fork safety. It avoids `finalized` for submission-time blockhashes, and the fault-injection path deliberately proves what happens when a signed transaction is allowed to expire.

### Question 3: What happens to your bundle if the Jito leader skips their slot?

Jito bundles are targeted at leader execution and do not carry a guarantee that they will land across later slots. If the Jito leader skips the targeted slot, the bundle may never execute in that slot. Depending on timing, blockhash validity, and block-engine handling, it can remain pending for a short period, become failed/invalid, or simply not produce a streamed transaction lifecycle.

Operationally, the correct response is:

- do not assume submission equals landing
- watch Jito bundle status
- watch Yellowstone for the target signature
- refresh the blockhash if validity is at risk
- recalculate the tip from current live conditions
- retry in a later valid leader window when appropriate

This is why the stack tracks both Jito status and Yellowstone lifecycle events.

## Technical Expectations Mapping

| Expectation | Implementation |
| --- | --- |
| Correct slot streaming | Yellowstone stream subscribes to transaction/status and slot commitment updates. |
| Reconnection/backpressure handling | The stream is scoped to one target signature plus slots, sends keepalive pings, times out instead of hanging forever, and cleans up streams after completion/error. The current prototype fails closed on stream errors rather than inventing lifecycle state. |
| Real Jito bundle construction | Versioned transaction with memo plus transfer to a real Jito tip account, encoded and sent through `sendBundle`. |
| Dynamic tip logic from live data | Tip oracle reads live Jito tip-floor percentiles and tip accounts; no hardcoded final tip value. |
| Proper commitment use | Fetches blockhashes at `confirmed`; tracks processed/confirmed/finalized separately. |
| AI layer separation | OpenAI retry agent lives in `src/agent/retryAgent.ts`; it has no keypair access and cannot submit transactions directly. |
| Core stack separation | Jito, Solana RPC, Yellowstone, storage, dashboard, and AI each have separate modules. |
| Failure handling | Failure classifier covers expired blockhash, fee too low, compute exceeded, bundle failure, stream timeout, and unknown. |
| Happy path plus failure path | Normal `run` path plus `blockhash-expiry`, `compute-exceeded`, and `low-tip` fault modes. |

## Architecture Document

See [docs/architecture.md](docs/architecture.md) for the full judged architecture write-up and [docs/architecture-animated.html](docs/architecture-animated.html) for the animated execution walkthrough. Publish one or both to a public Google Doc, Notion page, Figma board, or static URL before submission.

To view the animated walkthrough locally:

```bash
open docs/architecture-animated.html
```
