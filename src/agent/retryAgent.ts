import OpenAI from "openai";
import { z } from "zod";
import type { FailureEvidence, RetryDecision } from "../types/domain.js";

const decisionSchema = z.object({
  failure_classification: z.enum([
    "expired_blockhash",
    "fee_too_low",
    "compute_exceeded",
    "bundle_failure",
    "stream_timeout",
    "unknown"
  ]),
  retry_action: z.enum(["retry", "do_not_retry"]),
  blockhash_strategy: z.enum(["refresh_confirmed", "keep_existing", "abort"]),
  tip_lamports: z.number().int().nonnegative(),
  wait_slots: z.number().int().min(0).max(32),
  confidence: z.number().min(0).max(1),
  reasoning_summary: z.string().min(1).max(600)
});

export class RetryAgent {
  private client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly minTipLamports: number,
    private readonly maxTipLamports: number
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async decide(evidence: FailureEvidence): Promise<RetryDecision> {
    const response = await this.client.responses.create({
      model: this.model,
      input: [
        {
          role: "system",
          content:
            "You are an autonomous Solana transaction operations agent. Decide whether and how to retry a failed Jito bundle using only the provided live evidence. Do not invent slots, signatures, or statuses. Keep reasoning_summary concise and operational."
        },
        {
          role: "user",
          content: JSON.stringify({
            safety_rails: {
              min_tip_lamports: this.minTipLamports,
              max_tip_lamports: this.maxTipLamports,
              allowed_retry_for_blockhash_expiry: true
            },
            evidence
          })
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "retry_decision",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              failure_classification: {
                type: "string",
                enum: [
                  "expired_blockhash",
                  "fee_too_low",
                  "compute_exceeded",
                  "bundle_failure",
                  "stream_timeout",
                  "unknown"
                ]
              },
              retry_action: { type: "string", enum: ["retry", "do_not_retry"] },
              blockhash_strategy: { type: "string", enum: ["refresh_confirmed", "keep_existing", "abort"] },
              tip_lamports: { type: "integer", minimum: 0 },
              wait_slots: { type: "integer", minimum: 0, maximum: 32 },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              reasoning_summary: { type: "string" }
            },
            required: [
              "failure_classification",
              "retry_action",
              "blockhash_strategy",
              "tip_lamports",
              "wait_slots",
              "confidence",
              "reasoning_summary"
            ]
          }
        }
      }
    });

    const outputText = (response as { output_text?: string }).output_text;
    if (!outputText) {
      throw new Error("OpenAI retry agent returned no output_text");
    }

    const parsed = decisionSchema.parse(JSON.parse(outputText));
    if (parsed.tip_lamports > this.maxTipLamports) {
      throw new Error(`Agent requested tip ${parsed.tip_lamports}, above MAX_TIP_LAMPORTS`);
    }
    if (parsed.retry_action === "retry" && parsed.tip_lamports < this.minTipLamports) {
      throw new Error(`Agent requested retry with tip ${parsed.tip_lamports}, below MIN_TIP_LAMPORTS`);
    }
    return parsed;
  }
}

export function parseRetryDecision(raw: string) {
  return decisionSchema.parse(JSON.parse(raw));
}
