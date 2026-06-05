import type { TipFloorSample } from "../types/domain.js";

interface JsonRpcPayload {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown[];
}

export class JitoJsonRpcClient {
  private id = 1;

  constructor(private readonly baseUrl: string) {}

  async getTipAccounts(): Promise<string[]> {
    const result = await this.call<string[]>("/api/v1/getTipAccounts", "getTipAccounts", []);
    if (!Array.isArray(result) || result.length === 0) {
      throw new Error("Jito returned no tip accounts");
    }
    return result;
  }

  async sendBundle(encodedTransactions: string[]): Promise<string> {
    const { json, headers } = await this.rawCall("/api/v1/bundles", "sendBundle", [
      encodedTransactions,
      { encoding: "base64" }
    ]);
    const bundleId = headers.get("x-bundle-id") ?? json.result;
    if (typeof bundleId !== "string" || bundleId.length === 0) {
      throw new Error(`Jito sendBundle response did not include a bundle id: ${JSON.stringify(json)}`);
    }
    return bundleId;
  }

  async getInflightBundleStatuses(bundleIds: string[]) {
    return this.call<{ context: { slot: number }; value: unknown[] | null }>(
      "/api/v1/getInflightBundleStatuses",
      "getInflightBundleStatuses",
      [bundleIds]
    );
  }

  async getBundleStatuses(bundleIds: string[]) {
    return this.call<{ context: { slot: number }; value: unknown[] | null }>(
      "/api/v1/bundles",
      "getBundleStatuses",
      [bundleIds]
    );
  }

  async getRawTipFloor(tipFloorUrl: string): Promise<TipFloorSample[]> {
    const response = await fetch(tipFloorUrl, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      throw new Error(`Jito tip floor failed: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<TipFloorSample[]>;
  }

  private async call<T>(path: string, method: string, params: unknown[]): Promise<T> {
    const { json } = await this.rawCall(path, method, params);
    return json.result as T;
  }

  private async rawCall(path: string, method: string, params: unknown[]) {
    const payload: JsonRpcPayload = {
      jsonrpc: "2.0",
      id: this.id++,
      method,
      params
    };
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000)
    });

    const json = await response.json() as { result?: unknown; error?: { message?: string; code?: number } };
    if (!response.ok || json.error) {
      const message = json.error?.message ?? `${response.status} ${response.statusText}`;
      throw new Error(`Jito ${method} failed: ${message}`);
    }
    return { json, headers: response.headers };
  }
}
