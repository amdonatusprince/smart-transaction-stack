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

export async function doctor(config: AppConfig, services: Services, payer?: Keypair) {
  const rpc = await getRpcHealth(services.connection);
  const [yellowstone, tipAccounts, tipFloor, leader] = await Promise.all([
    services.yellowstone.health(),
    services.jito.getTipAccounts(),
    services.tips.fetchTipFloor(),
    services.leader.getNextScheduledLeader()
  ]);
  const balanceLamports = payer ? await services.connection.getBalance(payer.publicKey, "confirmed") : null;

  return {
    network: config.network,
    rpc,
    yellowstone,
    jito: {
      tipAccountCount: tipAccounts.length,
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
    memo: `smart-transaction-stack ${new Date().toISOString()} ${faultMode}`,
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

  try {
    const bundleId = await services.jito.sendBundle(built.encodedTransactions);
    services.store.upsertSubmission({ ...submission, bundleId, submittedAt: nowIso(), status: "submitted" });
    services.store.markStage(submission.id, built.signatures[0], "submitted", leader.currentSlot, { bundleId });
    await trackSubmittedBundle(services, submission.id, built.signatures[0], bundleId);
    return services.store.listSubmissions(1)[0];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    services.store.markFailure(submission.id, classifyFailure(message), message);
    throw error;
  }
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
    memo: `smart-transaction-stack expired-blockhash ${new Date().toISOString()}`,
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

async function trackSubmittedBundle(
  services: Services,
  submissionId: string,
  signature: string,
  bundleId: string
) {
  let jitoFailureMessage: string | null = null;

  const streamPromise = services.yellowstone.watchSignatureLifecycle(
    signature,
    (update) => {
      services.store.markStage(submissionId, signature, update.stage, update.slot, update.raw);
    }
  );

  const jitoPromise = pollJitoStatus(services.jito, bundleId, 150_000).catch((error) => {
    jitoFailureMessage = error instanceof Error ? error.message : String(error);
  });

  const streamResult = await Promise.allSettled([streamPromise, jitoPromise]);
  const streamFailure = streamResult.find((result) => result.status === "rejected");
  if (streamFailure?.status === "rejected") {
    const message = streamFailure.reason instanceof Error ? streamFailure.reason.message : String(streamFailure.reason);
    services.store.markFailure(submissionId, classifyFailure(message), message);
    throw streamFailure.reason;
  }
  if (jitoFailureMessage) {
    services.store.markFailure(submissionId, classifyFailure(jitoFailureMessage), jitoFailureMessage);
    throw new Error(jitoFailureMessage);
  }
}

async function pollJitoStatus(jito: JitoJsonRpcClient, bundleId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: unknown = null;

  while (Date.now() < deadline) {
    const result = await jito.getInflightBundleStatuses([bundleId]);
    const status = Array.isArray(result.value) ? result.value[0] as { status?: string; landed_slot?: number } : null;
    lastStatus = status ?? result;
    if (status?.status === "Landed") return status;
    if (status?.status === "Failed" || status?.status === "Invalid") {
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
