const START_LIMIT = 8;
const PASSWORD = "hookem";

let state = {
  data: null,
  team: null,
  checked: new Set(),         // rostered start keys: "PitcherName|date"
  streamChecked: new Set(),   // streaming start keys (the actual selected starts)
  streamIncluded: new Set(),  // streaming pitcher names included in planner view
  streamSort: "pts_per_gs",
  streamSortAsc: false,
  streamGreenOnly: false,     // filter streaming to favorable (green) upcoming matchups
  streamCollapsedDays: new Set(), // past day-columns collapsed in the streaming table
  weekOpen: {},               // per-week collapsed/expanded state, keyed by week_start
  opsMode: "30d",             // "30d" | "split"
  relievers: [],
  relieverSort: "status",     // default: due first, then by value
  relieverSortAsc: true,
};

/* ── Selection persistence (localStorage, scoped to week) ── */

const SELECTIONS_KEY = "startPlanner_v1";

function loadStoredSelections(weekStart) {
  try {
    const raw = localStorage.getItem(SELECTIONS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.weekStart !== weekStart) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveSelections() {
  const weekStart = state.data?.metadata?.week_start;
  if (!weekStart || !state.team) return;
  const stored = loadStoredSelections(weekStart) || { weekStart, byTeam: {}, streams: [], streamIncluded: [] };
  stored.byTeam[state.team] = [...state.checked];
  stored.streams = [...state.streamChecked];
  stored.streamIncluded = [...state.streamIncluded];
  try { localStorage.setItem(SELECTIONS_KEY, JSON.stringify(stored)); } catch {}
}

/* ── Streaming password gate (inline) ── */

function initStreamGate() {
  if (sessionStorage.getItem("starts_unlocked")) {
    unlockStreaming();
    return;
  }

  const input = document.getElementById("pw-input");
  const submit = () => {
    if (input.value === PASSWORD) {
      sessionStorage.setItem("starts_unlocked", "1");
      unlockStreaming();
    } else {
      document.getElementById("pw-error").textContent = "Incorrect password";
      input.value = "";
      input.focus();
    }
  };

  document.getElementById("pw-submit").addEventListener("click", submit);
  input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
}

function unlockStreaming() {
  document.getElementById("stream-lock").style.display = "none";
  document.getElementById("stream-content").style.display = "";
  initStreamTabs();
  renderStreamingTable();
  loadRelievers();
}

function initStreamTabs() {
  const toggle = document.getElementById("stream-tab-toggle");
  if (!toggle || toggle.dataset.init) return;
  toggle.dataset.init = "1";
  toggle.querySelectorAll(".stream-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      toggle.querySelectorAll(".stream-tab-btn").forEach(b =>
        b.classList.toggle("active", b === btn));
      document.getElementById("stream-pane-starters").style.display =
        tab === "starters" ? "" : "none";
      document.getElementById("stream-pane-relievers").style.display =
        tab === "relievers" ? "" : "none";
    });
  });
}

/* ── Helpers ── */

function startKey(name, date) {
  return `${name}|${date}`;
}

function opsClass(ops) {
  if (ops == null) return "ops-none";
  if (ops <= 0.680) return "ops-easy";
  if (ops <= 0.740) return "ops-ok";
  return "ops-tough";
}

function opsLabel(ops) {
  if (ops == null) return "—";
  return ops.toFixed(3);
}

function getStartOpsValue(start, teamOps) {
  if (state.opsMode === "split" && start.opponent_ops_split != null) {
    return start.opponent_ops_split;
  }
  return start.opponent_ops ?? teamOps[start.opponent];
}

function dayHeader(date) {
  const d = new Date(date + "T12:00:00");
  return `<span class="day-name">${d.toLocaleDateString("en-US", { weekday: "short" })}</span><br><span class="day-date">${d.toLocaleDateString("en-US", { month: "numeric", day: "numeric" })}</span>`;
}

/* ── Counter ── */

function updateCounter() {
  // Toolbar counter tracks the current (week 1) matchup — each week has its own cap.
  const week1 = getWeeks()[0];
  const total = week1 ? countSelectedInWeek(new Set(week1.dates || [])) : 0;
  const el = document.getElementById("start-counter");
  el.textContent = `${total} / ${START_LIMIT}`;
  el.className = "start-counter" + (total > START_LIMIT ? " over-limit" : total === START_LIMIT ? " at-limit" : "");
}

/* ── Get included streaming pitchers (full pitcher object, not just checked starts) ── */

function getIncludedStreamPitchers() {
  if (!state.data?.streaming_options) return [];
  const out = [];
  for (const p of state.data.streaming_options) {
    if (state.streamIncluded.has(p.name)) out.push(p);
  }
  return out;
}

/* ── Rostered starts table ── */

/* Weeks: prefer the new `weeks` array; fall back to legacy single-week shape. */
function getWeeks() {
  if (Array.isArray(state.data?.weeks) && state.data.weeks.length) {
    return state.data.weeks;
  }
  return [{
    label: "Week 1",
    week_start: state.data?.metadata?.week_start,
    week_end: state.data?.metadata?.week_end,
    dates: state.data?.dates || [],
    projected: false,
  }];
}

function fmtRange(startStr, endStr) {
  const opt = { month: "short", day: "numeric" };
  const a = new Date(startStr + "T12:00:00").toLocaleDateString("en-US", opt);
  const b = new Date(endStr + "T12:00:00").toLocaleDateString("en-US", opt);
  return `${a} – ${b}`;
}

// Count a team's selected starts whose date falls within the given week.
function countSelectedInWeek(dateSet) {
  const pitchers = state.data?.fantasy_teams?.[state.team] || [];
  let count = 0;
  for (const p of pitchers) {
    for (const s of p.starts) {
      if (dateSet.has(s.date) && state.checked.has(startKey(p.name, s.date))) count++;
    }
  }
  for (const p of getIncludedStreamPitchers()) {
    for (const s of p.starts) {
      if (dateSet.has(s.date) && state.streamChecked.has(startKey(p.name, s.date))) count++;
    }
  }
  return count;
}

function render() {
  if (!state.data || !state.team) return;

  saveSelections();

  const pitchers = state.data.fantasy_teams[state.team] || [];
  const streamPitchers = getIncludedStreamPitchers();
  const teamOps = state.data.team_ops_30d;
  const weeks = getWeeks();

  const container = document.getElementById("starts-weeks");
  // Snapshot each week's current open/closed state before wiping, so an
  // in-progress expand/collapse survives this rebuild (render runs on every click).
  container.querySelectorAll(".week-block").forEach(b => {
    if (b.dataset.weekKey) state.weekOpen[b.dataset.weekKey] = b.open;
  });
  container.innerHTML = "";

  weeks.forEach((week, wi) => {
    const dates = week.dates || [];
    const dateSet = new Set(dates);
    // Streaming picks are week-1 only (their 2-week-out turns aren't meaningful).
    const streamForWeek = wi === 0 ? streamPitchers : [];

    const block = document.createElement("details");
    block.className = "week-block" + (week.projected ? " week-projected" : "");
    // Persist expand/collapse across re-renders (a re-render happens on every
    // start-cell click); default to current week open, later weeks collapsed.
    const openKey = week.week_start || String(wi);
    if (!(openKey in state.weekOpen)) state.weekOpen[openKey] = wi === 0;
    block.dataset.weekKey = openKey;
    block.open = state.weekOpen[openKey];
    block.addEventListener("toggle", () => { state.weekOpen[openKey] = block.open; });

    const summary = document.createElement("summary");
    summary.className = "week-summary";
    const selCount = countSelectedInWeek(dateSet);
    const overCls = selCount > START_LIMIT ? " over-limit" : selCount === START_LIMIT ? " at-limit" : "";
    summary.innerHTML =
      `<span class="week-title">${week.label || "Week " + (wi + 1)}</span>` +
      `<span class="week-range">${fmtRange(week.week_start, week.week_end)}</span>` +
      (week.projected ? `<span class="week-proj-badge">projected</span>` : "") +
      `<span class="week-count${overCls}">${selCount} / ${START_LIMIT}</span>`;
    block.appendChild(summary);

    if (week.projected) {
      const note = document.createElement("p");
      note.className = "week-proj-note";
      note.innerHTML = `Estimated matchups. <span class="proj-dot">~</span> = rotation projection (dates roll each SP's turn onto their team's real schedule); solid cells are ESPN probables. Firms up as the week nears.`;
      block.appendChild(note);
    }

    const wrap = document.createElement("div");
    wrap.className = "wide-table-wrapper";
    const table = document.createElement("table");
    table.className = "starts-table";
    const thead = document.createElement("thead");
    const tbody = document.createElement("tbody");

    const tr = document.createElement("tr");
    const cbTh = document.createElement("th");
    cbTh.className = "starts-check-col";
    tr.appendChild(cbTh);
    const nameTh = document.createElement("th");
    nameTh.textContent = "Pitcher";
    nameTh.className = "starts-name-col";
    tr.appendChild(nameTh);
    for (const date of dates) {
      const th = document.createElement("th");
      th.innerHTML = dayHeader(date);
      tr.appendChild(th);
    }
    thead.appendChild(tr);

    // Only pitchers with at least one start in this week, sorted by that count.
    const withStarts = pitchers
      .map(p => ({ p, n: p.starts.filter(s => dateSet.has(s.date)).length }))
      .filter(x => x.n > 0)
      .sort((a, b) => b.n - a.n || a.p.name.localeCompare(b.p.name));

    if (withStarts.length === 0 && streamForWeek.length === 0) {
      const row = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = dates.length + 2;
      td.textContent = week.projected
        ? "No projected starts for this team next week."
        : "No probable starts found for this team this week.";
      td.style.cssText = "text-align:center;color:#64748b;padding:2rem";
      row.appendChild(td);
      tbody.appendChild(row);
    } else {
      for (const { p } of withStarts) {
        tbody.appendChild(buildRosteredRow(p, dates, teamOps));
      }
      for (const pitcher of streamForWeek) {
        tbody.appendChild(buildStreamSelectedRow(pitcher, dates, teamOps));
      }
    }

    table.appendChild(thead);
    table.appendChild(tbody);
    wrap.appendChild(table);
    block.appendChild(wrap);
    container.appendChild(block);
  });

  updateCounter();
}

function buildStartCell(start, isOn, teamOps, onClick) {
  const td = document.createElement("td");
  const ops = getStartOpsValue(start, teamOps);
  td.className = "start-cell " + opsClass(ops);
  if (isOn) td.classList.add("start-on");
  else td.classList.add("start-off");
  if (start.points != null) td.classList.add("start-played");
  if (start.projected) {
    td.classList.add("start-projected");
    td.title = "Projected start (rotation estimate — not yet confirmed by ESPN)";
  }

  const projHtml = start.projected ? `<span class="proj-dot" aria-label="projected">~</span>` : "";
  const oppHtml = `<span class="opp-name">${start.home ? "" : "@"}${start.opponent}</span>`;
  const opsHtml = `<span class="opp-ops">${opsLabel(ops)}</span>`;
  const ptsHtml = start.points != null
    ? `<span class="start-points">${start.points.toFixed(1)}</span>`
    : "";
  td.innerHTML = projHtml + oppHtml + opsHtml + ptsHtml;

  if (onClick) {
    td.style.cursor = "pointer";
    td.addEventListener("click", onClick);
  }
  return td;
}

function buildRosteredRow(pitcher, dates, teamOps) {
  const dateSet = new Set(dates);
  const weekStarts = pitcher.starts.filter(s => dateSet.has(s.date));
  const startsByDate = {};
  for (const s of weekStarts) startsByDate[s.date] = s;

  const row = document.createElement("tr");

  const allKeys = weekStarts.map(s => startKey(pitcher.name, s.date));
  const checkedCount = allKeys.filter(k => state.checked.has(k)).length;
  const allChecked = checkedCount === weekStarts.length;
  const noneChecked = checkedCount === 0;

  if (noneChecked && weekStarts.length > 0) row.classList.add("pitcher-off");

  const cbTd = document.createElement("td");
  cbTd.className = "starts-check-col";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = allChecked;
  cb.indeterminate = !allChecked && !noneChecked;
  cb.addEventListener("change", () => {
    for (const key of allKeys) {
      if (cb.checked) state.checked.add(key);
      else state.checked.delete(key);
    }
    render();
  });
  cbTd.appendChild(cb);
  row.appendChild(cbTd);

  const nameTd = document.createElement("td");
  nameTd.className = "starts-name-col";
  nameTd.innerHTML = `<span class="pitcher-name">${pitcher.name}</span><span class="pitcher-team">${pitcher.mlb_team}</span>`;
  row.appendChild(nameTd);

  for (const date of dates) {
    const start = startsByDate[date];
    if (!start) {
      row.appendChild(document.createElement("td"));
      continue;
    }
    const key = startKey(pitcher.name, date);
    const isOn = state.checked.has(key);
    const td = buildStartCell(start, isOn, teamOps, () => {
      if (state.checked.has(key)) state.checked.delete(key);
      else state.checked.add(key);
      render();
    });
    row.appendChild(td);
  }

  return row;
}

function buildStreamSelectedRow(pitcher, dates, teamOps) {
  const dateSet = new Set(dates);
  const weekStarts = pitcher.starts.filter(s => dateSet.has(s.date));
  const startsByDate = {};
  for (const s of weekStarts) startsByDate[s.date] = s;

  const row = document.createElement("tr");
  row.classList.add("stream-selected-row");

  const allKeys = weekStarts.map(s => startKey(pitcher.name, s.date));
  const checkedCount = allKeys.filter(k => state.streamChecked.has(k)).length;
  const noneChecked = checkedCount === 0;
  if (noneChecked && weekStarts.length > 0) row.classList.add("pitcher-off");

  const cbTd = document.createElement("td");
  cbTd.className = "starts-check-col";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = true; // included
  cb.title = "Remove from planner";
  cb.addEventListener("change", () => {
    state.streamIncluded.delete(pitcher.name);
    for (const key of allKeys) state.streamChecked.delete(key);
    render();
    renderStreamingTable();
  });
  cbTd.appendChild(cb);
  row.appendChild(cbTd);

  const nameTd = document.createElement("td");
  nameTd.className = "starts-name-col";
  nameTd.innerHTML = `<span class="pitcher-name">${pitcher.name}</span><span class="pitcher-team stream-tag">${pitcher.mlb_team} · FA</span>`;
  row.appendChild(nameTd);

  for (const date of dates) {
    const start = startsByDate[date];
    if (!start) {
      row.appendChild(document.createElement("td"));
      continue;
    }
    const key = startKey(pitcher.name, date);
    const isOn = state.streamChecked.has(key);
    const td = buildStartCell(start, isOn, teamOps, () => {
      if (state.streamChecked.has(key)) state.streamChecked.delete(key);
      else state.streamChecked.add(key);
      render();
      renderStreamingTable();
    });
    row.appendChild(td);
  }

  return row;
}

/* ── Team select ── */

function initTeamSelect(data) {
  const sel = document.getElementById("team-select");
  const teams = Object.keys(data.fantasy_teams).sort();
  for (const team of teams) {
    sel.appendChild(new Option(team, team));
  }
  state.team = teams[0];
  sel.value = state.team;
  resetChecked();
  sel.addEventListener("change", () => {
    state.team = sel.value;
    resetChecked();
    render();
  });
}

function resetChecked() {
  state.checked.clear();
  const weekStart = state.data?.metadata?.week_start;
  const stored = weekStart ? loadStoredSelections(weekStart) : null;
  const savedKeys = stored?.byTeam?.[state.team];
  if (savedKeys) {
    for (const k of savedKeys) state.checked.add(k);
    return;
  }
  const pitchers = state.data?.fantasy_teams?.[state.team] || [];
  for (const p of pitchers) {
    for (const s of p.starts) {
      state.checked.add(startKey(p.name, s.date));
    }
  }
}

/* ── GS Summary ── */

function renderGsSummary(data) {
  const container = document.getElementById("gs-summary");
  const teams = Object.keys(data.fantasy_teams).sort();
  const actualGs = data.actual_gs || {};
  const limit = data.metadata?.start_limit || START_LIMIT;

  const wk1Dates = new Set((getWeeks()[0]?.dates) || data.dates || []);
  const counts = teams.map(t => ({
    team: t,
    actual: actualGs[t] || 0,
    probable: data.fantasy_teams[t].reduce(
      (sum, p) => sum + p.starts.filter(s => wk1Dates.has(s.date)).length, 0),
  }));

  counts.sort((a, b) => b.actual - a.actual || b.probable - a.probable);

  let html = '<table class="gs-table"><thead><tr>';
  for (const c of counts) html += `<th>${c.team}</th>`;
  html += '</tr></thead><tbody><tr>';
  for (const c of counts) {
    const cls = c.actual >= limit ? ' class="gs-at-limit"' : c.actual > limit * 0.75 ? ' class="gs-near-limit"' : '';
    html += `<td${cls}>${c.actual}/${limit}</td>`;
  }
  html += '</tr></tbody></table>';

  container.innerHTML = html;
}

/* ── Streaming Options ── */

function streamToday() {
  return state.data?.metadata?.today || new Date().toLocaleDateString("en-CA");
}

function isGreenOps(ops) {
  return ops != null && opsClass(ops) === "ops-easy";
}

// Best (lowest) opponent OPS among a pitcher's upcoming starts that are actually
// shown in this table (visible week-1 columns, today or later).
function bestUpcomingOps(pitcher, teamOps, today, dateSet) {
  let best = null;
  for (const s of pitcher.starts) {
    if (!dateSet.has(s.date) || s.date < today) continue;
    const ops = getStartOpsValue(s, teamOps);
    if (ops == null) continue;
    if (best == null || ops < best) best = ops;
  }
  return best;
}

function hasUpcomingGreen(pitcher, teamOps, today, dateSet) {
  return pitcher.starts.some(
    s => dateSet.has(s.date) && s.date >= today && isGreenOps(getStartOpsValue(s, teamOps))
  );
}

function renderStreamingTable() {
  const data = state.data;
  if (!data) return;
  const options = data.streaming_options || [];
  const dates = data.dates;
  const teamOps = data.team_ops_30d;
  const today = streamToday();
  const dateSet = new Set(dates);  // only week-1 columns are shown in this table

  // Filter: only pitchers with a favorable (green) upcoming matchup.
  let list = options;
  if (state.streamGreenOnly) {
    list = list.filter(p => hasUpcomingGreen(p, teamOps, today, dateSet));
  }

  const sorted = [...list].sort((a, b) => {
    const key = state.streamSort;
    if (key === "bestOps") {
      const oa = bestUpcomingOps(a, teamOps, today, dateSet);
      const ob = bestUpcomingOps(b, teamOps, today, dateSet);
      if (oa == null && ob == null) return 0;
      if (oa == null) return 1;
      if (ob == null) return -1;
      return state.streamSortAsc ? oa - ob : ob - oa;  // asc = greenest first
    }
    if (key.startsWith("day:")) {
      const date = key.slice(4);
      const opsA = getStartOpsForSort(a, date, teamOps);
      const opsB = getStartOpsForSort(b, date, teamOps);
      if (opsA == null && opsB == null) return 0;
      if (opsA == null) return 1;
      if (opsB == null) return -1;
      return state.streamSortAsc ? opsA - opsB : opsB - opsA;
    }
    const va = a[key] ?? -Infinity;
    const vb = b[key] ?? -Infinity;
    return state.streamSortAsc ? va - vb : vb - va;
  });

  const headEl = document.getElementById("streaming-head");
  headEl.innerHTML = "";
  const tr = document.createElement("tr");

  const cbTh = document.createElement("th");
  cbTh.className = "stream-check-col";
  tr.appendChild(cbTh);

  const nameTh = document.createElement("th");
  nameTh.textContent = "Pitcher";
  nameTh.className = "stream-name-col";
  tr.appendChild(nameTh);

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
    const isPast = date < today;

    if (state.streamCollapsedDays.has(date)) {
      // Collapsed past-day: thin strip, click to expand.
      const th = document.createElement("th");
      th.className = "day-collapsed";
      const dObj = new Date(date + "T12:00:00");
      th.title = `${dObj.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" })} — click to expand`;
      th.innerHTML = `<span class="collapsed-label">${dObj.toLocaleDateString("en-US", { month: "numeric", day: "numeric" })}</span>`;
      th.addEventListener("click", () => {
        state.streamCollapsedDays.delete(date);
        renderStreamingTable();
      });
      tr.appendChild(th);
      continue;
    }

    const th = document.createElement("th");
    const sortKey = "day:" + date;
    const active = state.streamSort === sortKey;
    th.className = "sortable-col" + (active ? " sort-active" : "") + (isPast ? " past-day" : "");
    const collapseHandle = isPast
      ? `<span class="col-collapse" title="Hide this past day">×</span>`
      : "";
    th.innerHTML = collapseHandle + dayHeader(date) + (active ? `<br><span class="sort-arrow">${state.streamSortAsc ? "▲" : "▼"}</span>` : "");
    th.style.cursor = "pointer";
    th.addEventListener("click", (e) => {
      if (e.target.classList.contains("col-collapse")) {
        state.streamCollapsedDays.add(date);
        renderStreamingTable();
        return;
      }
      if (state.streamSort === sortKey) state.streamSortAsc = !state.streamSortAsc;
      else { state.streamSort = sortKey; state.streamSortAsc = true; }
      renderStreamingTable();
    });
    tr.appendChild(th);
  }

  headEl.appendChild(tr);

  const bodyEl = document.getElementById("streaming-body");
  bodyEl.innerHTML = "";

  if (sorted.length === 0) {
    const row = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = dates.length + 5;
    td.textContent = state.streamGreenOnly
      ? "No free agents with a green upcoming matchup. Turn off the green filter to see all."
      : "No streaming options found this week.";
    td.style.cssText = "text-align:center;color:#64748b;padding:2rem";
    row.appendChild(td);
    bodyEl.appendChild(row);
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
      render();
      renderStreamingTable();
    }

    const cbTd = document.createElement("td");
    cbTd.className = "stream-check-col";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = included;
    cb.title = "Include in planner";
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
      if (state.streamCollapsedDays.has(date)) {
        const td = document.createElement("td");
        td.className = "day-collapsed";
        row.appendChild(td);
        continue;
      }
      const start = startsByDate[date];
      if (!start) {
        row.appendChild(document.createElement("td"));
        continue;
      }
      const key = startKey(pitcher.name, date);
      const isOn = state.streamChecked.has(key);
      const td = buildStartCell(start, isOn, teamOps, () => {
        if (state.streamChecked.has(key)) state.streamChecked.delete(key);
        else state.streamChecked.add(key);
        render();
        renderStreamingTable();
      });
      row.appendChild(td);
    }

    bodyEl.appendChild(row);
  }

  syncStreamFilterUI();
}

// Which week-1 day columns are in the past (already played).
function streamPastDates() {
  const today = streamToday();
  return (state.data?.dates || []).filter(d => d < today);
}

function syncStreamFilterUI() {
  const green = document.getElementById("stream-green-toggle");
  if (green) green.classList.toggle("active", state.streamGreenOnly);

  const best = document.getElementById("stream-best-toggle");
  if (best) best.classList.toggle("active", state.streamSort === "bestOps");

  const hide = document.getElementById("stream-hidepast-toggle");
  if (hide) {
    const past = streamPastDates();
    const allHidden = past.length > 0 && past.every(d => state.streamCollapsedDays.has(d));
    hide.classList.toggle("active", allHidden);
    hide.textContent = allHidden ? "Show past days" : "Hide past days";
    hide.disabled = past.length === 0;
  }
}

function initStreamFilters() {
  const green = document.getElementById("stream-green-toggle");
  if (green) green.addEventListener("click", () => {
    state.streamGreenOnly = !state.streamGreenOnly;
    renderStreamingTable();
  });

  const best = document.getElementById("stream-best-toggle");
  if (best) best.addEventListener("click", () => {
    if (state.streamSort === "bestOps") {
      state.streamSortAsc = !state.streamSortAsc;
    } else {
      state.streamSort = "bestOps";
      state.streamSortAsc = true;  // greenest (lowest OPS) first
    }
    renderStreamingTable();
  });

  const hide = document.getElementById("stream-hidepast-toggle");
  if (hide) hide.addEventListener("click", () => {
    const past = streamPastDates();
    const allHidden = past.length > 0 && past.every(d => state.streamCollapsedDays.has(d));
    if (allHidden) {
      for (const d of past) state.streamCollapsedDays.delete(d);
    } else {
      for (const d of past) state.streamCollapsedDays.add(d);
    }
    renderStreamingTable();
  });
}

function getStartOpsForSort(pitcher, date, teamOps) {
  const start = pitcher.starts.find(s => s.date === date);
  if (!start) return null;
  return getStartOpsValue(start, teamOps) ?? null;
}

/* ── Bulk Relievers ── */

function loadRelievers() {
  fetch("data/relievers_data.json")
    .then(r => r.json())
    .then(data => {
      state.relievers = data.relievers || [];
      renderRelieverTable();
    })
    .catch(() => {
      const body = document.getElementById("reliever-body");
      if (body) body.innerHTML =
        '<tr><td colspan="4" style="text-align:center;color:#f87171;padding:1.5rem">Could not load reliever data.</td></tr>';
    });
}

const RELIEVER_COLS = [
  { key: "name", label: "Pitcher", cls: "rel-name-col", defaultAsc: true },
  { key: "status", label: "Status", cls: "rel-status-col", defaultAsc: true },
  { key: "days_since", label: "Last App", cls: "rel-num-col", defaultAsc: false },
  { key: "pts_per_ip", label: "Pts/IP", cls: "rel-num-col", defaultAsc: false },
];

function compareRelievers(a, b) {
  const key = state.relieverSort;
  let cmp;
  if (key === "name") {
    cmp = a.name.localeCompare(b.name);
  } else if (key === "status") {
    const order = { due: 0, rested: 1 };
    cmp = (order[a.status] ?? 9) - (order[b.status] ?? 9);
    if (cmp === 0) cmp = b.pts_per_ip - a.pts_per_ip;  // tiebreak: value desc
  } else {
    cmp = (a[key] ?? -Infinity) - (b[key] ?? -Infinity);
  }
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
    body.innerHTML =
      '<tr><td colspan="4" style="text-align:center;color:#64748b;padding:1.5rem">No bulk relievers found.</td></tr>';
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
    `Free-agent RPs who often work 1.1–3.0 innings and rarely exceed 3.0 (which would count as a start).`;
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
      const legendStandard = document.getElementById("ops-legend-standard");
      const legendSplit = document.getElementById("ops-legend-split");
      if (legendStandard && legendSplit) {
        legendStandard.style.display = mode === "30d" ? "" : "none";
        legendSplit.style.display = mode === "split" ? "" : "none";
      }
      render();
      renderStreamingTable();
    });
  });
}

/* ── Data loading ── */

function loadData() {
  fetch("data/starts_data.json")
    .then(r => r.json())
    .then(data => {
      state.data = data;

      const stored = loadStoredSelections(data.metadata?.week_start);
      if (stored?.streams) {
        for (const k of stored.streams) state.streamChecked.add(k);
      }
      if (stored?.streamIncluded) {
        for (const n of stored.streamIncluded) state.streamIncluded.add(n);
      } else if (stored?.streams) {
        // Migrate: any stream-checked pitcher implicitly included
        for (const k of stored.streams) state.streamIncluded.add(k.split("|")[0]);
      }

      const lu = document.getElementById("last-updated");
      if (data.metadata?.last_updated) {
        const d = new Date(data.metadata.last_updated);
        const weekEnd = new Date(data.metadata.week_end + "T12:00:00");
        lu.textContent = `Week of ${new Date(data.metadata.week_start + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}–${weekEnd.toLocaleDateString("en-US", { month: "short", day: "numeric" })} · Last updated: ${d.toLocaleString()}`;
      }

      renderGsSummary(data);
      initTeamSelect(data);
      initOpsToggle();
      initStreamFilters();
      render();
      initStreamGate();
    })
    .catch(() => {
      document.getElementById("starts-body").innerHTML =
        '<tr><td colspan="99" style="text-align:center;color:#f87171;padding:2rem">Could not load starts data.</td></tr>';
    });
}

/* ── Init ── */
loadData();
