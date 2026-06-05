import { describe, expect, it } from "vitest";
import { Connection } from "@solana/web3.js";

const run = Boolean(process.env.LIVE_DEVNET);

describe.skipIf(!run)("live devnet RPC checks", () => {
  const rpcUrl = process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");

  it("reads a real devnet slot and confirmed blockhash", async () => {
    const [slot, latest] = await Promise.all([
      connection.getSlot("processed"),
      connection.getLatestBlockhash("confirmed")
    ]);

    expect(slot).toBeGreaterThan(0);
    expect(latest.blockhash.length).toBeGreaterThan(20);
    expect(latest.lastValidBlockHeight).toBeGreaterThan(0);
  });

  it("confirms the endpoint is not mainnet-beta", async () => {
    const genesisHash = await connection.getGenesisHash();
    expect(genesisHash).not.toBe("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
  });
});
