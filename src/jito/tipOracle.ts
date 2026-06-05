import type { TipFloorSample, TipQuote } from "../types/domain.js";

export class TipOracle {
  constructor(
    private readonly tipFloorUrl: string,
    private readonly minTipLamports: number,
    private readonly maxTipLamports: number
  ) {}

  async fetchTipFloor(): Promise<TipFloorSample> {
    const response = await fetch(this.tipFloorUrl, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      throw new Error(`Jito tip floor request failed: ${response.status} ${response.statusText}`);
    }
    const payload = await response.json() as TipFloorSample[];
    const sample = payload[0];
    if (!sample || typeof sample !== "object") {
      throw new Error("Jito tip floor returned no samples");
    }
    return sample;
  }

  async quote(slotsUntilLeader: number): Promise<TipQuote> {
    const sample = await this.fetchTipFloor();
    const sourceValue =
      slotsUntilLeader <= 2
        ? sample.landed_tips_75th_percentile ?? sample.ema_landed_tips_50th_percentile ?? sample.landed_tips_50th_percentile
        : sample.ema_landed_tips_50th_percentile ?? sample.landed_tips_50th_percentile ?? sample.landed_tips_25th_percentile;

    if (typeof sourceValue !== "number" || Number.isNaN(sourceValue)) {
      throw new Error("Jito tip floor sample does not include usable percentile data");
    }

    const rawLamports = Math.ceil(sourceValue * 1_000_000_000);
    const lamports = clamp(rawLamports, this.minTipLamports, this.maxTipLamports);

    return {
      lamports,
      source: `jito-tip-floor:${slotsUntilLeader <= 2 ? "75p" : "ema50p"}`,
      sample
    };
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
