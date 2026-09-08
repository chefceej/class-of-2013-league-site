/* Championship Start Planner — single team, continuous 14-day matchup.
   No password. Whole-championship start pool with a per-week ceiling. */

let LIMIT_TOTAL = 24;
let LIMIT_WEEK = 12;

let state = {
  data: null,
  checked: new Set(),          // rostered start keys: "PitcherName|date"
  streamChecked: new Set(),    // streaming start keys actually selected
  streamIncluded: new Set(),   // streaming pitcher names folded into the plan
  streamSort: "pts_per_gs",
  streamSortAsc: false,
  streamGreenOnly: false,
  collapsedDays: new Set(),    // past day-columns hidden (shared by both tables)
  opsMode: "30d",              // "30d" | "split"
  relievers: [],
  relieverSort: "status",
  relieverSortAsc: true,
};

/* ── Persistence (localStorage, scoped to the championship window) ── */

const SELECTIONS_KEY = "champPlanner_v1";

function windowKey() {
  return state.data?.metadata?.window_start || "";
}

function loadStored() {
  try {
    const raw = localStorage.getItem(SELECTIONS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.windowStart !== windowKey()) return null;
    return parsed;
  } catch { return null; }
}

function saveSelections() {
  const ws = windowKey();
  if (!ws) return;
  const payload = {
    windowStart: ws,
    checked: [...state.checked],
    streams: [...state.streamChecked],
    streamIncluded: [...state.streamIncluded],
    collapsedDays: [...state.collapsedDays],
  };
  try { localStorage.setItem(SELECTIONS_KEY, JSON.stringify(payload)); } catch {}
}

/* ── Helpers ── */

function startKey(name, date) { return `${name}|${date}`; }

function opsClass(ops) {
  if (ops == null) return "ops-none";
  if (ops <= 0.680) return "ops-easy";
  if (ops <= 0.740) return "ops-ok";
  return "ops-tough";
}

function opsLabel(ops) { return ops == null ? "—" : ops.toFixed(3); }

function getStartOpsValue(start, teamOps) {
  if (state.opsMode === "split" && start.opponent_ops_split != null) {
    return start.opponent_ops_split;
  }
  return start.opponent_ops ?? teamOps[start.opponent];
}

function dayHeaderInner(date) {
  const d = new Date(date + "T12:00:00");
  return `<span class="day-name">${d.toLocaleDateString("en-US", { weekday: "short" })}</span><br>` +
         `<span class="day-date">${d.toLocaleDateString("en-US", { month: "numeric", day: "numeric" })}</span>`;
}

function today() {
  return state.data?.metadata?.today || new Date().toLocaleDateString("en-CA");
}

function weekDates(idx) {
  return new Set((state.data?.weeks?.[idx]?.dates) || []);
}

/* ── Counter ── */

function countSelected(dateSet) {
  let count = 0;
  for (const p of state.data.pitchers) {
    for (const s of p.starts) {
      if (dateSet.has(s.date) && state.checked.has(startKey(p.name, s.date))) count++;
    }
  }
  for (const p of includedStreamPitchers()) {
    for (const s of p.starts) {
      if (dateSet.has(s.date) && state.streamChecked.has(startKey(p.name, s.date))) count++;
    }
  }
  return count;
}

function updateCounter() {
  const allDates = new Set(state.data.dates);
  const total = countSelected(allDates);
  const el = document.getElementById("start-counter");
  el.textContent = `${total} / ${LIMIT_TOTAL}`;
  el.className = "start-counter" +
    (total > LIMIT_TOTAL ? " over-limit" : total === LIMIT_TOTAL ? " at-limit" : "");

  const w1 = countSelected(weekDates(0));
  const w2 = countSelected(weekDates(1));
  const cls = n => n > LIMIT_WEEK ? "wk-over" : n === LIMIT_WEEK ? "wk-full" : "";
  document.getElementById("week-breakdown").innerHTML =
    `<span class="${cls(w1)}">Wk 1 ${w1}/${LIMIT_WEEK}</span>` +
    `<span class="wk-sep">·</span>` +
    `<span class="${cls(w2)}">Wk 2 ${w2}/${LIMIT_WEEK}</span>`;
}

/* ── Included streaming pitchers ── */

function includedStreamPitchers() {
  if (!state.data?.streaming_options) return [];
  return state.data.streaming_options.filter(p => state.streamIncluded.has(p.name));
}

/* ── Day column headers (shared collapse logic) ── */

function buildDayHeader(tr, date, tableId, onSort, sortActive, sortAsc) {
  const isPast = date < today();

  if (state.collapsedDays.has(date)) {
    const th = document.createElement("th");
    th.className = "day-collapsed";
    const d = new Date(date + "T12:00:00");
    th.title = `${d.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" })} — click to expand`;
    th.innerHTML = `<span class="collapsed-label">${d.toLocaleDateString("en-US", { month: "numeric", day: "numeric" })}</span>`;
    th.addEventListener("click", () => { state.collapsedDays.delete(date); rerender(); });
    tr.appendChild(th);
    return;
  }

  const th = document.createElement("th");
  th.className = (onSort ? "sortable-col " : "") + (sortActive ? "sort-active " : "") + (isPast ? "past-day" : "");
  const collapseHandle = isPast ? `<span class="col-collapse" title="Hide this past day">×</span>` : "";
  const arrow = sortActive ? `<br><span class="sort-arrow">${sortAsc ? "▲" : "▼"}</span>` : "";
  th.innerHTML = collapseHandle + dayHeaderInner(date) + arrow;
  th.style.cursor = onSort || isPast ? "pointer" : "default";
  th.addEventListener("click", (e) => {
    if (e.target.classList.contains("col-collapse")) {
      state.collapsedDays.add(date);
      rerender();
      return;
    }
    if (onSort) onSort();
  });
  tr.appendChild(th);
}

/* ── Rostered planner table (continuous) ── */

function buildStartCell(start, isOn, teamOps, onClick) {
  const td = document.createElement("td");
  const ops = getStartOpsValue(start, teamOps);
  td.className = "start-cell " + opsClass(ops);
  td.classList.add(isOn ? "start-on" : "start-off");
  if (start.points != null) td.classList.add("start-played");
  if (start.projected) {
    td.classList.add("start-projected");
    td.title = "Projected start (rotation estimate — not yet confirmed by ESPN)";
  }
  const projHtml = start.projected ? `<span class="proj-dot" aria-label="projected">~</span>` : "";
  const oppHtml = `<span class="opp-name">${start.home ? "" : "@"}${start.opponent}</span>`;
  const opsHtml = `<span class="opp-ops">${opsLabel(ops)}</span>`;
  const ptsHtml = start.points != null ? `<span class="start-points">${start.points.toFixed(1)}</span>` : "";
  td.innerHTML = projHtml + oppHtml + opsHtml + ptsHtml;
  if (onClick) { td.style.cursor = "pointer"; td.addEventListener("click", onClick); }
  return td;
}

function buildPlannerRow(pitcher, dates, teamOps, isStream) {
  const checkedSet = isStream ? state.streamChecked : state.checked;
  const startsByDate = {};
  for (const s of pitcher.starts) startsByDate[s.date] = s;

  const row = document.createElement("tr");
  if (isStream) row.classList.add("stream-selected-row");

  const allKeys = pitcher.starts.map(s => startKey(pitcher.name, s.date));
  const checkedCount = allKeys.filter(k => checkedSet.has(k)).length;
  const allChecked = checkedCount === pitcher.starts.length;
  const noneChecked = checkedCount === 0;
  if (noneChecked && pitcher.starts.length > 0) row.classList.add("pitcher-off");

  const cbTd = document.createElement("td");
  cbTd.className = "starts-check-col";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = allChecked;
  cb.indeterminate = !allChecked && !noneChecked;
  cb.title = isStream ? "Remove from plan" : "Toggle all starts";
  cb.addEventListener("change", () => {
    if (isStream && !cb.checked) {
      // Unchecking a folded-in streamer removes it from the plan entirely.
      state.streamIncluded.delete(pitcher.name);
      for (const k of allKeys) state.streamChecked.delete(k);
    } else {
      for (const k of allKeys) {
        if (cb.checked) checkedSet.add(k); else checkedSet.delete(k);
      }
    }
    rerender();
  });
  cbTd.appendChild(cb);
  row.appendChild(cbTd);

  const nameTd = document.createElement("td");
  nameTd.className = "starts-name-col";
  const tag = isStream ? `<span class="pitcher-team stream-tag">${pitcher.mlb_team} · FA</span>`
                       : `<span class="pitcher-team">${pitcher.mlb_team}</span>`;
  nameTd.innerHTML = `<span class="pitcher-name">${pitcher.name}</span>${tag}`;
  row.appendChild(nameTd);

  for (const date of dates) {
    if (state.collapsedDays.has(date)) {
      const td = document.createElement("td");
      td.className = "day-collapsed";
      row.appendChild(td);
      continue;
    }
    const start = startsByDate[date];
    if (!start) { row.appendChild(document.createElement("td")); continue; }
    const key = startKey(pitcher.name, date);
    const isOn = checkedSet.has(key);
    row.appendChild(buildStartCell(start, isOn, teamOps, () => {
      if (checkedSet.has(key)) checkedSet.delete(key); else checkedSet.add(key);
      rerender();
    }));
  }
  return row;
}

function renderPlanner() {
  const dates = state.data.dates;
  const teamOps = state.data.team_ops_30d;

  const head = document.getElementById("starts-head");
  head.innerHTML = "";
  const tr = document.createElement("tr");
  const cbTh = document.createElement("th");
  cbTh.className = "starts-check-col";
  tr.appendChild(cbTh);
  const nameTh = document.createElement("th");
  nameTh.textContent = "Pitcher";
  nameTh.className = "starts-name-col";
  tr.appendChild(nameTh);
  for (const date of dates) buildDayHeader(tr, date, "starts-table", null, false, false);
  head.appendChild(tr);

  const body = document.getElementById("starts-body");
  body.innerHTML = "";

  const rostered = [...state.data.pitchers].sort(
    (a, b) => b.starts.length - a.starts.length || a.name.localeCompare(b.name)
  );
  const streams = includedStreamPitchers();

  if (rostered.length === 0 && streams.length === 0) {
    const row = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = dates.length + 2;
    td.textContent = "No probable starts found in this window yet.";
    td.style.cssText = "text-align:center;color:#64748b;padding:2rem";
    row.appendChild(td);
    body.appendChild(row);
  } else {
    for (const p of rostered) body.appendChild(buildPlannerRow(p, dates, teamOps, false));
    for (const p of streams) body.appendChild(buildPlannerRow(p, dates, teamOps, true));
  }
  updateCounter();
}

/* ── Stream Assistant: starters ── */

function isGreenOps(ops) { return ops != null && opsClass(ops) === "ops-easy"; }

function bestUpcomingOps(pitcher, teamOps, tdy) {
  let best = null;
  for (const s of pitcher.starts) {
    if (s.date < tdy) continue;
    const ops = getStartOpsValue(s, teamOps);
    if (ops == null) continue;
    if (best == null || ops < best) best = ops;
  }
  return best;
}

function hasUpcomingGreen(pitcher, teamOps, tdy) {
  return pitcher.starts.some(s => s.date >= tdy && isGreenOps(getStartOpsValue(s, teamOps)));
}

function getStartOpsForSort(pitcher, date, teamOps) {
  const s = pitcher.starts.find(x => x.date === date);
  return s ? (getStartOpsValue(s, teamOps) ?? null) : null;
}

function renderStreamingTable() {
  const data = state.data;
  if (!data) return;
  const dates = data.dates;
  const teamOps = data.team_ops_30d;
  const tdy = today();

  let list = data.streaming_options || [];
  if (state.streamGreenOnly) list = list.filter(p => hasUpcomingGreen(p, teamOps, tdy));

  const sorted = [...list].sort((a, b) => {
    const key = state.streamSort;
    if (key === "bestOps") {
      const oa = bestUpcomingOps(a, teamOps, tdy), ob = bestUpcomingOps(b, teamOps, tdy);
      if (oa == null && ob == null) return 0;
      if (oa == null) return 1;
      if (ob == null) return -1;
      return state.streamSortAsc ? oa - ob : ob - oa;
    }
    if (key.startsWith("day:")) {
      const date = key.slice(4);
      const oa = getStartOpsForSort(a, date, teamOps), ob = getStartOpsForSort(b, date, teamOps);
      if (oa == null && ob == null) return 0;
      if (oa == null) return 1;
      if (ob == null) return -1;
      return state.streamSortAsc ? oa - ob : ob - oa;
    }
    const va = a[key] ?? -Infinity, vb = b[key] ?? -Infinity;
    return state.streamSortAsc ? va - vb : vb - va;
  });

  const head = document.getElementById("streaming-head");
  head.innerHTML = "";
  const tr = document.createElement("tr");
  const cbTh = document.createElement("th"); cbTh.className = "stream-check-col"; tr.appendChild(cbTh);
  const nameTh = document.createElement("th"); nameTh.textContent = "Pitcher"; nameTh.className = "stream-name-col"; tr.appendChild(nameTh);

  for (const col of [
    { key: "pts_per_gs", label: "Pts/GS" },
    { key: "season_pts", label: "SZN" },
    { key: "pr30_pts", label: "PR30" },
  ]) {
    const th = document.createElement("th");
    const active = state.streamSort === col.key;
    th.className = "stream-stat-col sortable-col" + (active ? " sort-active" : "");
    th.innerHTML = col.label + (active ? ` <span class="sort-arrow">${state.streamSortAsc ? "▲" : "▼"}</span>` : "");
    th.style.cursor = "pointer";
    th.addEventListener("click", () => {
      if (state.streamSort === col.key) state.streamSortAsc = !state.streamSortAsc;
      else { state.streamSort = col.key; state.streamSortAsc = false; }
      renderStreamingTable();
    });
    tr.appendChild(th);
  }

  for (const date of dates) {
    const sortKey = "day:" + date;
    const active = state.streamSort === sortKey;
    buildDayHeader(tr, date, "streaming-table", () => {
      if (state.streamSort === sortKey) state.streamSortAsc = !state.streamSortAsc;
      else { state.streamSort = sortKey; state.streamSortAsc = true; }
      renderStreamingTable();
    }, active, state.streamSortAsc);
  }
  head.appendChild(tr);

  const body = document.getElementById("streaming-body");
  body.innerHTML = "";

  if (sorted.length === 0) {
    const row = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = dates.length + 5;
    td.textContent = state.streamGreenOnly
      ? "No free agents with a green upcoming matchup. Turn off the green filter to see all."
      : "No streaming options found in this window.";
    td.style.cssText = "text-align:center;color:#64748b;padding:2rem";
    row.appendChild(td);
    body.appendChild(row);
    syncStreamFilterUI();
    return;
  }

  for (const pitcher of sorted) {
    const startsByDate = {};
    for (const s of pitcher.starts) startsByDate[s.date] = s;
    const row = document.createElement("tr");
    const included = state.streamIncluded.has(pitcher.name);
    if (included) row.classList.add("stream-included");

    function toggleInclude() {
      if (state.streamIncluded.has(pitcher.name)) {
        state.streamIncluded.delete(pitcher.name);
        for (const s of pitcher.starts) state.streamChecked.delete(startKey(pitcher.name, s.date));
      } else {
        state.streamIncluded.add(pitcher.name);
        for (const s of pitcher.starts) state.streamChecked.add(startKey(pitcher.name, s.date));
      }
      rerender();
    }

    const cbTd = document.createElement("td");
    cbTd.className = "stream-check-col";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = included; cb.title = "Add to plan";
    cb.addEventListener("change", toggleInclude);
    cbTd.appendChild(cb);
    row.appendChild(cbTd);

    const nameTd = document.createElement("td");
    nameTd.className = "stream-name-col";
    nameTd.innerHTML = `<span class="pitcher-name">${pitcher.name}</span><span class="pitcher-team">${pitcher.mlb_team}</span>`;
    nameTd.addEventListener("click", toggleInclude);
    row.appendChild(nameTd);

    for (const key of ["pts_per_gs", "season_pts", "pr30_pts"]) {
      const td = document.createElement("td");
      td.className = "stream-stat-col";
      const val = pitcher[key];
      td.textContent = val != null ? val.toFixed(1) : "—";
      row.appendChild(td);
    }

    for (const date of dates) {
      if (state.collapsedDays.has(date)) {
        const td = document.createElement("td"); td.className = "day-collapsed"; row.appendChild(td); continue;
      }
      const start = startsByDate[date];
      if (!start) { row.appendChild(document.createElement("td")); continue; }
      const key = startKey(pitcher.name, date);
      const isOn = state.streamChecked.has(key);
      row.appendChild(buildStartCell(start, isOn, teamOps, () => {
        if (state.streamChecked.has(key)) state.streamChecked.delete(key);
        else { state.streamChecked.add(key); state.streamIncluded.add(pitcher.name); }
        rerender();
      }));
    }
    body.appendChild(row);
  }
  syncStreamFilterUI();
}

/* ── Hide-past + filters ── */

function pastDates() {
  const tdy = today();
  return (state.data?.dates || []).filter(d => d < tdy);
}

function toggleHidePast() {
  const past = pastDates();
  const allHidden = past.length > 0 && past.every(d => state.collapsedDays.has(d));
  if (allHidden) for (const d of past) state.collapsedDays.delete(d);
  else for (const d of past) state.collapsedDays.add(d);
  rerender();
}

function syncStreamFilterUI() {
  const green = document.getElementById("stream-green-toggle");
  if (green) green.classList.toggle("active", state.streamGreenOnly);
  const best = document.getElementById("stream-best-toggle");
  if (best) best.classList.toggle("active", state.streamSort === "bestOps");

  const past = pastDates();
  const allHidden = past.length > 0 && past.every(d => state.collapsedDays.has(d));
  for (const id of ["hidepast-toggle", "stream-hidepast-toggle"]) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.classList.toggle("active", allHidden);
    btn.textContent = allHidden ? "Show past days" : "Hide past days";
    btn.disabled = past.length === 0;
  }
}

function initFilters() {
  document.getElementById("hidepast-toggle")?.addEventListener("click", toggleHidePast);
  document.getElementById("stream-hidepast-toggle")?.addEventListener("click", toggleHidePast);

  document.getElementById("stream-green-toggle")?.addEventListener("click", () => {
    state.streamGreenOnly = !state.streamGreenOnly;
    renderStreamingTable();
  });
  document.getElementById("stream-best-toggle")?.addEventListener("click", () => {
    if (state.streamSort === "bestOps") state.streamSortAsc = !state.streamSortAsc;
    else { state.streamSort = "bestOps"; state.streamSortAsc = true; }
    renderStreamingTable();
  });
}

/* ── OPS mode toggle ── */

function initOpsToggle() {
  const wrap = document.getElementById("ops-mode-toggle");
  if (!wrap) return;
  wrap.querySelectorAll(".ops-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode;
      if (mode === state.opsMode) return;
      state.opsMode = mode;
      wrap.querySelectorAll(".ops-toggle-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
      document.getElementById("ops-legend-standard").style.display = mode === "30d" ? "" : "none";
      document.getElementById("ops-legend-split").style.display = mode === "split" ? "" : "none";
      rerender();
    });
  });
}

/* ── Stream tabs ── */

function initStreamTabs() {
  const toggle = document.getElementById("stream-tab-toggle");
  if (!toggle) return;
  toggle.querySelectorAll(".stream-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      toggle.querySelectorAll(".stream-tab-btn").forEach(b => b.classList.toggle("active", b === btn));
      document.getElementById("stream-pane-starters").style.display = tab === "starters" ? "" : "none";
      document.getElementById("stream-pane-relievers").style.display = tab === "relievers" ? "" : "none";
    });
  });
}

/* ── Bulk relievers ── */

const RELIEVER_COLS = [
  { key: "name", label: "Pitcher", cls: "rel-name-col", defaultAsc: true },
  { key: "status", label: "Status", cls: "rel-status-col", defaultAsc: true },
  { key: "days_since", label: "Last App", cls: "rel-num-col", defaultAsc: false },
  { key: "pts_per_ip", label: "Pts/IP", cls: "rel-num-col", defaultAsc: false },
];

function compareRelievers(a, b) {
  const key = state.relieverSort;
  let cmp;
  if (key === "name") cmp = a.name.localeCompare(b.name);
  else if (key === "status") {
    const order = { due: 0, rested: 1 };
    cmp = (order[a.status] ?? 9) - (order[b.status] ?? 9);
    if (cmp === 0) cmp = b.pts_per_ip - a.pts_per_ip;
  } else cmp = (a[key] ?? -Infinity) - (b[key] ?? -Infinity);
  return state.relieverSortAsc ? cmp : -cmp;
}

function renderRelieverTable() {
  const relievers = state.relievers || [];
  const head = document.getElementById("reliever-head");
  head.innerHTML = "";
  const tr = document.createElement("tr");
  for (const col of RELIEVER_COLS) {
    const active = state.relieverSort === col.key;
    const th = document.createElement("th");
    th.className = col.cls + " sortable-col" + (active ? " sort-active" : "");
    th.innerHTML = col.label + (active ? ` <span class="sort-arrow">${state.relieverSortAsc ? "▲" : "▼"}</span>` : "");
    th.addEventListener("click", () => {
      if (state.relieverSort === col.key) state.relieverSortAsc = !state.relieverSortAsc;
      else { state.relieverSort = col.key; state.relieverSortAsc = col.defaultAsc; }
      renderRelieverTable();
    });
    tr.appendChild(th);
  }
  head.appendChild(tr);

  const body = document.getElementById("reliever-body");
  body.innerHTML = "";
  if (relievers.length === 0) {
    body.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#64748b;padding:1.5rem">No bulk relievers found.</td></tr>';
    document.getElementById("reliever-note").textContent = "";
    return;
  }
  const sorted = [...relievers].sort(compareRelievers);
  for (const r of sorted) {
    const isDue = r.status === "due";
    const last = r.days_since === 0 ? "Today" : `${r.days_since}d ago`;
    const row = document.createElement("tr");
    if (isDue) row.classList.add("reliever-due-row");
    row.innerHTML =
      `<td class="rel-name-col"><span class="pitcher-name">${r.name}</span><span class="pitcher-team">${r.mlb_team}</span></td>` +
      `<td class="rel-status-col"><span class="rel-pill ${isDue ? "rel-due" : "rel-rested"}">${isDue ? "Due" : "Rested"}</span></td>` +
      `<td class="rel-num-col">${last}</td>` +
      `<td class="rel-num-col">${r.pts_per_ip.toFixed(2)}</td>`;
    body.appendChild(row);
  }
  const dueCount = relievers.filter(r => r.status === "due").length;
  document.getElementById("reliever-note").textContent =
    `${relievers.length} bulk relievers · ${dueCount} due now. ` +
    `Free-agent RPs who often work 1.1–3.0 innings and rarely exceed 3.0.`;
}

function loadRelievers() {
  fetch("../data/mendel_relievers_data.json")
    .then(r => r.json())
    .then(data => { state.relievers = data.relievers || []; renderRelieverTable(); })
    .catch(() => {
      const body = document.getElementById("reliever-body");
      if (body) body.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#f87171;padding:1.5rem">Could not load reliever data.</td></tr>';
    });
}

/* ── Render orchestration ── */

function rerender() {
  saveSelections();
  renderPlanner();
  renderStreamingTable();
}

function resetChecked() {
  state.checked.clear();
  const stored = loadStored();
  if (stored) {
    for (const k of stored.checked || []) state.checked.add(k);
    for (const k of stored.streams || []) state.streamChecked.add(k);
    for (const n of stored.streamIncluded || []) state.streamIncluded.add(n);
    for (const d of stored.collapsedDays || []) state.collapsedDays.add(d);
    return;
  }
  // Default: every real (confirmed) start checked; projections left off so the
  // count reflects what's actually locked in.
  for (const p of state.data.pitchers) {
    for (const s of p.starts) {
      if (!s.projected) state.checked.add(startKey(p.name, s.date));
    }
  }
}

function loadData() {
  fetch("../data/mendel_starts_data.json")
    .then(r => r.json())
    .then(data => {
      state.data = data;
      LIMIT_TOTAL = data.metadata?.start_limit_total || 24;
      LIMIT_WEEK = data.metadata?.start_limit_week || 12;

      document.getElementById("team-name").textContent = data.metadata?.team_name || "Championship Start Planner";

      const lu = document.getElementById("last-updated");
      const fmt = s => new Date(s + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
      if (data.metadata) {
        const upd = data.metadata.last_updated ? new Date(data.metadata.last_updated).toLocaleString() : "";
        lu.textContent = `Championship window ${fmt(data.metadata.window_start)} – ${fmt(data.metadata.window_end)} · Updated ${upd}`;
      }

      resetChecked();
      initOpsToggle();
      initStreamTabs();
      initFilters();
      rerender();
      loadRelievers();
    })
    .catch(() => {
      document.getElementById("starts-body").innerHTML =
        '<tr><td colspan="99" style="text-align:center;color:#f87171;padding:2rem">Could not load starts data.</td></tr>';
    });
}

loadData();
