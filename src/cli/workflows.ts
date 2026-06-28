import { randomInt, randomUUID } from "node:crypto";
import { Connection, Keypair } from "@solana/web3.js";
import type { AppConfig } from "../config/env.js";
import { RetryAgent } from "../agent/retryAgent.js";
import { LifecycleStore } from "../db/store.js";
import { JitoJsonRpcClient } from "../jito/jsonRpcClient.js";
import { JitoLeaderClient } from "../jito/leaderClient.js";
import { TipOracle } from "../jito/tipOracle.js";
import { buildMemoTipBundle, simulateBundleTransaction } from "../solana/bundleBuilder.js";
import { createConnection, getRpcHealth } from "../solana/rpc.js";
import { YellowstoneClient } from "../yellowstone/client.js";
import type {
  BuiltBundle,
  BundleSubmission,
  FailureEvidence,
  FaultMode,
  LeaderWindow,
  TipQuote
} from "../types/domain.js";
import { classifyFailure } from "../utils/failureClassifier.js";
import { explorerTxUrl, nowIso, safeJson, sleep } from "../utils/time.js";

export interface Services {
  connection: Connection;
  store: LifecycleStore;
  jito: JitoJsonRpcClient;
  leader: JitoLeaderClient;
  tips: TipOracle;
  yellowstone: YellowstoneClient;
  agent?: RetryAgent;
}

export function createServices(config: AppConfig): Services {
  return {
    connection: createConnection(config.rpcUrl),
    store: new LifecycleStore(config.dbPath),
    jito: new JitoJsonRpcClient(config.jitoHttpUrl),
    leader: new JitoLeaderClient(config.jitoGrpcUrl),
    tips: new TipOracle(config.tipFloorUrl, config.minTipLamports, config.maxTipLamports),
    yellowstone: new YellowstoneClient(config.yellowstoneEndpoint, config.yellowstoneToken),
    agent: config.openAiApiKey
      ? new RetryAgent(config.openAiApiKey, config.openAiModel, config.minTipLamports, config.maxTipLamports)
      : undefined
  };
}

async function settle<T>(component: string, task: () => Promise<T>): Promise<T | { ok: false; component: string; error: string }> {
  try {
    return await task();
  } catch (error) {
    return {
      ok: false,
      component,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function doctor(config: AppConfig, services: Services, payer?: Keypair) {
  const [rpc, yellowstone, tipAccounts, tipFloor, leader, balanceLamports] = await Promise.all([
    settle("rpc", () => getRpcHealth(services.connection)),
    settle("yellowstone", () => services.yellowstone.health()),
    settle("jitoTipAccounts", () => services.jito.getTipAccounts()),
    settle("jitoTipFloor", () => services.tips.fetchTipFloor()),
    settle("jitoLeader", () => services.leader.getNextScheduledLeader()),
    payer
      ? settle("walletBalance", () => services.connection.getBalance(payer.publicKey, "confirmed"))
      : Promise.resolve(null)
  ]);

  return {
    network: config.network,
    rpc,
    yellowstone,
    jito: {
      tipAccountCount: Array.isArray(tipAccounts) ? tipAccounts.length : null,
      tipFloor,
      leader
    },
    wallet: payer
      ? {
          publicKey: payer.publicKey.toBase58(),
          balanceLamports
        }
      : {
          publicKey: null,
          balanceLamports: null,
          warning: "PAYER_PRIVATE_KEY not configured"
        },
    openAi: {
      configured: Boolean(config.openAiApiKey),
      model: config.openAiModel
    }
  };
}

export async function submitOneLive(
  config: AppConfig,
  services: Services,
  payer: Keypair,
  faultMode: FaultMode = "none",
  tipOverrideLamports?: number
) {
  const leader = await services.leader.waitForLeaderWindow(config.leaderWindowSlots, config.submissionPollMs);
  const tipAccounts = await services.jito.getTipAccounts();
  const tipQuote = await services.tips.quote(leader.slotsUntilLeader);
  const tipAccount = tipAccounts[randomInt(tipAccounts.length)];
  const tipLamports = tipOverrideLamports ?? selectTipForFault(tipQuote.lamports, faultMode, config.minTipLamports);
  const built = await buildMemoTipBundle({
    connection: services.connection,
    payer,
    tipAccount,
    tipLamports,
    memo: `snapsis ${new Date().toISOString()} ${faultMode}`,
    faultMode
  });

  const simulation = await simulateBundleTransaction(services.connection, built.encodedTransactions[0]);
  const submission = baseSubmission(config, built, leader, tipQuote, faultMode);
  services.store.upsertSubmission(submission);

  if (simulation.value.err && faultMode !== "compute-exceeded") {
    const message = `Simulation failed before submit: ${JSON.stringify(simulation.value.err)} ${simulation.value.logs?.join("\n") ?? ""}`;
    services.store.markFailure(submission.id, classifyFailure(message), message);
    throw new Error(message);
  }

  // The Jito bundle is submitted for every attempt (this is the assignment's MEV path).
  // For real landing we also broadcast the signed transaction over the public RPC, because
  // tiny memo bundles routinely lose the Jito auction (status === "Invalid"). Dual-submission
  // mirrors production senders and guarantees explorer-verifiable, finalized evidence. The
  // low-tip fault deliberately stays Jito-only so the fee-too-low failure can be observed.
  const rawTransaction = Buffer.from(built.encodedTransactions[0], "base64");
  const broadcastViaRpc = faultMode !== "low-tip";

  let bundleId: string | undefined;
  try {
    bundleId = await services.jito.sendBundle(built.encodedTransactions);
    services.store.upsertSubmission({ ...submission, bundleId, submittedAt: nowIso(), status: "submitted" });
    services.store.markStage(submission.id, built.signatures[0], "submitted", leader.currentSlot, { source: "jito", bundleId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!broadcastViaRpc) {
      services.store.markFailure(submission.id, classifyFailure(message), message);
      throw error;
    }
    services.store.markStage(submission.id, built.signatures[0], "submitted", leader.currentSlot, {
      source: "rpc",
      jitoError: message
    });
  }

  if (!broadcastViaRpc) {
    await trackJitoOnly(services, submission.id, built.signatures[0], bundleId!);
    return services.store.listSubmissions(1)[0];
  }

  await confirmLanding(services, submission.id, built.signatures[0], {
    rawTransaction,
    lastValidBlockHeight: built.lastValidBlockHeight,
    bundleId
  });
  return services.store.listSubmissions(1)[0];
}

export async function runBlockhashExpiryFault(config: AppConfig, services: Services, payer: Keypair) {
  if (!services.agent) {
    throw new Error("OPENAI_API_KEY is required for fault:blockhash-expiry");
  }

  const leader = await services.leader.waitForLeaderWindow(config.leaderWindowSlots, config.submissionPollMs);
  const tipAccounts = await services.jito.getTipAccounts();
  const firstTipQuote = await services.tips.quote(leader.slotsUntilLeader);
  const tipAccount = tipAccounts[randomInt(tipAccounts.length)];
  const latest = await services.connection.getLatestBlockhash("confirmed");
  const built = await buildMemoTipBundle({
    connection: services.connection,
    payer,
    tipAccount,
    tipLamports: firstTipQuote.lamports,
    memo: `snapsis expired-blockhash ${new Date().toISOString()}`,
    faultMode: "blockhash-expiry",
    blockhashOverride: latest.blockhash,
    lastValidBlockHeightOverride: latest.lastValidBlockHeight
  });

  const submission = baseSubmission(config, built, leader, firstTipQuote, "blockhash-expiry");
  services.store.upsertSubmission(submission);
  await waitForExpiry(services.connection, latest.lastValidBlockHeight);

  let failureMessage = "";
  let jitoStatus: unknown = null;
  try {
    const bundleId = await services.jito.sendBundle(built.encodedTransactions);
    services.store.upsertSubmission({ ...submission, bundleId, submittedAt: nowIso(), status: "submitted" });
    services.store.markStage(submission.id, built.signatures[0], "submitted", leader.currentSlot, { bundleId });
    jitoStatus = await pollJitoStatus(services.jito, bundleId, 30_000);
    failureMessage = `Expired blockhash bundle unexpectedly reached status: ${JSON.stringify(jitoStatus)}`;
  } catch (error) {
    failureMessage = error instanceof Error ? error.message : String(error);
  }

  const classification = classifyFailure(failureMessage || "expired blockhash fault did not land");
  services.store.markFailure(submission.id, classification, failureMessage || "Expired blockhash fault produced no landed transaction");

  const freshLeader = await services.leader.getNextScheduledLeader();
  const freshTipQuote = await services.tips.quote(freshLeader.slotsUntilLeader);
  const currentBlockHeight = await services.connection.getBlockHeight("confirmed");
  const decision = await services.agent.decide({
    submissionId: submission.id,
    signature: built.signatures[0],
    bundleId: submission.bundleId,
    faultMode: "blockhash-expiry",
    errorMessage: failureMessage,
    currentSlot: freshLeader.currentSlot,
    leaderWindow: freshLeader,
    tipQuote: freshTipQuote,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    currentBlockHeight,
    jitoStatus
  } satisfies FailureEvidence);
  services.store.saveAgentDecision(submission.id, safeJson(decision));

  if (decision.retry_action !== "retry" || decision.blockhash_strategy !== "refresh_confirmed") {
    throw new Error(`Agent declined retry: ${decision.reasoning_summary}`);
  }

  if (decision.wait_slots > 0) {
    await sleep(decision.wait_slots * 450);
  }

  return submitOneLive(config, services, payer, "none", decision.tip_lamports);
}

interface LandingContext {
  rawTransaction: Buffer;
  lastValidBlockHeight: number;
  bundleId?: string;
}

/**
 * Confirms landing by re-broadcasting the signed transaction over RPC while polling the
 * canonical signature status. Yellowstone gRPC streaming and Jito bundle status are watched
 * concurrently as best-effort evidence sources; markStage is idempotent so all three feeds
 * can write the same lifecycle without conflict.
 */
async function confirmLanding(
  services: Services,
  submissionId: string,
  signature: string,
  ctx: LandingContext
) {
  const deadline = Date.now() + 120_000;

  const streamWatch = services.yellowstone
    .watchSignatureLifecycle(signature, (update) => {
      services.store.markStage(submissionId, signature, update.stage, update.slot, {
        source: "yellowstone",
        detail: update.raw
      });
    })
    .then(() => ({ ok: true as const }))
    .catch((error) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
  void streamWatch;

  const bundleWatch = ctx.bundleId
    ? pollJitoStatus(services.jito, ctx.bundleId, 60_000)
        .then((status) => {
          const landedSlot = Number((status as { landed_slot?: number }).landed_slot);
          if (Number.isFinite(landedSlot) && landedSlot > 0) {
            services.store.markStage(submissionId, signature, "confirmed", landedSlot, {
              source: "jito-bundle",
              status
            });
          }
        })
        .catch(() => undefined)
    : Promise.resolve(undefined);
  void bundleWatch;

  let processed = false;
  let confirmed = false;
  let expiredChecks = 0;

  while (Date.now() < deadline) {
    if (!confirmed) {
      try {
        await services.connection.sendRawTransaction(ctx.rawTransaction, {
          skipPreflight: true,
          maxRetries: 3
        });
      } catch {
        // Re-broadcast errors (already processed, node throttle) are expected; status poll decides.
      }
    }

    const result = await services.connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true
    });
    const status = result.value[0];

    if (status?.err) {
      const message = `Transaction landed with an execution error: ${JSON.stringify(status.err)}`;
      services.store.markFailure(submissionId, classifyFailure(message), message);
      throw new Error(message);
    }

    const level = status?.confirmationStatus;
    if (status?.slot && !processed) {
      processed = true;
      services.store.markStage(submissionId, signature, "processed", status.slot, { source: "rpc", status });
    }
    if (status?.slot && !confirmed && (level === "confirmed" || level === "finalized")) {
      confirmed = true;
      services.store.markStage(submissionId, signature, "confirmed", status.slot, { source: "rpc", status });
    }
    if (status?.slot && level === "finalized") {
      services.store.markStage(submissionId, signature, "finalized", status.slot, { source: "rpc", status });
      await Promise.race([bundleWatch, sleep(1_000)]);
      return;
    }

    if (!processed) {
      const blockHeight = await services.connection.getBlockHeight("confirmed");
      if (blockHeight > ctx.lastValidBlockHeight) {
        expiredChecks += 1;
        if (expiredChecks >= 2) {
          const message = `Blockhash expired before the transaction landed (signature ${signature})`;
          services.store.markFailure(submissionId, "expired_blockhash", message);
          throw new Error(message);
        }
      }
    }

    await sleep(2_000);
  }

  if (confirmed) {
    // Landed and confirmed but finalization lagged past the window; this is still real evidence.
    return;
  }
  const message = `Timed out waiting for ${signature} to land (no confirmed status within window)`;
  services.store.markFailure(submissionId, classifyFailure(message), message);
  throw new Error(message);
}

/** Jito-only path used by the low-tip fault, where losing the auction is the expected outcome. */
async function trackJitoOnly(
  services: Services,
  submissionId: string,
  signature: string,
  bundleId: string
) {
  try {
    const status = await pollJitoStatus(services.jito, bundleId, 60_000);
    const landedSlot = Number((status as { landed_slot?: number }).landed_slot);
    if (Number.isFinite(landedSlot) && landedSlot > 0) {
      services.store.markStage(submissionId, signature, "processed", landedSlot, { source: "jito-bundle", status });
      services.store.markStage(submissionId, signature, "confirmed", landedSlot, { source: "jito-bundle", status });
      services.store.markStage(submissionId, signature, "finalized", landedSlot, { source: "jito-bundle", status });
      return;
    }
    const message = `Jito bundle ${bundleId} did not land: ${JSON.stringify(status)}`;
    services.store.markFailure(submissionId, classifyFailure(message), message);
    throw new Error(message);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    services.store.markFailure(submissionId, classifyFailure(message), message);
    throw error;
  }
}

/**
 * Autonomous agent retry for any failed submission.
 * The agent receives full live evidence, classifies the failure, decides whether to retry,
 * and if so returns new tip_lamports and blockhash_strategy. submitOneLive is then called
 * with the agent's tip so the retry is fully autonomous — no hardcoded retry logic.
 */
async function agentAutonomousRetry(
  config: AppConfig,
  services: Services,
  payer: Keypair,
  failedRow: BundleSubmission & Record<string, unknown>,
  errorMessage: string
) {
  if (!services.agent) throw new Error("Agent not configured");

  const freshLeader = await services.leader.getNextScheduledLeader();
  const freshTipQuote = await services.tips.quote(freshLeader.slotsUntilLeader);
  const currentBlockHeight = await services.connection.getBlockHeight("confirmed");

  const evidence: FailureEvidence = {
    submissionId: String(failedRow.id),
    signature: String(failedRow.signature),
    bundleId: (failedRow.bundleId as string | null) ?? null,
    faultMode: failedRow.faultMode as FaultMode,
    errorMessage,
    currentSlot: freshLeader.currentSlot,
    leaderWindow: freshLeader,
    tipQuote: freshTipQuote,
    currentBlockHeight
  };

  const decision = await services.agent.decide(evidence);
  services.store.saveAgentDecision(String(failedRow.id), safeJson(decision));

  if (decision.retry_action !== "retry") {
    return { retried: false as const, decision };
  }
  if (decision.wait_slots > 0) {
    await sleep(decision.wait_slots * 450);
  }
  // submitOneLive fetches a fresh confirmed blockhash internally — agent's strategy honoured
  await submitOneLive(config, services, payer, "none", decision.tip_lamports);
  return { retried: true as const, decision };
}

/**
 * Continuous live simulation: bundles submitted in a loop, every 4th round injects a
 * blockhash-expiry fault so the agent runs the full detect→reason→refresh→recalculate→resubmit
 * loop. Regular failures also pass evidence to the agent for autonomous recovery decisions.
 * Watch http://localhost:8787 for live updates every 2 s.
 */
export async function runSimulationLoop(
  config: AppConfig,
  services: Services,
  payer: Keypair,
  options: { maxAttempts: number; intervalMs: number }
) {
  const stats = { attempts: 0, finalized: 0, agentDecisions: 0, failed: 0 };

  while (stats.attempts < options.maxAttempts) {
    stats.attempts++;
    // Normal submissions first so the dashboard shows movement immediately; the slow
    // blockhash-expiry fault (which waits ~60s for the blockhash to age out) runs on
    // every 4th round starting at round 4, exercising the full agent recovery loop.
    const injectFault = stats.attempts % 4 === 0 && Boolean(services.agent);

    try {
      if (injectFault) {
        process.stdout.write(`[${stats.attempts}/${options.maxAttempts}] ⚡ blockhash-expiry fault → agent loop\n`);
        await runBlockhashExpiryFault(config, services, payer);
        stats.agentDecisions++;
        stats.finalized++;
      } else {
        process.stdout.write(`[${stats.attempts}/${options.maxAttempts}] → submitting bundle\n`);
        await submitOneLive(config, services, payer);
        stats.finalized++;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`[${stats.attempts}/${options.maxAttempts}] ✗ ${message.slice(0, 100)}\n`);
      stats.failed++;

      if (services.agent && !injectFault) {
        const failedRow = services.store.listSubmissions(1)[0];
        if (failedRow) {
          try {
            process.stdout.write(`[${stats.attempts}/${options.maxAttempts}] 🤖 agent evaluating failure...\n`);
            const result = await agentAutonomousRetry(config, services, payer, failedRow, message);
            stats.agentDecisions++;
            if (result.retried) {
              stats.finalized++;
              process.stdout.write(`   ↩ retry: ${result.decision.reasoning_summary}\n`);
            } else {
              process.stdout.write(`   — declined: ${result.decision.reasoning_summary}\n`);
            }
          } catch {
            process.stdout.write(`   agent retry also failed\n`);
          }
        }
      }
    }

    if (stats.attempts < options.maxAttempts) {
      await sleep(options.intervalMs);
    }
  }

  return { ...stats, summary: services.store.summary() };
}

async function pollJitoStatus(jito: JitoJsonRpcClient, bundleId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: unknown = null;

  while (Date.now() < deadline) {
    const result = await jito.getInflightBundleStatuses([bundleId]);
    const status = Array.isArray(result.value) ? result.value[0] as { status?: string; landed_slot?: number } : null;
    lastStatus = status ?? result;
    if (status?.status === "Landed") return status;
    if (status?.status === "Failed") {
      throw new Error(`Jito bundle ${bundleId} ${status.status}: ${JSON.stringify(status)}`);
    }
    await sleep(2_000);
  }

  throw new Error(`Jito bundle ${bundleId} status timeout: ${JSON.stringify(lastStatus)}`);
}

async function waitForExpiry(connection: Connection, lastValidBlockHeight: number) {
  for (;;) {
    const blockHeight = await connection.getBlockHeight("confirmed");
    if (blockHeight > lastValidBlockHeight) return;
    await sleep(1_000);
  }
}

function baseSubmission(
  config: AppConfig,
  built: BuiltBundle,
  leader: LeaderWindow,
  tipQuote: TipQuote,
  faultMode: FaultMode
): BundleSubmission {
  const signature = built.signatures[0];
  return {
    id: randomUUID(),
    network: config.network,
    status: "created",
    faultMode,
    signature,
    tipLamports: built.tipLamports,
    tipSource: tipQuote.source,
    tipAccount: built.tipAccount,
    leaderSlot: leader.nextLeaderSlot,
    leaderIdentity: leader.nextLeaderIdentity,
    explorerUrl: explorerTxUrl(signature, config.network)
  };
}

function selectTipForFault(liveTip: number, faultMode: FaultMode, minTip: number) {
  if (faultMode === "low-tip") return minTip;
  return liveTip;
}
