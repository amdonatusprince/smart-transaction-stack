import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";

loadDotenv();
if (existsSync(".env.local")) {
  loadDotenv({ path: ".env.local", override: true });
}
import { z } from "zod";
import type { NetworkName } from "../types/domain.js";

const envSchema = z.object({
  SOLANA_RPC_URL: z.string().url(),
  YELLOWSTONE_ENDPOINT: z.string().min(1),
  YELLOWSTONE_X_TOKEN: z.string().optional(),
  NETWORK: z.enum(["mainnet-beta", "testnet", "devnet"]).default("mainnet-beta"),
  JITO_BLOCK_ENGINE_HTTP: z.string().url().default("https://frankfurt.mainnet.block-engine.jito.wtf"),
  JITO_BLOCK_ENGINE_HTTP_OVERRIDE: z.string().url().optional(),
  JITO_BLOCK_ENGINE_GRPC: z.string().min(1).default("frankfurt.mainnet.block-engine.jito.wtf"),
  JITO_BLOCK_ENGINE_GRPC_OVERRIDE: z.string().min(1).optional(),
  JITO_TIP_FLOOR_URL: z.string().url().default("https://bundles.jito.wtf/api/v1/bundles/tip_floor"),
  PAYER_PRIVATE_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4.1-mini"),
  OPENAI_MODEL_OVERRIDE: z.string().optional(),
  DB_PATH: z.string().default("data/lifecycle/txstack.sqlite"),
  MIN_TIP_LAMPORTS: z.coerce.number().int().positive().default(1000),
  MAX_TIP_LAMPORTS: z.coerce.number().int().positive().default(200000),
  MIN_TIP_LAMPORTS_OVERRIDE: z.coerce.number().int().positive().optional(),
  MAX_TIP_LAMPORTS_OVERRIDE: z.coerce.number().int().positive().optional(),
  DEFAULT_BUNDLE_COUNT: z.coerce.number().int().positive().default(10),
  LEADER_WINDOW_SLOTS: z.coerce.number().int().positive().default(2),
  LEADER_WINDOW_SLOTS_OVERRIDE: z.coerce.number().int().nonnegative().optional(),
  SUBMISSION_POLL_MS: z.coerce.number().int().positive().default(500),
  SUBMISSION_POLL_MS_OVERRIDE: z.coerce.number().int().positive().optional(),
  DASHBOARD_PORT: z.coerce.number().int().positive().default(8787)
});

export type AppConfig = ReturnType<typeof loadConfig>;
export type LocalArtifactConfig = ReturnType<typeof loadLocalArtifactConfig>;

export function loadConfig() {
  const parsed = envSchema.parse(process.env);
  const minTipLamports = parsed.MIN_TIP_LAMPORTS_OVERRIDE ?? parsed.MIN_TIP_LAMPORTS;
  const maxTipLamports = parsed.MAX_TIP_LAMPORTS_OVERRIDE ?? parsed.MAX_TIP_LAMPORTS;
  if (minTipLamports > maxTipLamports) {
    throw new Error("MIN_TIP_LAMPORTS cannot exceed MAX_TIP_LAMPORTS");
  }

  return {
    rpcUrl: parsed.SOLANA_RPC_URL,
    yellowstoneEndpoint: normalizeYellowstoneEndpoint(parsed.YELLOWSTONE_ENDPOINT),
    yellowstoneToken: parsed.YELLOWSTONE_X_TOKEN,
    network: parsed.NETWORK as NetworkName,
    jitoHttpUrl: trimTrailingSlash(parsed.JITO_BLOCK_ENGINE_HTTP_OVERRIDE ?? parsed.JITO_BLOCK_ENGINE_HTTP),
    jitoGrpcUrl: normalizeGrpcHost(parsed.JITO_BLOCK_ENGINE_GRPC_OVERRIDE ?? parsed.JITO_BLOCK_ENGINE_GRPC),
    tipFloorUrl: parsed.JITO_TIP_FLOOR_URL,
    payerPrivateKey: parsed.PAYER_PRIVATE_KEY,
    openAiApiKey: parsed.OPENAI_API_KEY,
    openAiModel: parsed.OPENAI_MODEL_OVERRIDE ?? parsed.OPENAI_MODEL,
    dbPath: parsed.DB_PATH,
    minTipLamports,
    maxTipLamports,
    defaultBundleCount: parsed.DEFAULT_BUNDLE_COUNT,
    leaderWindowSlots: parsed.LEADER_WINDOW_SLOTS_OVERRIDE ?? parsed.LEADER_WINDOW_SLOTS,
    submissionPollMs: parsed.SUBMISSION_POLL_MS_OVERRIDE ?? parsed.SUBMISSION_POLL_MS,
    dashboardPort: parsed.DASHBOARD_PORT
  };
}

export function loadLocalArtifactConfig() {
  return {
    dbPath: process.env.DB_PATH ?? "data/lifecycle/txstack.sqlite",
    dashboardPort: parsePositiveInt(process.env.DASHBOARD_PORT, 8787)
  };
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function normalizeGrpcHost(value: string) {
  return value.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function normalizeYellowstoneEndpoint(value: string) {
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  return `https://${trimmed}`;
}

function parsePositiveInt(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
