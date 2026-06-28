import type { LeaderWindow } from "../types/domain.js";
import { sleep } from "../utils/time.js";

interface SearcherClientLike {
  getNextScheduledLeader(): Promise<unknown>;
}

export class JitoLeaderClient {
  private clientPromise?: Promise<SearcherClientLike>;

  constructor(private readonly grpcHost: string) {}

  async getNextScheduledLeader(): Promise<LeaderWindow> {
    const client = await this.getClient();
    const result = await client.getNextScheduledLeader();
    const value = unwrapResult(result) as {
      currentSlot: number;
      nextLeaderSlot: number;
      nextLeaderIdentity: string;
    };
    if (!value || typeof value.currentSlot !== "number" || typeof value.nextLeaderSlot !== "number") {
      throw new Error(`Unexpected Jito leader response: ${JSON.stringify(result)}`);
    }
    return {
      ...value,
      slotsUntilLeader: value.nextLeaderSlot - value.currentSlot
    };
  }

  async waitForLeaderWindow(windowSlots: number, pollMs: number): Promise<LeaderWindow> {
    for (;;) {
      try {
        const leader = await this.getNextScheduledLeader();
        if (leader.slotsUntilLeader <= windowSlots) return leader;
        await sleep(pollMs);
      } catch (error) {
        const retryMs = retryAfterMs(error);
        if (retryMs === null) throw error;
        await sleep(retryMs);
      }
    }
  }

  private async getClient(): Promise<SearcherClientLike> {
    this.clientPromise ??= this.createClient();
    return this.clientPromise;
  }

  private async createClient(): Promise<SearcherClientLike> {
    const mod = await import("jito-ts/dist/sdk/block-engine/searcher");
    const searcherClient = (mod as { searcherClient: (url: string) => SearcherClientLike }).searcherClient;
    return searcherClient(this.grpcHost);
  }
}

function unwrapResult(result: unknown) {
  if (result && typeof result === "object" && "ok" in result) {
    const maybe = result as { ok: boolean; value?: unknown; error?: unknown };
    if (maybe.ok) return maybe.value;
    throw new Error(`Jito leader request failed: ${JSON.stringify(maybe.error)}`);
  }
  return result;
}

function retryAfterMs(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/Retry after (\d+)ms/);
  if (!match) return null;
  return Math.min(Number(match[1]), 120_000);
}
