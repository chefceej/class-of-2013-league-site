const START_LIMIT = 8;

let state = {
  data: null,
  team: null,
  checked: new Set(), // start keys: "PitcherName|date"
};

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
  return count;
}

function render() {
  if (!state.data || !state.team) return;

  const pitchers = state.data.fantasy_teams[state.team] || [];
  const dates = state.data.dates;
  const teamOps = state.data.team_ops_30d;

  // ── Header ──
  const headEl = document.getElementById("starts-head");
  headEl.innerHTML = "";
  const tr = document.createElement("tr");

  // Checkbox + name columns
  const cbTh = document.createElement("th");
  cbTh.className = "sticky-col starts-check-col";
  tr.appendChild(cbTh);

  const nameTh = document.createElement("th");
  nameTh.textContent = "Pitcher";
  nameTh.className = "sticky-col2 starts-name-col";
  tr.appendChild(nameTh);

  // Day columns
  for (const date of dates) {
    const th = document.createElement("th");
    const d = new Date(date + "T12:00:00");
    th.innerHTML = `<span class="day-name">${d.toLocaleDateString("en-US", { weekday: "short" })}</span><br><span class="day-date">${d.toLocaleDateString("en-US", { month: "numeric", day: "numeric" })}</span>`;
    tr.appendChild(th);
  }

  // Starts total column
  const totalTh = document.createElement("th");
  totalTh.textContent = "Starts";
  totalTh.className = "total-col";
  tr.appendChild(totalTh);

  headEl.appendChild(tr);

  // ── Body ──
  const bodyEl = document.getElementById("starts-body");
  bodyEl.innerHTML = "";

  if (pitchers.length === 0) {
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

  // Sort: most starts first, then alpha
  const sorted = [...pitchers].sort((a, b) =>
    b.starts.length - a.starts.length || a.name.localeCompare(b.name)
  );

  // Build date → start info lookup per pitcher
  for (const pitcher of sorted) {
    const startsByDate = {};
    for (const s of pitcher.starts) startsByDate[s.date] = s;

    const row = document.createElement("tr");

    // How many of this pitcher's starts are checked?
    const allKeys = pitcher.starts.map(s => startKey(pitcher.name, s.date));
    const checkedCount = allKeys.filter(k => state.checked.has(k)).length;
    const allChecked = checkedCount === pitcher.starts.length;
    const noneChecked = checkedCount === 0;

    if (noneChecked && pitcher.starts.length > 0) row.classList.add("pitcher-off");

    // Checkbox (toggles all starts for this pitcher)
    const cbTd = document.createElement("td");
    cbTd.className = "sticky-col starts-check-col";
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

    // Name
    const nameTd = document.createElement("td");
    nameTd.className = "sticky-col2 starts-name-col";
    nameTd.innerHTML = `<span class="pitcher-name">${pitcher.name}</span><span class="pitcher-team">${pitcher.mlb_team}</span>`;
    row.appendChild(nameTd);

    // Day cells
    for (const date of dates) {
      const td = document.createElement("td");
      const start = startsByDate[date];
      if (start) {
        const key = startKey(pitcher.name, date);
        const isOn = state.checked.has(key);
        const ops = start.opponent_ops ?? teamOps[start.opponent];
        td.className = "start-cell " + opsClass(ops);
        if (!isOn) td.classList.add("start-off");
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

    // Starts total (selected count)
    const totalTd = document.createElement("td");
    totalTd.textContent = checkedCount;
    totalTd.className = "total-col";
    row.appendChild(totalTd);

    bodyEl.appendChild(row);
  }

  updateCounter();
}

function initTeamSelect(data) {
  const sel = document.getElementById("team-select");
  const teams = Object.keys(data.fantasy_teams).sort();
  for (const team of teams) {
    sel.appendChild(new Option(team, team));
  }
  state.team = teams[0];
  sel.value = state.team;

  // Default: check all starts for initial team
  resetChecked();

  sel.addEventListener("change", () => {
    state.team = sel.value;
    resetChecked();
    render();
  });
}

function resetChecked() {
  state.checked.clear();
  const pitchers = state.data?.fantasy_teams?.[state.team] || [];
  for (const p of pitchers) {
    for (const s of p.starts) {
      state.checked.add(startKey(p.name, s.date));
    }
  }
}

fetch("data/starts_data.json")
  .then(r => r.json())
  .then(data => {
    state.data = data;

    const lu = document.getElementById("last-updated");
    if (data.metadata?.last_updated) {
      const d = new Date(data.metadata.last_updated);
      const weekEnd = new Date(data.metadata.week_end + "T12:00:00");
      lu.textContent = `Week of ${new Date(data.metadata.week_start + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}–${weekEnd.toLocaleDateString("en-US", { month: "short", day: "numeric" })} · Last updated: ${d.toLocaleString()}`;
    }

    initTeamSelect(data);
    render();
  })
  .catch(() => {
    document.getElementById("starts-body").innerHTML =
      '<tr><td colspan="99" style="text-align:center;color:#f87171;padding:2rem">Could not load starts data.</td></tr>';
  });
