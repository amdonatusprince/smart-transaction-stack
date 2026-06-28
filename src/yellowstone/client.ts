import type { CommitmentStage } from "../types/domain.js";
import { nowIso } from "../utils/time.js";

export interface YellowstoneStageUpdate {
  stage: CommitmentStage;
  slot?: number | null;
  raw?: unknown;
}

export class YellowstoneClient {
  private client?: YellowstoneSdkClient;
  private sdkPromise?: Promise<YellowstoneSdkModule>;

  constructor(
    private readonly endpoint: string,
    private readonly token?: string
  ) {}

  async connect() {
    if (this.client) return this.client;
    const sdk = await this.getSdk();
    this.client = new sdk.default(this.endpoint, this.token, undefined);
    await this.client.connect();
    return this.client;
  }

  async health() {
    const client = await this.connect();
    const sdk = await this.getSdk();
    const [version, processedSlot, confirmedSlot] = await Promise.all([
      client.getVersion().catch((error: Error) => ({
        unavailable: true,
        message: error.message
      })),
      client.getSlot(sdk.CommitmentLevel.PROCESSED),
      client.getSlot(sdk.CommitmentLevel.CONFIRMED)
    ]);
    return {
      version,
      processedSlot: Number(processedSlot.slot),
      confirmedSlot: Number(confirmedSlot.slot)
    };
  }

  async watchSignatureLifecycle(
    signature: string,
    onUpdate: (update: YellowstoneStageUpdate) => void,
    timeoutMs = 150_000
  ) {
    const client = await this.connect();
    const sdk = await this.getSdk();
    const stream = await client.subscribe();
    let transactionSlot: number | null = null;
    let confirmed = false;
    let finalized = false;

    const request = {
      slots: {
        lifecycle_slots: {
          filterByCommitment: true,
          interslotUpdates: false
        }
      },
      accounts: {},
      transactions: {
        target_signature: {
          vote: false,
          failed: true,
          signature
        }
      },
      transactionsStatus: {
        target_signature_status: {
          vote: false,
          failed: true,
          signature
        }
      },
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      commitment: sdk.CommitmentLevel.PROCESSED
    };

    await writeStream(stream, request);

    const pingTimer = setInterval(() => {
      void writeStream(stream, {
        ping: { id: 1 },
        accounts: {},
        accountsDataSlice: [],
        transactions: {},
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
        slots: {}
      }).catch(() => undefined);
    }, 30_000);

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Yellowstone lifecycle stream timed out for ${signature}`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        clearInterval(pingTimer);
        stream.removeAllListeners();
        stream.destroy();
      };

      stream.on("data", (update: any) => {
        if (update.pong || update.ping) return;

        if (update.transaction || update.transactionStatus) {
          const slot = Number(update.transaction?.slot ?? update.transactionStatus?.slot);
          if (Number.isFinite(slot)) {
            transactionSlot = slot;
            onUpdate({ stage: "processed", slot, raw: stamp(update) });
          }
        }

        if (update.slot && transactionSlot !== null) {
          const slot = Number(update.slot.slot);
          const status = Number(update.slot.status);
          if (!confirmed && slot === transactionSlot && status === 1) {
            confirmed = true;
            onUpdate({ stage: "confirmed", slot, raw: stamp(update) });
          }
          if (!finalized && slot >= transactionSlot && status === 2) {
            finalized = true;
            onUpdate({ stage: "finalized", slot: transactionSlot, raw: stamp(update) });
            cleanup();
            resolve();
          }
        }
      });

      stream.on("error", (error: Error) => {
        cleanup();
        reject(error);
      });

      stream.on("end", () => {
        if (!finalized) {
          cleanup();
          reject(new Error(`Yellowstone stream ended before finalization for ${signature}`));
        }
      });
    });
  }
  private async getSdk(): Promise<YellowstoneSdkModule> {
    this.sdkPromise ??= import("@triton-one/yellowstone-grpc") as unknown as Promise<YellowstoneSdkModule>;
    return this.sdkPromise;
  }
}

function writeStream(stream: { write(chunk: unknown, callback: (error?: Error | null) => void): boolean }, request: unknown) {
  return new Promise<void>((resolve, reject) => {
    stream.write(request, (error: Error | null | undefined) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function stamp(raw: unknown) {
  return { receivedAt: nowIso(), raw };
}

interface YellowstoneSdkModule {
  default: new (endpoint: string, token: string | undefined, channelOptions: unknown) => YellowstoneSdkClient;
  CommitmentLevel: {
    PROCESSED: number;
    CONFIRMED: number;
    FINALIZED: number;
  };
}

interface YellowstoneSdkClient {
  connect(): Promise<void>;
  getVersion(): Promise<unknown>;
  getSlot(commitment: number): Promise<{ slot: string | number }>;
  subscribe(): Promise<YellowstoneStream>;
}

interface YellowstoneStream {
  write(chunk: unknown, callback: (error?: Error | null) => void): boolean;
  on(event: "data", listener: (update: any) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "end", listener: () => void): this;
  removeAllListeners(): this;
  destroy(): void;
}
