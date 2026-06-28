import express from "express";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LifecycleStore } from "../db/store.js";

export async function startDashboardServer(dbPath: string, port: number) {
  const app = express();
  const root = resolve("src/dashboard");
  const docsRoot = resolve("docs");
  const shotsRoot = resolve("shots");

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

  app.get("/api/submissions/:id/events", (req, res) => {
    const store = new LifecycleStore(dbPath);
    try {
      res.json(store.submissionEvents(req.params.id));
    } finally {
      store.close();
    }
  });

  app.get("/api/live", (req, res) => {
    const limit = Number(req.query.limit ?? 100);
    const store = new LifecycleStore(dbPath);
    try {
      res.json(store.dashboardSnapshot(limit));
    } finally {
      store.close();
    }
  });

  app.get("/api/architecture-markdown", (_req, res) => {
    res.type("text/markdown").send(readFileSync(resolve(docsRoot, "article.md"), "utf8"));
  });

  app.get("/", (_req, res) => {
    res.type("html").send(readFileSync(resolve(root, "index.html"), "utf8"));
  });
  app.get("/architecture", (_req, res) => {
    res.type("html").send(readFileSync(resolve(root, "architecture.html"), "utf8"));
  });
  app.use("/assets", express.static(resolve(root, "assets")));
  app.use("/shots", express.static(shotsRoot));

  app.listen(port, () => {
    console.log(`Dashboard listening on http://localhost:${port}`);
  });
}
