const STAGES = ["created", "submitted", "processed", "confirmed", "finalized"];
const PAGE_SIZE = 6;

const state = {
  loading: true,
  selectedId: new URLSearchParams(window.location.search).get("tx"),
  snapshot: null,
  selectedEvents: [],
  page: 0,
  expandedEvents: new Set()
};

const els = Object.fromEntries(
  [
    "active-id",
    "active-signature",
    "active-target",
    "active-tip",
    "ai-decisions",
    "attempt-count",
    "connection-state",
    "empty",
    "error",
    "error-message",
    "landing-label",
    "landing-probability",
    "last-refresh",
    "latency-bars",
    "latency-median",
    "leader-identity",
    "leader-slot",
    "network-leader",
    "network-load",
    "network-load-copy",
    "network-slot",
    "network-success",
    "network-tips",
    "page-info",
    "page-next",
    "page-prev",
    "pager",
    "refresh",
    "recovery-content",
    "rows",
    "slot-feed",
    "slot-status",
    "status",
    "tip-points",
    "tip-range",
    "trace-bundle",
    "trace-events",
    "trace-fault",
    "trace-leader",
    "trace-signature",
    "trace-status"
  ].map((id) => [camel(id), document.querySelector(`#${id}`)])
);

for (const stage of STAGES) {
  els[camel(`stage-${stage}`)] = document.querySelector(`#stage-${stage}`);
}

els.refresh.addEventListener("click", () => void load({ manual: true }));
els.pagePrev.addEventListener("click", () => changePage(-1));
els.pageNext.addEventListener("click", () => changePage(1));

await load();
setInterval(() => void load(), 2_000);

function changePage(delta) {
  if (!state.snapshot) return;
  const pageCount = Math.max(1, Math.ceil(state.snapshot.rows.length / PAGE_SIZE));
  state.page = Math.min(pageCount - 1, Math.max(0, state.page + delta));
  renderRows(state.snapshot.rows);
}

async function load({ manual = false } = {}) {
  try {
    state.loading = true;
    els.refresh.disabled = true;
    els.refresh.setAttribute("aria-busy", "true");
    setStatus(manual ? "Refreshing evidence" : "Syncing live evidence");
    const snapshot = await fetchJson("/api/live?limit=100");
    state.snapshot = snapshot;
    ensureSelection(snapshot);
    await loadSelectedEvents();
    render(snapshot);
    showError(null);
    setStatus(`${snapshot.rows.length} attempts loaded`);
    els.connectionState.textContent = "live";
    els.connectionState.classList.remove("danger");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showError(message);
    setStatus("Evidence sync failed");
    els.connectionState.textContent = "offline";
    els.connectionState.classList.add("danger");
  } finally {
    state.loading = false;
    els.refresh.disabled = false;
    els.refresh.removeAttribute("aria-busy");
  }
}

async function loadSelectedEvents() {
  if (!state.selectedId) {
    state.selectedEvents = [];
    return;
  }
  try {
    state.selectedEvents = await fetchJson(`/api/submissions/${encodeURIComponent(state.selectedId)}/events`);
  } catch {
    state.selectedEvents = [];
  }
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
  return response.json();
}

function render(snapshot) {
  const { summary, rows, active } = snapshot;
  const selected = selectedRow(rows, active);
  renderSummary(summary, rows);
  renderPipeline(selected);
  renderRows(rows);
  renderTrace(selected);
  renderSlots(snapshot.events, selected, summary);
  renderDecisions(rows);
  renderRecovery(rows);
  renderCharts(summary, rows);
  els.empty.hidden = rows.length !== 0;
  els.lastRefresh.textContent = `refreshed ${formatTime(snapshot.generatedAt)}`;
}

function renderSummary(summary, rows) {
  const probability = Number(summary.landingProbability ?? 0.5);
  els.landingProbability.textContent = `${(probability * 100).toFixed(1)}%`;
  els.landingLabel.textContent = rows.length === 0 ? "awaiting evidence" : probability >= 0.75 ? "optimal" : probability >= 0.45 ? "viable" : "recovery";
  els.networkSlot.textContent = dash(summary.latestSlot);
  els.networkLeader.textContent = short(rows[0]?.leaderIdentity ?? "-");
  els.networkSuccess.textContent = `${formatNumber(summary.finalized ?? 0)}/${formatNumber(summary.total ?? 0)}`;
  els.networkTips.textContent = `${lamportsToSol(summary.totalTipLamports ?? 0)} SOL`;
  els.attemptCount.textContent = formatNumber(summary.total ?? rows.length);
  const load = Math.min(100, Math.round(((summary.inFlight ?? 0) + (summary.failed ?? 0)) * 12));
  els.networkLoad.textContent = `${load}%`;
  els.networkLoadCopy.textContent = rows.length === 0 ? "awaiting run" : `${formatNumber(summary.inFlight ?? 0)} in flight`;
}

function renderPipeline(row) {
  document.querySelectorAll(".pipeline li").forEach((item) => {
    item.classList.remove("complete", "current", "failed");
  });
  for (const stage of STAGES) {
    els[camel(`stage-${stage}`)].textContent = row ? stageTime(row, stage) : "-";
  }
  els.activeId.textContent = row?.id ? short(row.id) : "-";
  els.activeSignature.textContent = row ? short(row.signature, 18) : "awaiting first bundle";
  els.activeTip.textContent = row ? `tip ${lamportsToSol(row.tipLamports)} SOL` : "tip -";
  els.activeTarget.textContent = row ? `target leader ${dash(row.leaderSlot)}` : "leader -";

  if (!row) return;
  const currentIndex = row.status === "failed" ? STAGES.indexOf(lastKnownStage(row)) : Math.max(0, STAGES.indexOf(lastKnownStage(row)));
  STAGES.forEach((stage, index) => {
    const el = document.querySelector(`.pipeline li[data-stage="${stage}"]`);
    if (!el) return;
    if (row.status === "failed" && index === currentIndex) el.classList.add("failed");
    else if (index < currentIndex || row.status === "finalized") el.classList.add("complete");
    else if (index === currentIndex) el.classList.add("current");
  });
}

function renderRows(rows) {
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (state.page > pageCount - 1) state.page = pageCount - 1;
  const start = state.page * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);

  els.rows.innerHTML = "";
  for (const row of pageRows) {
    const tr = document.createElement("tr");
    if (row.id === state.selectedId) tr.classList.add("selected");
    tr.innerHTML = `
      <td class="mono">
        <a href="${escapeAttr(row.explorerUrl ?? "#")}" target="_blank" rel="noreferrer">${short(row.signature, 16)}</a>
        <div class="subtle">${row.bundleId ? short(row.bundleId, 18) : "rpc broadcast"}</div>
      </td>
      <td>${escapeHtml(row.faultMode === "none" ? "Jito bundle" : row.faultMode)}</td>
      <td><span class="badge ${escapeAttr(row.status ?? "")}">${escapeHtml(row.status ?? "-")}</span></td>
      <td class="mono">${lamportsToSol(row.tipLamports)}</td>
      <td class="mono">
        <span>c ${formatMs(row.confirmedDeltaMs)}</span>
        <span>f ${formatMs(row.finalizedDeltaMs)}</span>
      </td>
      <td><button class="row-action" type="button" data-id="${escapeAttr(row.id)}">Inspect</button></td>
    `;
    els.rows.appendChild(tr);
  }

  els.pager.hidden = rows.length <= PAGE_SIZE;
  els.pageInfo.textContent = `page ${state.page + 1} / ${pageCount} · ${rows.length} total`;
  els.pagePrev.disabled = state.page === 0;
  els.pageNext.disabled = state.page >= pageCount - 1;

  els.rows.querySelectorAll("button[data-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.selectedId = button.getAttribute("data-id");
      state.expandedEvents = new Set();
      const url = new URL(window.location.href);
      url.searchParams.set("tx", state.selectedId);
      window.history.replaceState({}, "", url);
      await loadSelectedEvents();
      render(state.snapshot);
      els.traceSignature.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  });
}

function renderTrace(row) {
  els.traceSignature.textContent = row ? short(row.signature, 18) : "select a bundle";
  els.traceBundle.textContent = short(row?.bundleId ?? "-");
  els.traceFault.textContent = row?.faultMode ?? "-";
  els.traceLeader.textContent = dash(row?.leaderSlot);
  els.traceStatus.innerHTML = row ? `<span class="badge ${escapeAttr(row.status)}">${escapeHtml(row.status)}</span>` : "-";

  const events = state.selectedEvents.length > 0 ? state.selectedEvents : fallbackEvents(row);
  els.traceEvents.innerHTML = events.length === 0
    ? `<p class="subtle">No lifecycle events recorded for the selected bundle yet.</p>`
    : events.map((event) => renderTraceEvent(event, row)).join("");

  els.traceEvents.querySelectorAll("button[data-event]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.getAttribute("data-event");
      if (state.expandedEvents.has(key)) state.expandedEvents.delete(key);
      else state.expandedEvents.add(key);
      renderTrace(selectedRow(state.snapshot.rows, state.snapshot.active));
    });
  });
}

function renderTraceEvent(event, row) {
  const log = parseLog(event.rawJson);
  const source = log?.source ?? "store";
  const key = String(event.id ?? `${event.stage}-${event.slot}`);
  const expanded = state.expandedEvents.has(key);
  const detail = log ? JSON.stringify(log, null, 2) : null;
  return `
    <article class="trace-event ${event.stage === "finalized" ? "done" : ""}">
      <div class="trace-event-head">
        <strong>${escapeHtml(event.stage ?? "created")}</strong>
        <span class="source-tag source-${escapeAttr(source)}">${escapeHtml(source)}</span>
      </div>
      <div class="trace-event-meta">
        <span class="mono">${formatTime(event.timestamp ?? row?.createdAt)}</span>
        <small>slot ${dash(event.slot)}</small>
      </div>
      ${detail ? `<button class="log-toggle" type="button" data-event="${escapeAttr(key)}">${expanded ? "hide log" : "view log"}</button>` : ""}
      ${detail && expanded ? `<pre class="trace-log">${escapeHtml(detail)}</pre>` : ""}
    </article>
  `;
}

function parseLog(raw) {
  if (!raw) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { source: "store", note: String(raw) };
  }
}

function renderSlots(events, row, summary) {
  const slotEvents = events.filter((event) => event.slot).slice(0, 10);
  els.slotFeed.innerHTML = slotEvents.length === 0
    ? `<p class="subtle">awaiting streamed slots...</p>`
    : slotEvents.map((event) => `
      <div class="slot-line">
        <span class="mono">${dash(event.slot)}</span>
        <span>${escapeHtml(event.stage ?? "event")}</span>
      </div>
    `).join("");
  els.slotStatus.textContent = events.length > 0 ? "streamed" : "store";
  els.leaderSlot.textContent = row?.leaderSlot ?? summary.latestSlot ?? "-";
  els.leaderIdentity.textContent = row?.leaderIdentity ? short(row.leaderIdentity, 22) : "awaiting leader evidence";
}

function renderDecisions(rows) {
  const decisions = rows.map((row) => ({ row, decision: parseDecision(row.agentDecisionJson) })).filter((item) => item.decision);
  els.aiDecisions.innerHTML = decisions.length === 0
    ? `<p class="subtle">no decisions yet - agent fires on blockhash expiry evidence</p>`
    : decisions.slice(0, 4).map(({ row, decision }) => `
      <article class="decision-card">
        <strong>${escapeHtml(decision.retry_action.replace("_", " "))} · ${lamportsToSol(decision.tip_lamports)} SOL</strong>
        <span>${escapeHtml(decision.failure_classification.replace(/_/g, " "))} · confidence ${Math.round((decision.confidence ?? 0) * 100)}%</span>
        <p>${escapeHtml(decision.reasoning_summary ?? "")}</p>
        <small>${short(row.signature, 18)}</small>
      </article>
    `).join("");
}

function renderRecovery(rows) {
  const failed = rows.find((row) => row.status === "failed" || row.failureClassification);
  if (!failed) {
    els.recoveryContent.innerHTML = `<strong>bundles nominal</strong><span>no active recovery - failures will appear here with agent evidence</span>`;
    return;
  }
  els.recoveryContent.innerHTML = `
    <strong>${short(failed.signature, 16)} ${escapeHtml(failed.status)}</strong>
    <span>class: ${escapeHtml(failed.failureClassification ?? "unknown")}</span>
    <p>${escapeHtml(trim(failed.failureMessage ?? "awaiting classified failure details", 180))}</p>
  `;
}

function renderCharts(summary, rows) {
  const latency = summary.confirmedLatencyMs ?? {};
  els.latencyMedian.textContent = latency.median === null || latency.median === undefined ? "-" : `${latency.median}ms`;
  els.latencyBars.innerHTML = [latency.min, latency.median, latency.max].map((value) => `<span style="height:${barHeight(value)}%"></span>`).join("");
  els.tipRange.textContent = summary.minTipLamports ? `${lamportsToSol(summary.minTipLamports)}-${lamportsToSol(summary.maxTipLamports)} SOL` : "-";
  els.tipPoints.innerHTML = rows.slice(0, 18).map((row, index) => {
    const left = 6 + index * 5;
    const bottom = Math.max(8, Math.min(86, Number(row.tipLamports ?? 0) / Math.max(1, Number(summary.maxTipLamports ?? 1)) * 80));
    return `<span class="${row.status === "finalized" ? "landed" : "pending"}" style="left:${left}%;bottom:${bottom}%"></span>`;
  }).join("");
}

function ensureSelection(snapshot) {
  if (snapshot.rows.some((row) => row.id === state.selectedId)) return;
  state.selectedId = snapshot.active?.id ?? snapshot.rows[0]?.id ?? null;
}

function selectedRow(rows, active) {
  return rows.find((row) => row.id === state.selectedId) ?? active ?? rows[0] ?? null;
}

function lastKnownStage(row) {
  if (row.finalizedAt || row.status === "finalized") return "finalized";
  if (row.confirmedAt || row.status === "confirmed") return "confirmed";
  if (row.processedAt || row.status === "processed") return "processed";
  if (row.submittedAt || row.status === "submitted") return "submitted";
  return "created";
}

function stageTime(row, stage) {
  const key = `${stage}At`;
  return row?.[key] ? formatTime(row[key]) : "-";
}

function fallbackEvents(row) {
  if (!row) return [];
  return STAGES
    .map((stage) => ({ stage, timestamp: row[`${stage}At`], slot: row[`${stage}Slot`] }))
    .filter((event) => event.timestamp || event.stage === "created");
}

function parseDecision(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function showError(message) {
  els.error.hidden = !message;
  if (message) els.errorMessage.textContent = message;
}

function setStatus(value) {
  els.status.textContent = value;
}

function short(value, size = 12) {
  if (!value) return "-";
  const text = String(value);
  return text.length > size ? `${text.slice(0, Math.floor(size / 2))}...${text.slice(-Math.floor(size / 2))}` : text;
}

function dash(value) {
  return value === null || value === undefined || value === "" ? "-" : value;
}

function formatMs(value) {
  return typeof value === "number" ? `${value}ms` : "-";
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Number(value ?? 0));
}

function formatTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function lamportsToSol(value) {
  return (Number(value ?? 0) / 1_000_000_000).toFixed(6).replace(/0+$/, "0");
}

function barHeight(value) {
  if (typeof value !== "number") return 6;
  return Math.max(12, Math.min(88, value / 20));
}

function trim(value, max) {
  const text = String(value);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

function camel(id) {
  return id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}
