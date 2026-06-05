import express from "express";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LifecycleStore } from "../db/store.js";

export async function startDashboardServer(dbPath: string, port: number) {
  const app = express();
  const root = resolve("src/dashboard");

  app.get("/api/summary", (_req, res) => {
    const store = new LifecycleStore(dbPath);
    try {
      res.json(store.summary());
    } finally {
      store.close();
    }
  });

  app.get("/api/submissions", (req, res) => {
    const limit = Number(req.query.limit ?? 100);
    const store = new LifecycleStore(dbPath);
    try {
      res.json(store.evidenceRows(limit));
    } finally {
      store.close();
    }
  });

  app.get("/", (_req, res) => {
    res.type("html").send(readFileSync(resolve(root, "index.html"), "utf8"));
  });
  app.use("/assets", express.static(resolve(root, "assets")));

  app.listen(port, () => {
    console.log(`Dashboard listening on http://localhost:${port}`);
  });
}
