import type { FailureClassification } from "../types/domain.js";

export function classifyFailure(input: string): FailureClassification {
  const text = input.toLowerCase();

  if (
    text.includes("blockhash not found") ||
    text.includes("expired blockhash") ||
    text.includes("block height exceeded") ||
    text.includes("transactionexpiredblockheightexceeded") ||
    text.includes("transaction expired")
  ) {
    return "expired_blockhash";
  }

  if (
    text.includes("computational budget exceeded") ||
    text.includes("computebudgetexceeded") ||
    text.includes("compute unit") ||
    text.includes("exceeded maximum number of instructions")
  ) {
    return "compute_exceeded";
  }

  if (
    text.includes("tip too low") ||
    text.includes("fee too low") ||
    text.includes("insufficient prioritization") ||
    text.includes("not enough fees") ||
    text.includes("auction")
  ) {
    return "fee_too_low";
  }

  if (
    text.includes("bundle") ||
    text.includes("failed") ||
    text.includes("invalid") ||
    text.includes("not landed")
  ) {
    return "bundle_failure";
  }

  if (text.includes("timeout") || text.includes("stream")) {
    return "stream_timeout";
  }

  return "unknown";
}
