#!/usr/bin/env node
import { Command } from "commander";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig, loadLocalArtifactConfig } from "../config/env.js";
import { LifecycleStore } from "../db/store.js";
import { loadKeypair } from "../solana/keypair.js";
import type { FaultMode } from "../types/domain.js";
import { createServices, doctor, runBlockhashExpiryFault, submitOneLive, runSimulationLoop } from "./workflows.js";
import { startDashboardServer } from "../server/dashboardServer.js";

const program = new Command();

program
  .name("txstack")
  .description("Snapsis live Solana transaction stack with Jito bundles, Yellowstone tracking, and AI retry decisions.")
  .version("0.1.0");

program.command("doctor")
  .description("Verify live RPC, Yellowstone, Jito, wallet, and AI configuration.")
  .action(async () => {
    const config = loadConfig();
    const services = createServices(config);
    try {
      const payer = config.payerPrivateKey ? loadKeypair(config.payerPrivateKey) : undefined;
      const result = await doctor(config, services, payer);
      console.log(JSON.stringify(result, null, 2));
    } finally {
      services.store.close();
    }
  });

program.command("run")
  .description("Submit real Jito bundles and write lifecycle evidence.")
  .option("--count <number>", "number of bundle attempts", parseInt)
  .option("--faults <items>", "comma-separated fault modes: blockhash-expiry,compute-exceeded,low-tip")
  .option("--live", "required guard for real mainnet submission")
  .action(async (options: { count?: number; faults?: string; live?: boolean }) => {
    requireLive(options.live);
    const config = loadConfig();
    const services = createServices(config);
    const payer = loadKeypair(config.payerPrivateKey);
    const count = options.count ?? config.defaultBundleCount;
    const faults = parseFaults(options.faults);

    try {
      let attempts = 0;
      const errors: string[] = [];
      for (const fault of faults) {
        try {
          if (fault === "blockhash-expiry") {
            await runBlockhashExpiryFault(config, services, payer);
          } else {
            await submitOneLive(config, services, payer, fault);
          }
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
        attempts += 1;
      }

      while (attempts < count) {
        try {
          await submitOneLive(config, services, payer, "none");
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
        attempts += 1;
      }

      console.log(JSON.stringify({ completedAttempts: attempts, errors, summary: services.store.summary() }, null, 2));
    } finally {
      services.store.close();
    }
  });

program.command("fault:blockhash-expiry")
  .description("Inject a real expired-blockhash fault and let the AI agent decide the retry.")
  .option("--live", "required guard for real mainnet submission")
  .action(async (options: { live?: boolean }) => {
    requireLive(options.live);
    const config = loadConfig();
    const services = createServices(config);
    const payer = loadKeypair(config.payerPrivateKey);
    try {
      const result = await runBlockhashExpiryFault(config, services, payer);
      console.log(JSON.stringify(result, null, 2));
    } finally {
      services.store.close();
    }
  });

program.command("simulate")
  .description("Submit a fixed batch of live bundles with autonomous AI retry decisions, then stop.")
  .option("--count <number>", "total simulation rounds (default 20)", parseInt)
  .option("--interval <ms>", "milliseconds between attempts (default 2000)", parseInt)
  .option("--live", "required guard for real mainnet submission")
  .action(async (options: { count?: number; interval?: number; live?: boolean }) => {
    requireLive(options.live);
    const config = loadConfig();
    const services = createServices(config);
    const payer = loadKeypair(config.payerPrivateKey);
    const count = options.count ?? 20;
    const intervalMs = options.interval ?? 2000;
    console.log(`Snapsis simulate: ${count} rounds, ${intervalMs}ms interval`);
    console.log("Watch the dashboard at http://localhost:8787 for live updates.\n");
    try {
      const result = await runSimulationLoop(config, services, payer, { maxAttempts: count, intervalMs });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      services.store.close();
    }
  });

program.command("dashboard")
  .description("Start the local read-only dashboard.")
  .option("--port <number>", "dashboard port", parseInt)
  .action(async (options: { port?: number }) => {
    const config = loadLocalArtifactConfig();
    const port = options.port ?? config.dashboardPort;
    await startDashboardServer(config.dbPath, port);
  });

program.command("export")
  .description("Export lifecycle evidence as JSONL and CSV.")
  .option("--out-dir <path>", "output directory", "data/lifecycle")
  .action((options: { outDir: string }) => {
    const config = loadLocalArtifactConfig();
    const store = new LifecycleStore(config.dbPath);
    try {
      const rows = store.evidenceRows();
      const outDir = resolve(options.outDir);
      mkdirSync(outDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const jsonlPath = resolve(outDir, `lifecycle-${stamp}.jsonl`);
      const csvPath = resolve(outDir, `lifecycle-${stamp}.csv`);
      writeFileSync(jsonlPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
      writeFileSync(csvPath, toCsv(rows));
      console.log(JSON.stringify({ jsonlPath, csvPath, count: rows.length }, null, 2));
    } finally {
      store.close();
    }
  });

try {
  await program.parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function requireLive(live?: boolean) {
  if (!live) {
    throw new Error("Real bundle submission requires --live. This guard prevents accidental SOL spend.");
  }
}

function parseFaults(value?: string): FaultMode[] {
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
    if (item === "blockhash-expiry" || item === "compute-exceeded" || item === "low-tip") return item;
    throw new Error(`Unsupported fault mode: ${item}`);
  });
}

function toCsv(rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))
  ];
  return lines.join("\n") + "\n";
}

function csvCell(value: unknown) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `"${text.replaceAll("\"", "\"\"")}"`;
}
