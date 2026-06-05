export function nowIso() {
  return new Date().toISOString();
}

export function msBetween(start?: string | null, end?: string | null) {
  if (!start || !end) return null;
  return new Date(end).getTime() - new Date(start).getTime();
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

export function explorerTxUrl(signature: string, network: string) {
  const cluster = network === "mainnet-beta" ? "" : `?cluster=${network}`;
  return `https://explorer.solana.com/tx/${signature}${cluster}`;
}
