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

function render() {
  if (!state.data) return;

  const weeks = getWeekIndices();
  const byWeek = state.data.position_scores_by_week;
  const teams = [...state.selectedTeams].sort();
  const positions = POSITION_ORDER.filter(p => state.selectedPositions.has(p));

  const headEl = document.getElementById("pivot-head");
  const bodyEl = document.getElementById("pivot-body");

  if (!teams.length || !positions.length || !weeks.length) {
    headEl.innerHTML = "";
    bodyEl.innerHTML = `<tr><td colspan="99" style="text-align:center;color:#64748b;padding:2rem">No data — adjust filters</td></tr>`;
    return;
  }

  // Global min/max for weekly cell heatmap (exclude zeros)
  let globalMin = Infinity, globalMax = -Infinity;
  for (const team of teams) {
    for (const pos of positions) {
      for (const w of weeks) {
        const v = byWeek[w]?.[team]?.[pos] || 0;
        if (v > 0) {
          if (v < globalMin) globalMin = v;
          if (v > globalMax) globalMax = v;
        }
      }
    }
  }

  // Separate min/max for the Total column (season totals are larger)
  let totalMin = Infinity, totalMax = -Infinity;
  for (const team of teams) {
    for (const pos of positions) {
      let rowTotal = 0;
      for (const w of weeks) rowTotal += (byWeek[w]?.[team]?.[pos] || 0);
      if (rowTotal > 0) {
        if (rowTotal < totalMin) totalMin = rowTotal;
        if (rowTotal > totalMax) totalMax = rowTotal;
      }
    }
  }

  // ── Header ──
  headEl.innerHTML = "";
  const tr = document.createElement("tr");

  const teamTh = document.createElement("th");
  teamTh.textContent = "Team";
  teamTh.className = "sticky-col team-col";
  tr.appendChild(teamTh);

  const posTh = document.createElement("th");
  posTh.textContent = "Pos";
  posTh.className = "sticky-col2 pos-col";
  tr.appendChild(posTh);

  for (const w of weeks) {
    const th = document.createElement("th");
    th.textContent = `MW ${w + 1}`;
    tr.appendChild(th);
  }

  const totalTh = document.createElement("th");
  totalTh.textContent = "Total";
  totalTh.className = "total-col";
  tr.appendChild(totalTh);
  headEl.appendChild(tr);

  // ── Body ──
  bodyEl.innerHTML = "";

  for (const team of teams) {
    const rowCount = positions.length + (state.showTeamTotals ? 1 : 0);

    for (let pi = 0; pi < positions.length; pi++) {
      const pos = positions[pi];
      const row = document.createElement("tr");
      if (pi === 0) row.classList.add("team-first-row");

      // Team cell — rowspan covers all position rows + total row
      if (pi === 0) {
        const td = document.createElement("td");
        td.textContent = team;
        td.rowSpan = rowCount;
        td.className = "sticky-col team-col team-cell";
        row.appendChild(td);
      }

      // Position cell
      const posTd = document.createElement("td");
      posTd.textContent = pos;
      posTd.className = "sticky-col2 pos-col";
      row.appendChild(posTd);

      let rowTotal = 0;
      for (const w of weeks) {
        const v = byWeek[w]?.[team]?.[pos] || 0;
        rowTotal += v;
        const td = document.createElement("td");
        const hasData = byWeek[w]?.[team]?.[pos] != null;
        td.textContent = hasData ? v.toFixed(1) : "—";
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

    // Team total row
    if (state.showTeamTotals) {
      const totalRow = document.createElement("tr");
      totalRow.className = "team-total-row";

      const posTd = document.createElement("td");
      posTd.textContent = "Total";
      posTd.className = "sticky-col2 pos-col pos-total";
      totalRow.appendChild(posTd);

      let teamGrandTotal = 0;
      for (const w of weeks) {
        const weekVal = positions.reduce((s, p) => s + (byWeek[w]?.[team]?.[p] || 0), 0);
        teamGrandTotal += weekVal;
        const td = document.createElement("td");
        td.textContent = weekVal.toFixed(1);
        totalRow.appendChild(td);
      }

      const gtTd = document.createElement("td");
      gtTd.textContent = teamGrandTotal.toFixed(1);
      gtTd.className = "total-col";
      totalRow.appendChild(gtTd);

      bodyEl.appendChild(totalRow);
    }
  }

  // League total row (across all teams)
  if (state.showLeagueTotal) {
    const leagueRow = document.createElement("tr");
    leagueRow.className = "league-total-row";

    const teamTd = document.createElement("td");
    teamTd.textContent = "League";
    teamTd.className = "sticky-col team-col team-cell";
    leagueRow.appendChild(teamTd);

    const posTd = document.createElement("td");
    posTd.textContent = "Total";
    posTd.className = "sticky-col2 pos-col pos-total";
    leagueRow.appendChild(posTd);

    let leagueGrandTotal = 0;
    for (const w of weeks) {
      const weekVal = teams.reduce((s, team) =>
        s + positions.reduce((ps, p) => ps + (byWeek[w]?.[team]?.[p] || 0), 0), 0);
      leagueGrandTotal += weekVal;
      const td = document.createElement("td");
      td.textContent = weekVal.toFixed(1);
      leagueRow.appendChild(td);
    }

    const gtTd = document.createElement("td");
    gtTd.textContent = leagueGrandTotal.toFixed(1);
    gtTd.className = "total-col";
    leagueRow.appendChild(gtTd);

    bodyEl.appendChild(leagueRow);
  }
}

function setupControls(data) {
  const mw = data.metadata.current_matchup_week;
  state.endWeek = mw - 1;

  // ── Week range ──
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

  // ── Position checkboxes ──
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

  // ── Team checkboxes ──
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

  // ── Totals toggles ──
  document.getElementById("show-team-totals").addEventListener("change", e => {
    state.showTeamTotals = e.target.checked;
    render();
  });
  document.getElementById("show-league-total").addEventListener("change", e => {
    state.showLeagueTotal = e.target.checked;
    render();
  });
}

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
