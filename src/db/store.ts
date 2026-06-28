import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { BundleSubmission, CommitmentStage, FailureClassification, LifecycleEvent } from "../types/domain.js";
import { msBetween, nowIso, safeJson } from "../utils/time.js";

export class LifecycleStore {
  private db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  close() {
    this.db.close();
  }

  upsertSubmission(submission: BundleSubmission) {
    const stmt = this.db.prepare(`
      INSERT INTO bundle_submissions (
        id, bundle_id, network, status, fault_mode, signature, tip_lamports,
        tip_source, tip_account, leader_slot, leader_identity, submitted_at,
        processed_at, confirmed_at, finalized_at, submitted_slot, processed_slot,
        confirmed_slot, finalized_slot, failure_classification, failure_message,
        agent_decision_json, explorer_url, updated_at
      )
      VALUES (
        @id, @bundleId, @network, @status, @faultMode, @signature, @tipLamports,
        @tipSource, @tipAccount, @leaderSlot, @leaderIdentity, @submittedAt,
        @processedAt, @confirmedAt, @finalizedAt, @submittedSlot, @processedSlot,
        @confirmedSlot, @finalizedSlot, @failureClassification, @failureMessage,
        @agentDecisionJson, @explorerUrl, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        bundle_id = excluded.bundle_id,
        status = excluded.status,
        tip_lamports = excluded.tip_lamports,
        tip_source = excluded.tip_source,
        tip_account = excluded.tip_account,
        leader_slot = excluded.leader_slot,
        leader_identity = excluded.leader_identity,
        submitted_at = COALESCE(excluded.submitted_at, bundle_submissions.submitted_at),
        processed_at = COALESCE(excluded.processed_at, bundle_submissions.processed_at),
        confirmed_at = COALESCE(excluded.confirmed_at, bundle_submissions.confirmed_at),
        finalized_at = COALESCE(excluded.finalized_at, bundle_submissions.finalized_at),
        submitted_slot = COALESCE(excluded.submitted_slot, bundle_submissions.submitted_slot),
        processed_slot = COALESCE(excluded.processed_slot, bundle_submissions.processed_slot),
        confirmed_slot = COALESCE(excluded.confirmed_slot, bundle_submissions.confirmed_slot),
        finalized_slot = COALESCE(excluded.finalized_slot, bundle_submissions.finalized_slot),
        failure_classification = COALESCE(excluded.failure_classification, bundle_submissions.failure_classification),
        failure_message = COALESCE(excluded.failure_message, bundle_submissions.failure_message),
        agent_decision_json = COALESCE(excluded.agent_decision_json, bundle_submissions.agent_decision_json),
        explorer_url = COALESCE(excluded.explorer_url, bundle_submissions.explorer_url),
        updated_at = excluded.updated_at
    `);

    stmt.run({
      ...submission,
      bundleId: submission.bundleId ?? null,
      leaderSlot: submission.leaderSlot ?? null,
      leaderIdentity: submission.leaderIdentity ?? null,
      submittedAt: submission.submittedAt ?? null,
      processedAt: submission.processedAt ?? null,
      confirmedAt: submission.confirmedAt ?? null,
      finalizedAt: submission.finalizedAt ?? null,
      submittedSlot: submission.submittedSlot ?? null,
      processedSlot: submission.processedSlot ?? null,
      confirmedSlot: submission.confirmedSlot ?? null,
      finalizedSlot: submission.finalizedSlot ?? null,
      failureClassification: submission.failureClassification ?? null,
      failureMessage: submission.failureMessage ?? null,
      agentDecisionJson: submission.agentDecisionJson ?? null,
      explorerUrl: submission.explorerUrl ?? null,
      updatedAt: nowIso()
    });
  }

  appendEvent(event: LifecycleEvent) {
    this.db.prepare(`
      INSERT OR IGNORE INTO lifecycle_events (
        submission_id, signature, stage, slot, timestamp, raw_json
      )
      VALUES (@submissionId, @signature, @stage, @slot, @timestamp, @rawJson)
    `).run({
      submissionId: event.submissionId,
      signature: event.signature,
      stage: event.stage,
      slot: event.slot ?? null,
      timestamp: event.timestamp,
      rawJson: event.raw === undefined ? null : safeJson(event.raw)
    });
  }

  markStage(submissionId: string, signature: string, stage: CommitmentStage, slot?: number | null, raw?: unknown) {
    const timestamp = nowIso();
    this.appendEvent({ submissionId, signature, stage, slot, timestamp, raw });

    const columnMap: Record<CommitmentStage, { at: string; slot: string; status: string }> = {
      submitted: { at: "submitted_at", slot: "submitted_slot", status: "submitted" },
      processed: { at: "processed_at", slot: "processed_slot", status: "processed" },
      confirmed: { at: "confirmed_at", slot: "confirmed_slot", status: "confirmed" },
      finalized: { at: "finalized_at", slot: "finalized_slot", status: "finalized" }
    };
    const columns = columnMap[stage];
    this.db.prepare(`
      UPDATE bundle_submissions
      SET ${columns.at} = COALESCE(${columns.at}, @timestamp),
          ${columns.slot} = COALESCE(${columns.slot}, @slot),
          status = @status,
          updated_at = @timestamp
      WHERE id = @submissionId
    `).run({ submissionId, timestamp, slot: slot ?? null, status: columns.status });
  }

  markFailure(submissionId: string, classification: FailureClassification, message: string) {
    this.db.prepare(`
      UPDATE bundle_submissions
      SET status = 'failed',
          failure_classification = @classification,
          failure_message = @message,
          updated_at = @updatedAt
      WHERE id = @submissionId
    `).run({ submissionId, classification, message, updatedAt: nowIso() });
  }

  saveAgentDecision(submissionId: string, decisionJson: string) {
    this.db.prepare(`
      UPDATE bundle_submissions
      SET agent_decision_json = @decisionJson,
          updated_at = @updatedAt
      WHERE id = @submissionId
    `).run({ submissionId, decisionJson, updatedAt: nowIso() });
  }

  listSubmissions(limit = 100): Array<BundleSubmission & Record<string, unknown>> {
    return this.db.prepare(`
      SELECT
        id,
        bundle_id as bundleId,
        network,
        status,
        fault_mode as faultMode,
        signature,
        tip_lamports as tipLamports,
        tip_source as tipSource,
        tip_account as tipAccount,
        leader_slot as leaderSlot,
        leader_identity as leaderIdentity,
        submitted_at as submittedAt,
        processed_at as processedAt,
        confirmed_at as confirmedAt,
        finalized_at as finalizedAt,
        submitted_slot as submittedSlot,
        processed_slot as processedSlot,
        confirmed_slot as confirmedSlot,
        finalized_slot as finalizedSlot,
        failure_classification as failureClassification,
        failure_message as failureMessage,
        agent_decision_json as agentDecisionJson,
        explorer_url as explorerUrl,
        created_at as createdAt,
        updated_at as updatedAt
      FROM bundle_submissions
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as Array<BundleSubmission & Record<string, unknown>>;
  }

  evidenceRows(limit = 500) {
    return this.listSubmissions(limit).map((row) => ({
      ...row,
      processedDeltaMs: msBetween(row.submittedAt, row.processedAt),
      confirmedDeltaMs: msBetween(row.processedAt, row.confirmedAt),
      finalizedDeltaMs: msBetween(row.confirmedAt, row.finalizedAt)
    }));
  }

  listEvents(limit = 80) {
    return this.db.prepare(`
      SELECT
        lifecycle_events.id,
        lifecycle_events.submission_id as submissionId,
        lifecycle_events.signature,
        lifecycle_events.stage,
        lifecycle_events.slot,
        lifecycle_events.timestamp,
        lifecycle_events.raw_json as rawJson,
        bundle_submissions.bundle_id as bundleId,
        bundle_submissions.status,
        bundle_submissions.fault_mode as faultMode,
        bundle_submissions.tip_lamports as tipLamports,
        bundle_submissions.leader_slot as leaderSlot
      FROM lifecycle_events
      LEFT JOIN bundle_submissions ON bundle_submissions.id = lifecycle_events.submission_id
      ORDER BY lifecycle_events.timestamp DESC, lifecycle_events.id DESC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
  }

  submissionEvents(submissionId: string) {
    return this.db.prepare(`
      SELECT
        id,
        submission_id as submissionId,
        signature,
        stage,
        slot,
        timestamp,
        raw_json as rawJson
      FROM lifecycle_events
      WHERE submission_id = ?
      ORDER BY timestamp ASC, id ASC
    `).all(submissionId) as Array<Record<string, unknown>>;
  }

  dashboardSnapshot(limit = 100) {
    const rows = this.evidenceRows(limit);
    const events = this.listEvents(80);
    const summary = this.summary();
    const active =
      rows.find((row) => !["finalized", "failed"].includes(String(row.status))) ??
      rows[0] ??
      null;

    return {
      generatedAt: nowIso(),
      summary,
      rows,
      events,
      active
    };
  }

  summary() {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status = 'finalized' THEN 1 ELSE 0 END), 0) as finalized,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
        COALESCE(SUM(CASE WHEN status IN ('created', 'submitted', 'processed', 'confirmed') THEN 1 ELSE 0 END), 0) as inFlight,
        COALESCE(SUM(tip_lamports), 0) as totalTipLamports,
        MIN(tip_lamports) as minTipLamports,
        MAX(tip_lamports) as maxTipLamports,
        MAX(COALESCE(finalized_slot, confirmed_slot, processed_slot, submitted_slot, leader_slot)) as latestSlot,
        MAX(updated_at) as lastUpdated
      FROM bundle_submissions
    `).get() as {
      total: number;
      finalized: number;
      failed: number;
      inFlight: number;
      totalTipLamports: number;
      minTipLamports?: number | null;
      maxTipLamports?: number | null;
      latestSlot?: number | null;
      lastUpdated?: string;
    };
    const rows = this.evidenceRows(500);
    const confirmedLatencies = rows
      .map((item) => item.confirmedDeltaMs)
      .filter((value): value is number => typeof value === "number");
    const finalizedLatencies = rows
      .map((item) => item.finalizedDeltaMs)
      .filter((value): value is number => typeof value === "number");
    const failures = rows.reduce<Record<string, number>>((acc, item) => {
      const key = String(item.failureClassification ?? "none");
      if (key !== "none") acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    return {
      ...row,
      successRate: row.total > 0 ? row.finalized / row.total : 0,
      landingProbability: row.total > 0 ? Math.max(0.05, row.finalized / row.total) : 0.5,
      confirmedLatencyMs: summarizeNumbers(confirmedLatencies),
      finalizedLatencyMs: summarizeNumbers(finalizedLatencies),
      failures
    };
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bundle_submissions (
        id TEXT PRIMARY KEY,
        bundle_id TEXT,
        network TEXT NOT NULL,
        status TEXT NOT NULL,
        fault_mode TEXT NOT NULL,
        signature TEXT NOT NULL,
        tip_lamports INTEGER NOT NULL,
        tip_source TEXT NOT NULL,
        tip_account TEXT NOT NULL,
        leader_slot INTEGER,
        leader_identity TEXT,
        submitted_at TEXT,
        processed_at TEXT,
        confirmed_at TEXT,
        finalized_at TEXT,
        submitted_slot INTEGER,
        processed_slot INTEGER,
        confirmed_slot INTEGER,
        finalized_slot INTEGER,
        failure_classification TEXT,
        failure_message TEXT,
        agent_decision_json TEXT,
        explorer_url TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_bundle_submissions_signature ON bundle_submissions(signature);
      CREATE INDEX IF NOT EXISTS idx_bundle_submissions_status ON bundle_submissions(status);
      CREATE INDEX IF NOT EXISTS idx_bundle_submissions_created_at ON bundle_submissions(created_at);

      CREATE TABLE IF NOT EXISTS lifecycle_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        submission_id TEXT NOT NULL,
        signature TEXT NOT NULL,
        stage TEXT NOT NULL,
        slot INTEGER,
        timestamp TEXT NOT NULL,
        raw_json TEXT,
        UNIQUE(submission_id, stage, slot)
      );

      CREATE INDEX IF NOT EXISTS idx_lifecycle_events_submission ON lifecycle_events(submission_id);
      CREATE INDEX IF NOT EXISTS idx_lifecycle_events_signature ON lifecycle_events(signature);
    `);
  }
}

function summarizeNumbers(values: number[]) {
  if (values.length === 0) {
    return {
      min: null,
      median: null,
      max: null
    };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
  return {
    min: sorted[0],
    median,
    max: sorted[sorted.length - 1]
  };
}
