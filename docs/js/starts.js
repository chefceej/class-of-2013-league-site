const START_LIMIT = 8;
const PASSWORD = "hookem";

let state = {
  data: null,
  team: null,
  checked: new Set(),       // rostered start keys: "PitcherName|date"
  streamChecked: new Set(), // streaming start keys: "PitcherName|date"
  streamSort: "pts_per_gs",
  streamSortAsc: false,
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
  const stored = loadStoredSelections(weekStart) || { weekStart, byTeam: {}, streams: [] };
  stored.byTeam[state.team] = [...state.checked];
  stored.streams = [...state.streamChecked];
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
  renderStreamingTable();
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

function dayHeader(date) {
  const d = new Date(date + "T12:00:00");
  return `<span class="day-name">${d.toLocaleDateString("en-US", { weekday: "short" })}</span><br><span class="day-date">${d.toLocaleDateString("en-US", { month: "numeric", day: "numeric" })}</span>`;
}

/* ── Counter ── */

function updateCounter() {
  const total = countSelectedStarts();
  const el = document.getElementById("start-counter");
  el.textContent = `${total} / ${START_LIMIT}`;
  el.className = "start-counter" + (total > START_LIMIT ? " over-limit" : total === START_LIMIT ? " at-limit" : "");
}

function countSelectedStarts() {
  const pitchers = (state.data?.fantasy_teams?.[state.team] || []);
  let count = 0;
  for (const p of pitchers) {
    for (const s of p.starts) {
      if (state.checked.has(startKey(p.name, s.date))) count++;
    }
  }
  // Count selected streaming starts
  count += state.streamChecked.size;
  return count;
}

/* ── Get selected streaming pitchers ── */

function getSelectedStreamPitchers() {
  if (!state.data?.streaming_options) return [];
  const selected = [];
  for (const p of state.data.streaming_options) {
    const checkedStarts = p.starts.filter(s => state.streamChecked.has(startKey(p.name, s.date)));
    if (checkedStarts.length > 0) {
      selected.push({ ...p, starts: checkedStarts });
    }
  }
  return selected;
}

/* ── Rostered starts table ── */

function render() {
  if (!state.data || !state.team) return;

  saveSelections();

  const pitchers = state.data.fantasy_teams[state.team] || [];
  const streamPitchers = getSelectedStreamPitchers();
  const dates = state.data.dates;
  const teamOps = state.data.team_ops_30d;

  const headEl = document.getElementById("starts-head");
  headEl.innerHTML = "";
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

  const totalTh = document.createElement("th");
  totalTh.textContent = "Starts";
  totalTh.className = "total-col";
  tr.appendChild(totalTh);

  headEl.appendChild(tr);

  const bodyEl = document.getElementById("starts-body");
  bodyEl.innerHTML = "";

  if (pitchers.length === 0 && streamPitchers.length === 0) {
    const row = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = dates.length + 3;
    td.textContent = "No probable starts found for this team this week.";
    td.style.cssText = "text-align:center;color:#64748b;padding:2rem";
    row.appendChild(td);
    bodyEl.appendChild(row);
    updateCounter();
    return;
  }

  const sorted = [...pitchers].sort((a, b) =>
    b.starts.length - a.starts.length || a.name.localeCompare(b.name)
  );

  // Render rostered pitchers
  for (const pitcher of sorted) {
    bodyEl.appendChild(buildRosteredRow(pitcher, dates, teamOps));
  }

  // Render selected streaming pitchers (visually distinct)
  for (const pitcher of streamPitchers) {
    bodyEl.appendChild(buildStreamSelectedRow(pitcher, dates, teamOps));
  }

  updateCounter();
}

function buildRosteredRow(pitcher, dates, teamOps) {
  const startsByDate = {};
  for (const s of pitcher.starts) startsByDate[s.date] = s;

  const row = document.createElement("tr");

  const allKeys = pitcher.starts.map(s => startKey(pitcher.name, s.date));
  const checkedCount = allKeys.filter(k => state.checked.has(k)).length;
  const allChecked = checkedCount === pitcher.starts.length;
  const noneChecked = checkedCount === 0;

  if (noneChecked && pitcher.starts.length > 0) row.classList.add("pitcher-off");

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
    const td = document.createElement("td");
    const start = startsByDate[date];
    if (start) {
      const key = startKey(pitcher.name, date);
      const isOn = state.checked.has(key);
      const ops = start.opponent_ops ?? teamOps[start.opponent];
      td.className = "start-cell " + opsClass(ops);
      if (isOn) td.classList.add("start-on");
      else td.classList.add("start-off");
      td.innerHTML = `<span class="opp-name">${start.home ? "" : "@"}${start.opponent}</span><span class="opp-ops">${opsLabel(ops)}</span>`;
      td.style.cursor = "pointer";
      td.addEventListener("click", () => {
        if (state.checked.has(key)) state.checked.delete(key);
        else state.checked.add(key);
        render();
      });
    }
    row.appendChild(td);
  }

  const totalTd = document.createElement("td");
  totalTd.textContent = checkedCount;
  totalTd.className = "total-col";
  row.appendChild(totalTd);

  return row;
}

function buildStreamSelectedRow(pitcher, dates, teamOps) {
  const startsByDate = {};
  for (const s of pitcher.starts) startsByDate[s.date] = s;

  const row = document.createElement("tr");
  row.classList.add("stream-selected-row");

  // Checkbox to deselect
  const cbTd = document.createElement("td");
  cbTd.className = "starts-check-col";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = true;
  cb.addEventListener("change", () => {
    for (const s of pitcher.starts) {
      state.streamChecked.delete(startKey(pitcher.name, s.date));
    }
    render();
    renderStreamingTable();
  });
  cbTd.appendChild(cb);
  row.appendChild(cbTd);

  const nameTd = document.createElement("td");
  nameTd.className = "starts-name-col";
  nameTd.innerHTML = `<span class="pitcher-name">${pitcher.name}</span><span class="pitcher-team stream-tag">${pitcher.mlb_team} · FA</span>`;
  row.appendChild(nameTd);

  let checkedCount = 0;
  for (const date of dates) {
    const td = document.createElement("td");
    const start = startsByDate[date];
    if (start) {
      const ops = start.opponent_ops ?? teamOps[start.opponent];
      td.className = "start-cell start-on " + opsClass(ops);
      td.innerHTML = `<span class="opp-name">${start.home ? "" : "@"}${start.opponent}</span><span class="opp-ops">${opsLabel(ops)}</span>`;
      checkedCount++;
    }
    row.appendChild(td);
  }

  const totalTd = document.createElement("td");
  totalTd.textContent = checkedCount;
  totalTd.className = "total-col";
  row.appendChild(totalTd);

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

  const counts = teams.map(t => ({
    team: t,
    actual: actualGs[t] || 0,
    probable: data.fantasy_teams[t].reduce((sum, p) => sum + p.starts.length, 0),
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

function renderStreamingTable() {
  const data = state.data;
  if (!data) return;
  const options = data.streaming_options || [];
  const dates = data.dates;
  const teamOps = data.team_ops_30d;

  // Sort
  const sorted = [...options].sort((a, b) => {
    const key = state.streamSort;
    if (key.startsWith("day:")) {
      const date = key.slice(4);
      const opsA = getStartOps(a, date, teamOps);
      const opsB = getStartOps(b, date, teamOps);
      if (opsA == null && opsB == null) return 0;
      if (opsA == null) return 1;
      if (opsB == null) return -1;
      return state.streamSortAsc ? opsA - opsB : opsB - opsA;
    }
    const va = a[key] ?? -Infinity;
    const vb = b[key] ?? -Infinity;
    return state.streamSortAsc ? va - vb : vb - va;
  });

  // Header
  const headEl = document.getElementById("streaming-head");
  headEl.innerHTML = "";
  const tr = document.createElement("tr");

  // Empty th for checkbox column
  const cbTh = document.createElement("th");
  cbTh.className = "stream-check-col";
  tr.appendChild(cbTh);

  const nameTh = document.createElement("th");
  nameTh.textContent = "Pitcher";
  nameTh.className = "stream-name-col";
  tr.appendChild(nameTh);

  for (const col of [
    { key: "pts_per_gs", label: "Pts/GS" },
    { key: "season_pts", label: "Season" },
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
    const th = document.createElement("th");
    const sortKey = "day:" + date;
    const active = state.streamSort === sortKey;
    th.className = "sortable-col" + (active ? " sort-active" : "");
    th.innerHTML = dayHeader(date) + (active ? `<br><span class="sort-arrow">${state.streamSortAsc ? "▲" : "▼"}</span>` : "");
    th.style.cursor = "pointer";
    th.addEventListener("click", () => {
      if (state.streamSort === sortKey) state.streamSortAsc = !state.streamSortAsc;
      else { state.streamSort = sortKey; state.streamSortAsc = true; }
      renderStreamingTable();
    });
    tr.appendChild(th);
  }

  headEl.appendChild(tr);

  // Body
  const bodyEl = document.getElementById("streaming-body");
  bodyEl.innerHTML = "";

  if (sorted.length === 0) {
    const row = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = dates.length + 5;
    td.textContent = "No streaming options found this week.";
    td.style.cssText = "text-align:center;color:#64748b;padding:2rem";
    row.appendChild(td);
    bodyEl.appendChild(row);
    return;
  }

  for (const pitcher of sorted) {
    const startsByDate = {};
    for (const s of pitcher.starts) startsByDate[s.date] = s;

    const row = document.createElement("tr");

    // Has any start selected?
    const anyChecked = pitcher.starts.some(s => state.streamChecked.has(startKey(pitcher.name, s.date)));

    // Checkbox
    const cbTd = document.createElement("td");
    cbTd.className = "stream-check-col";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = anyChecked;
    cb.addEventListener("change", () => {
      for (const s of pitcher.starts) {
        const key = startKey(pitcher.name, s.date);
        if (cb.checked) state.streamChecked.add(key);
        else state.streamChecked.delete(key);
      }
      render();
      renderStreamingTable();
    });
    cbTd.appendChild(cb);
    row.appendChild(cbTd);

    const nameTd = document.createElement("td");
    nameTd.className = "stream-name-col";
    nameTd.innerHTML = `<span class="pitcher-name">${pitcher.name}</span><span class="pitcher-team">${pitcher.mlb_team}</span>`;
    row.appendChild(nameTd);

    for (const key of ["pts_per_gs", "season_pts", "pr30_pts"]) {
      const td = document.createElement("td");
      td.className = "stream-stat-col";
      const val = pitcher[key];
      td.textContent = val != null ? val.toFixed(1) : "—";
      row.appendChild(td);
    }

    for (const date of dates) {
      const td = document.createElement("td");
      const start = startsByDate[date];
      if (start) {
        const ops = start.opponent_ops ?? teamOps[start.opponent];
        td.className = "start-cell " + opsClass(ops);
        if (state.streamChecked.has(startKey(pitcher.name, date))) td.classList.add("start-on");
        td.innerHTML = `<span class="opp-name">${start.home ? "" : "@"}${start.opponent}</span><span class="opp-ops">${opsLabel(ops)}</span>`;
        td.style.cursor = "pointer";
        td.addEventListener("click", () => {
          const key = startKey(pitcher.name, date);
          if (state.streamChecked.has(key)) state.streamChecked.delete(key);
          else state.streamChecked.add(key);
          render();
          renderStreamingTable();
        });
      }
      row.appendChild(td);
    }

    bodyEl.appendChild(row);
  }
}

function getStartOps(pitcher, date, teamOps) {
  const start = pitcher.starts.find(s => s.date === date);
  if (!start) return null;
  return start.opponent_ops ?? teamOps[start.opponent] ?? null;
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

      const lu = document.getElementById("last-updated");
      if (data.metadata?.last_updated) {
        const d = new Date(data.metadata.last_updated);
        const weekEnd = new Date(data.metadata.week_end + "T12:00:00");
        lu.textContent = `Week of ${new Date(data.metadata.week_start + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}–${weekEnd.toLocaleDateString("en-US", { month: "short", day: "numeric" })} · Last updated: ${d.toLocaleString()}`;
      }

      renderGsSummary(data);
      initTeamSelect(data);
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
