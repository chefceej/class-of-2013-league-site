const POSITION_ORDER = ["C", "1B", "2B", "3B", "SS", "OF", "UTIL", "SP", "RP"];

const state = {
  data: null,
  allWeeks: true,
  startWeek: 0,
  endWeek: 0,
  selectedPositions: new Set(POSITION_ORDER),
  selectedTeams: new Set(),
  showTeamTotals: true,
  showLeagueTotal: false,
  sortCol: "total",
  sortDir: -1,
  viewMode: "byTeam",
  timeMode: "byWeek",
};

function getWeekIndices() {
  const mw = state.data.metadata.current_matchup_week;
  const start = state.allWeeks ? 0 : state.startWeek;
  const end = state.allWeeks ? mw - 1 : state.endWeek;
  const weeks = [];
  for (let w = start; w <= end; w++) weeks.push(w);
  return weeks;
}

function cellColor(val, globalMin, globalMax) {
  if (val <= 0 || globalMax <= globalMin) return "";
  const t = (val - globalMin) / (globalMax - globalMin);
  return `hsla(${Math.round(t * 120)}, 55%, 22%, 0.85)`;
}

function getVal(team, pos, weekIdx) {
  return state.data.position_scores_by_week[weekIdx]?.[team]?.[pos] || 0;
}

function getAgg(team, pos, weeks) {
  let s = 0;
  for (const w of weeks) s += getVal(team, pos, w);
  return s;
}

/* ── Render dispatch ── */

function render() {
  if (!state.data) return;

  const headEl = document.getElementById("pivot-head");
  const bodyEl = document.getElementById("pivot-body");
  const teams = [...state.selectedTeams].sort();
  const positions = POSITION_ORDER.filter(p => state.selectedPositions.has(p));
  const weeks = getWeekIndices();

  if (!teams.length || !positions.length || !weeks.length) {
    headEl.innerHTML = "";
    bodyEl.innerHTML = `<tr><td colspan="99" style="text-align:center;color:#64748b;padding:2rem">No data — adjust filters</td></tr>`;
    return;
  }

  if (state.viewMode === "byTeam" && state.timeMode === "byWeek") {
    renderTeamByWeek(headEl, bodyEl, teams, positions, weeks);
  } else if (state.viewMode === "byTeam" && state.timeMode === "total") {
    renderTeamTotal(headEl, bodyEl, teams, positions, weeks);
  } else if (state.viewMode === "byPosition" && state.timeMode === "byWeek") {
    renderPositionByWeek(headEl, bodyEl, teams, positions, weeks);
  } else {
    renderPositionTotal(headEl, bodyEl, teams, positions, weeks);
  }
}

/* ── View 1: By Team + By Week (original) ── */

function renderTeamByWeek(headEl, bodyEl, teams, positions, weeks) {
  const byWeek = state.data.position_scores_by_week;

  let globalMin = Infinity, globalMax = -Infinity;
  let totalMin = Infinity, totalMax = -Infinity;
  for (const team of teams) {
    for (const pos of positions) {
      let rowTotal = 0;
      for (const w of weeks) {
        const v = getVal(team, pos, w);
        if (v > 0) { globalMin = Math.min(globalMin, v); globalMax = Math.max(globalMax, v); }
        rowTotal += v;
      }
      if (rowTotal > 0) { totalMin = Math.min(totalMin, rowTotal); totalMax = Math.max(totalMax, rowTotal); }
    }
  }

  function teamSortVal(team, col) {
    if (col === "team") return 0;
    if (col === "total") {
      let s = 0;
      for (const w of weeks) for (const p of positions) s += getVal(team, p, w);
      return s;
    }
    let s = 0;
    for (const p of positions) s += getVal(team, p, col);
    return s;
  }

  const sortedTeams = [...teams].sort((a, b) => {
    if (state.sortCol === "team") return state.sortDir * a.localeCompare(b);
    const diff = teamSortVal(a, state.sortCol) - teamSortVal(b, state.sortCol);
    return diff !== 0 ? state.sortDir * diff : a.localeCompare(b);
  });

  // Header
  headEl.innerHTML = "";
  const tr = document.createElement("tr");

  const teamTh = makeSortTh("Team", "team", "sticky-col team-col");
  tr.appendChild(teamTh);

  const posTh = document.createElement("th");
  posTh.textContent = "Pos";
  posTh.className = "sticky-col2 pos-col";
  tr.appendChild(posTh);

  for (const w of weeks) {
    tr.appendChild(makeSortTh(`MW ${w + 1}`, w));
  }
  tr.appendChild(makeSortTh("Total", "total", "total-col"));
  headEl.appendChild(tr);

  // Body
  bodyEl.innerHTML = "";
  for (const team of sortedTeams) {
    const rowCount = positions.length + (state.showTeamTotals ? 1 : 0);
    for (let pi = 0; pi < positions.length; pi++) {
      const pos = positions[pi];
      const row = document.createElement("tr");
      if (pi === 0) row.classList.add("team-first-row");

      if (pi === 0) {
        const td = document.createElement("td");
        td.textContent = team;
        td.rowSpan = rowCount;
        td.className = "sticky-col team-col team-cell";
        row.appendChild(td);
      }

      const posTd = document.createElement("td");
      posTd.textContent = pos;
      posTd.className = "sticky-col2 pos-col";
      row.appendChild(posTd);

      let rowTotal = 0;
      for (const w of weeks) {
        const v = getVal(team, pos, w);
        rowTotal += v;
        const td = document.createElement("td");
        td.textContent = byWeek[w]?.[team]?.[pos] != null ? v.toFixed(1) : "—";
        if (v > 0) td.style.background = cellColor(v, globalMin, globalMax);
        row.appendChild(td);
      }

      const totalTd = document.createElement("td");
      totalTd.textContent = rowTotal > 0 ? rowTotal.toFixed(1) : "—";
      totalTd.className = "total-col";
      if (rowTotal > 0) totalTd.style.background = cellColor(rowTotal, totalMin, totalMax);
      row.appendChild(totalTd);

      bodyEl.appendChild(row);
    }

    if (state.showTeamTotals) {
      const totalRow = document.createElement("tr");
      totalRow.className = "team-total-row";
      const posTd = document.createElement("td");
      posTd.textContent = "Total";
      posTd.className = "sticky-col2 pos-col pos-total";
      totalRow.appendChild(posTd);

      let gt = 0;
      for (const w of weeks) {
        const wv = positions.reduce((s, p) => s + getVal(team, p, w), 0);
        gt += wv;
        const td = document.createElement("td");
        td.textContent = wv.toFixed(1);
        totalRow.appendChild(td);
      }
      const gtTd = document.createElement("td");
      gtTd.textContent = gt.toFixed(1);
      gtTd.className = "total-col";
      totalRow.appendChild(gtTd);
      bodyEl.appendChild(totalRow);
    }
  }

  appendLeagueRow(bodyEl, teams, positions, weeks, "team-week");
}

/* ── View 2: By Team + Total (Team rows × Position columns) ── */

function renderTeamTotal(headEl, bodyEl, teams, positions, weeks) {
  const allVals = [];
  for (const team of teams)
    for (const pos of positions)
      allVals.push(getAgg(team, pos, weeks));
  const [gMin, gMax] = computeMinMax(allVals);

  function teamSortVal(team, col) {
    if (col === "team") return 0;
    if (col === "total") return positions.reduce((s, p) => s + getAgg(team, p, weeks), 0);
    return getAgg(team, col, weeks); // col is a position name
  }

  const sortedTeams = [...teams].sort((a, b) => {
    if (state.sortCol === "team") return state.sortDir * a.localeCompare(b);
    const diff = teamSortVal(a, state.sortCol) - teamSortVal(b, state.sortCol);
    return diff !== 0 ? state.sortDir * diff : a.localeCompare(b);
  });

  // Header
  headEl.innerHTML = "";
  const tr = document.createElement("tr");
  tr.appendChild(makeSortTh("Team", "team", "sticky-col team-col"));
  for (const pos of positions) {
    tr.appendChild(makeSortTh(pos, pos));
  }
  tr.appendChild(makeSortTh("Total", "total", "total-col"));
  headEl.appendChild(tr);

  // Body
  bodyEl.innerHTML = "";
  for (const team of sortedTeams) {
    const row = document.createElement("tr");
    const nameTd = document.createElement("td");
    nameTd.textContent = team;
    nameTd.className = "sticky-col team-col";
    row.appendChild(nameTd);

    let teamTotal = 0;
    for (const pos of positions) {
      const v = getAgg(team, pos, weeks);
      teamTotal += v;
      const td = document.createElement("td");
      td.textContent = v > 0 ? v.toFixed(1) : "—";
      if (v > 0) td.style.background = cellColor(v, gMin, gMax);
      row.appendChild(td);
    }

    const totalTd = document.createElement("td");
    totalTd.textContent = teamTotal > 0 ? teamTotal.toFixed(1) : "—";
    totalTd.className = "total-col";
    row.appendChild(totalTd);

    bodyEl.appendChild(row);
  }

  // League total
  if (state.showLeagueTotal) {
    const lr = document.createElement("tr");
    lr.className = "league-total-row";
    const ltTd = document.createElement("td");
    ltTd.textContent = "League";
    ltTd.className = "sticky-col team-col team-cell";
    lr.appendChild(ltTd);

    let gt = 0;
    for (const pos of positions) {
      const v = teams.reduce((s, t) => s + getAgg(t, pos, weeks), 0);
      gt += v;
      const td = document.createElement("td");
      td.textContent = v.toFixed(1);
      lr.appendChild(td);
    }
    const gtTd = document.createElement("td");
    gtTd.textContent = gt.toFixed(1);
    gtTd.className = "total-col";
    lr.appendChild(gtTd);
    bodyEl.appendChild(lr);
  }
}

/* ── View 3: By Position + By Week (Position > Team rows × Week columns) ── */

function renderPositionByWeek(headEl, bodyEl, teams, positions, weeks) {
  let globalMin = Infinity, globalMax = -Infinity;
  let totalMin = Infinity, totalMax = -Infinity;
  for (const team of teams) {
    for (const pos of positions) {
      let rt = 0;
      for (const w of weeks) {
        const v = getVal(team, pos, w);
        if (v > 0) { globalMin = Math.min(globalMin, v); globalMax = Math.max(globalMax, v); }
        rt += v;
      }
      if (rt > 0) { totalMin = Math.min(totalMin, rt); totalMax = Math.max(totalMax, rt); }
    }
  }

  function posSortVal(pos, col) {
    if (col === "pos") return 0;
    if (col === "total") return teams.reduce((s, t) => s + getAgg(t, pos, weeks), 0);
    return teams.reduce((s, t) => s + getVal(t, pos, col), 0);
  }

  const sortedPositions = [...positions].sort((a, b) => {
    if (state.sortCol === "pos") return state.sortDir * POSITION_ORDER.indexOf(a) - POSITION_ORDER.indexOf(b);
    const diff = posSortVal(a, state.sortCol) - posSortVal(b, state.sortCol);
    return diff !== 0 ? state.sortDir * diff : POSITION_ORDER.indexOf(a) - POSITION_ORDER.indexOf(b);
  });

  // Header
  headEl.innerHTML = "";
  const tr = document.createElement("tr");
  tr.appendChild(makeSortTh("Pos", "pos", "sticky-col team-col"));

  const teamTh = document.createElement("th");
  teamTh.textContent = "Team";
  teamTh.className = "sticky-col2 pos-col";
  tr.appendChild(teamTh);

  for (const w of weeks) {
    tr.appendChild(makeSortTh(`MW ${w + 1}`, w));
  }
  tr.appendChild(makeSortTh("Total", "total", "total-col"));
  headEl.appendChild(tr);

  // Body
  bodyEl.innerHTML = "";
  for (const pos of sortedPositions) {
    const sortedTeamsInPos = [...teams].sort((a, b) => {
      const av = getAgg(a, pos, weeks);
      const bv = getAgg(b, pos, weeks);
      return bv - av || a.localeCompare(b);
    });

    const rowCount = sortedTeamsInPos.length + (state.showTeamTotals ? 1 : 0);

    for (let ti = 0; ti < sortedTeamsInPos.length; ti++) {
      const team = sortedTeamsInPos[ti];
      const row = document.createElement("tr");
      if (ti === 0) row.classList.add("team-first-row");

      if (ti === 0) {
        const td = document.createElement("td");
        td.textContent = pos;
        td.rowSpan = rowCount;
        td.className = "sticky-col team-col team-cell";
        row.appendChild(td);
      }

      const teamTd = document.createElement("td");
      teamTd.textContent = team;
      teamTd.className = "sticky-col2 pos-col";
      row.appendChild(teamTd);

      let rt = 0;
      for (const w of weeks) {
        const v = getVal(team, pos, w);
        rt += v;
        const td = document.createElement("td");
        td.textContent = v > 0 ? v.toFixed(1) : "—";
        if (v > 0) td.style.background = cellColor(v, globalMin, globalMax);
        row.appendChild(td);
      }

      const totalTd = document.createElement("td");
      totalTd.textContent = rt > 0 ? rt.toFixed(1) : "—";
      totalTd.className = "total-col";
      if (rt > 0) totalTd.style.background = cellColor(rt, totalMin, totalMax);
      row.appendChild(totalTd);

      bodyEl.appendChild(row);
    }

    if (state.showTeamTotals) {
      const totalRow = document.createElement("tr");
      totalRow.className = "team-total-row";
      const td = document.createElement("td");
      td.textContent = "Total";
      td.className = "sticky-col2 pos-col pos-total";
      totalRow.appendChild(td);

      let gt = 0;
      for (const w of weeks) {
        const wv = teams.reduce((s, t) => s + getVal(t, pos, w), 0);
        gt += wv;
        const wtd = document.createElement("td");
        wtd.textContent = wv.toFixed(1);
        totalRow.appendChild(wtd);
      }
      const gtTd = document.createElement("td");
      gtTd.textContent = gt.toFixed(1);
      gtTd.className = "total-col";
      totalRow.appendChild(gtTd);
      bodyEl.appendChild(totalRow);
    }
  }

  // League total
  if (state.showLeagueTotal) {
    const lr = document.createElement("tr");
    lr.className = "league-total-row";
    const posTd = document.createElement("td");
    posTd.textContent = "All";
    posTd.className = "sticky-col team-col team-cell";
    lr.appendChild(posTd);
    const ttd = document.createElement("td");
    ttd.textContent = "Total";
    ttd.className = "sticky-col2 pos-col pos-total";
    lr.appendChild(ttd);

    let gt = 0;
    for (const w of weeks) {
      const wv = teams.reduce((s, t) => s + positions.reduce((ps, p) => ps + getVal(t, p, w), 0), 0);
      gt += wv;
      const td = document.createElement("td");
      td.textContent = wv.toFixed(1);
      lr.appendChild(td);
    }
    const gtTd = document.createElement("td");
    gtTd.textContent = gt.toFixed(1);
    gtTd.className = "total-col";
    lr.appendChild(gtTd);
    bodyEl.appendChild(lr);
  }
}

/* ── View 4: By Position + Total (Position rows × Team columns) ── */

function renderPositionTotal(headEl, bodyEl, teams, positions, weeks) {
  const allVals = [];
  for (const pos of positions)
    for (const team of teams)
      allVals.push(getAgg(team, pos, weeks));
  const [gMin, gMax] = computeMinMax(allVals);

  function posSortVal(pos, col) {
    if (col === "pos") return 0;
    if (col === "total") return teams.reduce((s, t) => s + getAgg(t, pos, weeks), 0);
    return getAgg(col, pos, weeks); // col is a team name
  }

  const sortedPositions = [...positions].sort((a, b) => {
    if (state.sortCol === "pos") return state.sortDir * (POSITION_ORDER.indexOf(a) - POSITION_ORDER.indexOf(b));
    const diff = posSortVal(a, state.sortCol) - posSortVal(b, state.sortCol);
    return diff !== 0 ? state.sortDir * diff : POSITION_ORDER.indexOf(a) - POSITION_ORDER.indexOf(b);
  });

  // Header
  headEl.innerHTML = "";
  const tr = document.createElement("tr");
  tr.appendChild(makeSortTh("Pos", "pos", "sticky-col team-col"));
  for (const team of teams) {
    tr.appendChild(makeSortTh(team, team));
  }
  tr.appendChild(makeSortTh("Total", "total", "total-col"));
  headEl.appendChild(tr);

  // Body
  bodyEl.innerHTML = "";
  for (const pos of sortedPositions) {
    const row = document.createElement("tr");
    const posTd = document.createElement("td");
    posTd.textContent = pos;
    posTd.className = "sticky-col team-col";
    row.appendChild(posTd);

    let posTotal = 0;
    for (const team of teams) {
      const v = getAgg(team, pos, weeks);
      posTotal += v;
      const td = document.createElement("td");
      td.textContent = v > 0 ? v.toFixed(1) : "—";
      if (v > 0) td.style.background = cellColor(v, gMin, gMax);
      row.appendChild(td);
    }

    const totalTd = document.createElement("td");
    totalTd.textContent = posTotal > 0 ? posTotal.toFixed(1) : "—";
    totalTd.className = "total-col";
    row.appendChild(totalTd);
    bodyEl.appendChild(row);
  }

  // League total row
  if (state.showLeagueTotal) {
    const lr = document.createElement("tr");
    lr.className = "league-total-row";
    const ltTd = document.createElement("td");
    ltTd.textContent = "Total";
    ltTd.className = "sticky-col team-col team-cell";
    lr.appendChild(ltTd);

    let gt = 0;
    for (const team of teams) {
      const v = positions.reduce((s, p) => s + getAgg(team, p, weeks), 0);
      gt += v;
      const td = document.createElement("td");
      td.textContent = v.toFixed(1);
      lr.appendChild(td);
    }
    const gtTd = document.createElement("td");
    gtTd.textContent = gt.toFixed(1);
    gtTd.className = "total-col";
    lr.appendChild(gtTd);
    bodyEl.appendChild(lr);
  }
}

/* ── Shared helpers ── */

function computeMinMax(values) {
  let min = Infinity, max = -Infinity;
  for (const v of values) {
    if (v > 0) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return [min, max];
}

function makeSortTh(label, sortKey, extraClass) {
  const th = document.createElement("th");
  const active = state.sortCol === sortKey;
  th.className = "sortable-col" + (active ? " sort-active" : "") + (extraClass ? " " + extraClass : "");
  th.innerHTML = label + (active ? ` <span class="sort-arrow">${state.sortDir === -1 ? "▼" : "▲"}</span>` : "");
  th.style.cursor = "pointer";
  th.addEventListener("click", () => {
    if (state.sortCol === sortKey) state.sortDir *= -1;
    else { state.sortCol = sortKey; state.sortDir = -1; }
    render();
  });
  return th;
}

function appendLeagueRow(bodyEl, teams, positions, weeks) {
  if (!state.showLeagueTotal) return;
  const lr = document.createElement("tr");
  lr.className = "league-total-row";

  const teamTd = document.createElement("td");
  teamTd.textContent = "League";
  teamTd.className = "sticky-col team-col team-cell";
  lr.appendChild(teamTd);

  const posTd = document.createElement("td");
  posTd.textContent = "Total";
  posTd.className = "sticky-col2 pos-col pos-total";
  lr.appendChild(posTd);

  let gt = 0;
  for (const w of weeks) {
    const wv = teams.reduce((s, t) => s + positions.reduce((ps, p) => ps + getVal(t, p, w), 0), 0);
    gt += wv;
    const td = document.createElement("td");
    td.textContent = wv.toFixed(1);
    lr.appendChild(td);
  }
  const gtTd = document.createElement("td");
  gtTd.textContent = gt.toFixed(1);
  gtTd.className = "total-col";
  lr.appendChild(gtTd);
  bodyEl.appendChild(lr);
}

/* ── Controls setup ── */

function setupControls(data) {
  const mw = data.metadata.current_matchup_week;
  state.endWeek = mw - 1;

  // View toggle
  initToggle("view-toggle", (val) => {
    state.viewMode = val;
    state.sortCol = "total";
    state.sortDir = -1;
    render();
  });

  // Time toggle
  initToggle("time-toggle", (val) => {
    state.timeMode = val;
    state.sortCol = "total";
    state.sortDir = -1;
    render();
  });

  // Week range
  const allWeeksCb = document.getElementById("all-weeks-cb");
  const weekRangeDiv = document.getElementById("week-range");
  const startSel = document.getElementById("start-week");
  const endSel = document.getElementById("end-week");

  for (let i = 0; i < mw; i++) {
    startSel.appendChild(new Option(`Week ${i + 1}`, i));
    endSel.appendChild(new Option(`Week ${i + 1}`, i));
  }
  endSel.value = mw - 1;

  allWeeksCb.addEventListener("change", () => {
    state.allWeeks = allWeeksCb.checked;
    weekRangeDiv.style.display = allWeeksCb.checked ? "none" : "flex";
    render();
  });

  startSel.addEventListener("change", () => {
    state.startWeek = +startSel.value;
    if (state.startWeek > state.endWeek) { state.endWeek = state.startWeek; endSel.value = state.endWeek; }
    render();
  });

  endSel.addEventListener("change", () => {
    state.endWeek = +endSel.value;
    if (state.endWeek < state.startWeek) { state.startWeek = state.endWeek; startSel.value = state.startWeek; }
    render();
  });

  // Position checkboxes
  const posContainer = document.getElementById("position-checkboxes");
  const availablePositions = new Set();
  for (const week of data.position_scores_by_week) {
    for (const teamScores of Object.values(week)) {
      for (const pos of Object.keys(teamScores)) availablePositions.add(pos);
    }
  }

  for (const pos of POSITION_ORDER) {
    if (!availablePositions.has(pos)) continue;
    const label = document.createElement("label");
    label.className = "checkbox-label";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.value = pos;
    cb.addEventListener("change", () => {
      if (cb.checked) state.selectedPositions.add(pos);
      else state.selectedPositions.delete(pos);
      render();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(" " + pos));
    posContainer.appendChild(label);
  }

  document.getElementById("pos-all").addEventListener("click", () => {
    posContainer.querySelectorAll("input").forEach(cb => { cb.checked = true; state.selectedPositions.add(cb.value); });
    render();
  });
  document.getElementById("pos-none").addEventListener("click", () => {
    posContainer.querySelectorAll("input").forEach(cb => { cb.checked = false; state.selectedPositions.delete(cb.value); });
    render();
  });

  // Team checkboxes
  const teamContainer = document.getElementById("team-checkboxes");
  const allTeams = [...new Set(data.position_scores_by_week.flatMap(w => Object.keys(w)))].sort();

  for (const team of allTeams) {
    state.selectedTeams.add(team);
    const label = document.createElement("label");
    label.className = "checkbox-label";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.value = team;
    cb.addEventListener("change", () => {
      if (cb.checked) state.selectedTeams.add(team);
      else state.selectedTeams.delete(team);
      render();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(" " + team));
    teamContainer.appendChild(label);
  }

  document.getElementById("team-all").addEventListener("click", () => {
    teamContainer.querySelectorAll("input").forEach(cb => { cb.checked = true; state.selectedTeams.add(cb.value); });
    render();
  });
  document.getElementById("team-none").addEventListener("click", () => {
    teamContainer.querySelectorAll("input").forEach(cb => { cb.checked = false; state.selectedTeams.delete(cb.value); });
    render();
  });

  // Totals toggles
  document.getElementById("show-team-totals").addEventListener("change", e => {
    state.showTeamTotals = e.target.checked;
    render();
  });
  document.getElementById("show-league-total").addEventListener("change", e => {
    state.showLeagueTotal = e.target.checked;
    render();
  });
}

function initToggle(id, onChange) {
  const wrap = document.getElementById(id);
  if (!wrap) return;
  wrap.querySelectorAll(".pivot-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      wrap.querySelectorAll(".pivot-toggle-btn").forEach(b => b.classList.toggle("active", b === btn));
      onChange(btn.dataset.value);
    });
  });
}

/* ── Init ── */

fetch("data/league_data.json")
  .then(r => r.json())
  .then(data => {
    state.data = data;
    const lu = document.getElementById("last-updated");
    if (data.metadata?.last_updated) {
      lu.textContent = "Last updated: " + new Date(data.metadata.last_updated).toLocaleString();
    }
    setupControls(data);
    render();
  });
