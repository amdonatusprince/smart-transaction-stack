export type NetworkName = "mainnet-beta" | "testnet" | "devnet";

export type CommitmentStage = "submitted" | "processed" | "confirmed" | "finalized";

export type FailureClassification =
  | "expired_blockhash"
  | "fee_too_low"
  | "compute_exceeded"
  | "bundle_failure"
  | "stream_timeout"
  | "unknown";

export type FaultMode = "none" | "blockhash-expiry" | "compute-exceeded" | "low-tip";

export interface TipFloorSample {
  time: string;
  landed_tips_25th_percentile?: number;
  landed_tips_50th_percentile?: number;
  landed_tips_75th_percentile?: number;
  landed_tips_95th_percentile?: number;
  landed_tips_99th_percentile?: number;
  ema_landed_tips_50th_percentile?: number;
}

export interface TipQuote {
  lamports: number;
  source: string;
  sample: TipFloorSample;
}

export interface LeaderWindow {
  currentSlot: number;
  nextLeaderSlot: number;
  nextLeaderIdentity: string;
  slotsUntilLeader: number;
}

export interface BuiltBundle {
  encodedTransactions: string[];
  signatures: string[];
  blockhash: string;
  lastValidBlockHeight: number;
  tipLamports: number;
  tipAccount: string;
}

export interface BundleSubmission {
  id: string;
  bundleId?: string | null;
  network: NetworkName;
  status: string;
  faultMode: FaultMode;
  signature: string;
  tipLamports: number;
  tipSource: string;
  tipAccount: string;
  leaderSlot?: number | null;
  leaderIdentity?: string | null;
  submittedAt?: string | null;
  processedAt?: string | null;
  confirmedAt?: string | null;
  finalizedAt?: string | null;
  submittedSlot?: number | null;
  processedSlot?: number | null;
  confirmedSlot?: number | null;
  finalizedSlot?: number | null;
  failureClassification?: FailureClassification | null;
  failureMessage?: string | null;
  agentDecisionJson?: string | null;
  explorerUrl?: string | null;
}

export interface LifecycleEvent {
  submissionId: string;
  signature: string;
  stage: CommitmentStage;
  slot?: number | null;
  timestamp: string;
  raw?: unknown;
}

export interface RetryDecision {
  failure_classification: FailureClassification;
  retry_action: "retry" | "do_not_retry";
  blockhash_strategy: "refresh_confirmed" | "keep_existing" | "abort";
  tip_lamports: number;
  wait_slots: number;
  confidence: number;
  reasoning_summary: string;
}

export interface FailureEvidence {
  submissionId: string;
  signature: string;
  bundleId?: string | null;
  faultMode: FaultMode;
  errorMessage: string;
  currentSlot?: number;
  leaderWindow?: LeaderWindow;
  tipQuote?: TipQuote;
  blockhash?: string;
  lastValidBlockHeight?: number;
  currentBlockHeight?: number;
  simulationLogs?: string[];
  jitoStatus?: unknown;
}
