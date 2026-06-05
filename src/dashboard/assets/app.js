const state = {
  loading: true
};

const els = {
  total: document.querySelector("#total"),
  finalized: document.querySelector("#finalized"),
  failed: document.querySelector("#failed"),
  updated: document.querySelector("#updated"),
  status: document.querySelector("#status"),
  rows: document.querySelector("#rows"),
  empty: document.querySelector("#empty"),
  refresh: document.querySelector("#refresh")
};

els.refresh.addEventListener("click", () => {
  void load();
});

await load();
setInterval(load, 5000);

async function load() {
  try {
    state.loading = true;
    setStatus("Loading live evidence");
    const [summary, rows] = await Promise.all([
      fetchJson("/api/summary"),
      fetchJson("/api/submissions?limit=100")
    ]);
    renderSummary(summary);
    renderRows(rows);
    setStatus(`${rows.length} rows loaded`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    state.loading = false;
  }
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
  return response.json();
}

function renderSummary(summary) {
  els.total.textContent = formatNumber(summary.total ?? 0);
  els.finalized.textContent = formatNumber(summary.finalized ?? 0);
  els.failed.textContent = formatNumber(summary.failed ?? 0);
  els.updated.textContent = summary.lastUpdated ? formatTime(summary.lastUpdated) : "-";
}

function renderRows(rows) {
  els.rows.innerHTML = "";
  els.empty.hidden = rows.length !== 0;

  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">
        <a href="${escapeAttr(row.explorerUrl ?? "#")}" target="_blank" rel="noreferrer">${short(row.signature)}</a>
        <div class="muted">${short(row.bundleId ?? "")}</div>
      </td>
      <td><span class="badge ${escapeAttr(row.status ?? "")}">${escapeHtml(row.status ?? "-")}</span></td>
      <td>${escapeHtml(row.faultMode ?? "none")}</td>
      <td class="mono">
        <div>leader ${dash(row.leaderSlot)}</div>
        <div class="muted">tx ${dash(row.processedSlot)} / ${dash(row.finalizedSlot)}</div>
      </td>
      <td class="mono">
        <div>p ${formatMs(row.processedDeltaMs)}</div>
        <div>c ${formatMs(row.confirmedDeltaMs)}</div>
        <div>f ${formatMs(row.finalizedDeltaMs)}</div>
      </td>
      <td class="mono">
        <div>${formatNumber(row.tipLamports)} lamports</div>
        <div class="muted">${escapeHtml(row.tipSource ?? "")}</div>
      </td>
      <td>
        <div>${escapeHtml(row.failureClassification ?? "-")}</div>
        <div class="muted">${escapeHtml(trim(row.failureMessage ?? "", 96))}</div>
      </td>
      <td>${renderAgent(row.agentDecisionJson)}</td>
    `;
    els.rows.appendChild(tr);
  }
}

function renderAgent(raw) {
  if (!raw) return '<span class="muted">-</span>';
  try {
    const parsed = JSON.parse(raw);
    return `
      <div>${escapeHtml(parsed.retry_action ?? "-")} · ${formatNumber(parsed.tip_lamports ?? 0)} lamports</div>
      <div class="muted">${escapeHtml(trim(parsed.reasoning_summary ?? "", 120))}</div>
    `;
  } catch {
    return '<span class="muted">unparseable</span>';
  }
}

function setStatus(value) {
  els.status.textContent = value;
}

function short(value) {
  if (!value) return "-";
  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-6)}` : value;
}

function dash(value) {
  return value === null || value === undefined ? "-" : value;
}

function formatMs(value) {
  return typeof value === "number" ? `${value}ms` : "-";
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Number(value ?? 0));
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function trim(value, max) {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
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
