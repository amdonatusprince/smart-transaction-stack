import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";
import { createServices } from "../src/cli/workflows.js";

const run = Boolean(process.env.LIVE_MAINNET);

describe.skipIf(!run)("live mainnet infrastructure checks", () => {
  it("reads real Jito tip accounts and tip-floor data without submitting", async () => {
    const config = loadConfig();
    const services = createServices(config);
    try {
      const [tipAccounts, tipQuote, leader] = await Promise.all([
        services.jito.getTipAccounts(),
        services.tips.quote(2),
        services.leader.getNextScheduledLeader()
      ]);

      expect(config.network).toBe("mainnet-beta");
      expect(tipAccounts.length).toBeGreaterThan(0);
      expect(tipQuote.lamports).toBeGreaterThanOrEqual(config.minTipLamports);
      expect(leader.nextLeaderSlot).toBeGreaterThanOrEqual(leader.currentSlot);
    } finally {
      services.store.close();
    }
  });
});
