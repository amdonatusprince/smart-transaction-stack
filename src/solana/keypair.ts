import { Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import bs58 from "bs58";

export function loadKeypair(pathOrSecret?: string): Keypair {
  if (!pathOrSecret) {
    throw new Error("PAYER_KEYPAIR_PATH is required for live bundle submission");
  }

  const trimmed = pathOrSecret.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    return keypairFromJson(trimmed);
  }

  if (/^[1-9A-HJ-NP-Za-km-z]{80,}$/.test(trimmed)) {
    return Keypair.fromSecretKey(bs58.decode(trimmed));
  }

  return keypairFromJson(readFileSync(trimmed, "utf8"));
}

function keypairFromJson(raw: string): Keypair {
  const parsed = JSON.parse(raw) as number[] | { secretKey?: number[] };
  const secret = Array.isArray(parsed) ? parsed : parsed.secretKey;
  if (!secret) throw new Error("Invalid keypair JSON: expected array or { secretKey }");
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}
