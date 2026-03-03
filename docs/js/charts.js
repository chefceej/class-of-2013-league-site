function buildTopScorersTable(topPlayersByWeek, currentMatchupWeek) {
  let displayWeek = currentMatchupWeek - 1; // 0-indexed, default to latest week

  const label = document.getElementById("week-nav-label");
  const tbody = document.getElementById("top-scorers-body");
  const prevBtn = document.getElementById("prev-week-btn");
  const nextBtn = document.getElementById("next-week-btn");

  function render() {
    label.textContent = `Week ${displayWeek + 1} of ${currentMatchupWeek}`;
    prevBtn.disabled = displayWeek === 0;
    nextBtn.disabled = displayWeek === currentMatchupWeek - 1;

    const players = topPlayersByWeek[displayWeek] || [];
    tbody.innerHTML = "";
    players.forEach((p, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td style="text-align:center;color:#94a3b8">${i + 1}</td>
        <td>${p.name}</td>
        <td style="text-align:center;color:#94a3b8">${p.mlb_team}</td>
        <td>${p.fantasy_team}</td>
        <td style="text-align:center;font-weight:700;font-variant-numeric:tabular-nums">${p.score.toFixed(1)}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  prevBtn.addEventListener("click", () => { if (displayWeek > 0) { displayWeek--; render(); } });
  nextBtn.addEventListener("click", () => { if (displayWeek < currentMatchupWeek - 1) { displayWeek++; render(); } });

  render();
}

function rankingPointsColor(val, min, max) {
  const t = max === min ? 0.5 : (val - min) / (max - min);
  return `hsla(${Math.round(t * 120)}, 60%, 25%, 0.8)`;
}

function actualPointsColor(val, min, max) {
  const t = max === min ? 0.5 : (val - min) / (max - min);
  return `hsla(${Math.round(t * 120)}, 55%, 22%, 0.8)`;
}

function buildWeeklyTable(headEl, bodyEl, teams, currentWeek, dataKey, colorFn) {
  // Compute global min/max across all weekly values
  let globalMin = Infinity, globalMax = -Infinity;
  teams.forEach(team => {
    team[dataKey].slice(0, currentWeek).forEach(v => {
      if (v != null) {
        if (v < globalMin) globalMin = v;
        if (v > globalMax) globalMax = v;
      }
    });
  });

  // Build header row
  const headerRow = document.createElement("tr");

  const teamTh = document.createElement("th");
  teamTh.textContent = "Team";
  teamTh.className = "sticky-col";
  headerRow.appendChild(teamTh);

  for (let w = 1; w <= currentWeek; w++) {
    const th = document.createElement("th");
    th.textContent = `Wk ${w}`;
    th.dataset.week = w;
    headerRow.appendChild(th);
  }

  const totalTh = document.createElement("th");
  totalTh.textContent = "Total";
  totalTh.dataset.week = "total";
  totalTh.className = "total-col";
  headerRow.appendChild(totalTh);

  headEl.innerHTML = "";
  headEl.appendChild(headerRow);

  let sortWeek = "total";
  let sortDir = -1; // -1 = descending

  function computeTotal(team) {
    return team[dataKey].slice(0, currentWeek).reduce((sum, v) => sum + (v ?? 0), 0);
  }

  function render() {
    const sorted = [...teams].sort((a, b) => {
      let av, bv;
      if (sortWeek === "total") {
        av = computeTotal(a);
        bv = computeTotal(b);
      } else {
        av = a[dataKey][sortWeek - 1] ?? -Infinity;
        bv = b[dataKey][sortWeek - 1] ?? -Infinity;
      }
      return sortDir === -1 ? (bv - av) : (av - bv);
    });

    bodyEl.innerHTML = "";
    sorted.forEach(team => {
      const tr = document.createElement("tr");

      const nameTd = document.createElement("td");
      nameTd.textContent = team.team_abbrev || team.team_name;
      nameTd.className = "sticky-col";
      tr.appendChild(nameTd);

      for (let w = 1; w <= currentWeek; w++) {
        const val = team[dataKey][w - 1];
        const td = document.createElement("td");
        if (val != null) {
          td.textContent = val.toFixed(1);
          td.style.background = colorFn(val, globalMin, globalMax);
        } else {
          td.textContent = "—";
        }
        tr.appendChild(td);
      }

      const total = computeTotal(team);
      const totalTd = document.createElement("td");
      totalTd.textContent = total.toFixed(1);
      totalTd.className = "total-col";
      tr.appendChild(totalTd);

      bodyEl.appendChild(tr);
    });
  }

  headEl.querySelectorAll("th[data-week]").forEach(th => {
    th.addEventListener("click", () => {
      const w = th.dataset.week === "total" ? "total" : parseInt(th.dataset.week);
      if (sortWeek === w) {
        sortDir *= -1;
      } else {
        sortWeek = w;
        sortDir = -1;
      }
      render();
    });
  });

  render();
}

(async () => {
  let data;
  try {
    const resp = await fetch("data/league_data.json");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    data = await resp.json();
  } catch (err) {
    document.querySelector(".chart-wrapper").innerHTML =
      `<p style="color:#f87171;text-align:center;padding:2rem;">Failed to load league data: ${err.message}</p>`;
    return;
  }

  const { metadata, teams, top_players_by_week } = data;
  const currentMatchupWeek = metadata.current_matchup_week ?? metadata.current_week;
  const numTeams = metadata.num_teams;
  const playoffCutoff = metadata.playoff_cutoff;

  // Update last-updated timestamp
  const updated = new Date(metadata.last_updated);
  document.getElementById("last-updated").textContent =
    `Last updated: ${updated.toLocaleString("en-US", { timeZoneName: "short" })}`;

  // Week labels
  const weekLabels = Array.from({ length: currentMatchupWeek }, (_, i) => `Wk ${i + 1}`);

  // Evenly spaced HSL colors
  const color = (i) => `hsl(${Math.round((i / numTeams) * 360)}, 70%, 62%)`;

  // Build datasets — one per team, only up to currentMatchupWeek
  const teamDatasets = teams.map((team, i) => ({
    label: team.team_abbrev || team.team_name,
    data: team.normalized_by_week.slice(0, currentMatchupWeek),
    borderColor: color(i),
    backgroundColor: color(i) + "22",
    borderWidth: 2,
    pointRadius: 3,
    pointHoverRadius: 6,
    tension: 0.3,
  }));

  // Zero-line dataset (no plugin needed)
  const zeroLine = {
    label: "6th Place (0)",
    data: Array(currentMatchupWeek).fill(0),
    borderColor: "#f87171",
    borderDash: [6, 4],
    borderWidth: 1.5,
    pointRadius: 0,
    pointHoverRadius: 0,
    fill: false,
  };

  const ctx = document.getElementById("playoffChart").getContext("2d");
  try { new Chart(ctx, {
    type: "line",
    data: { labels: weekLabels, datasets: [...teamDatasets, zeroLine] },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: window.innerWidth <= 600 ? 1.1 : 2,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: "#94a3b8",
            boxWidth: 12,
            padding: 14,
            font: { size: 11 },
            filter: (item) => item.text !== "6th Place (0)",
          },
        },
        tooltip: {
          backgroundColor: "#1e2535",
          titleColor: "#e2e8f0",
          bodyColor: "#94a3b8",
          borderColor: "#334155",
          borderWidth: 1,
          callbacks: {
            label: (ctx) => {
              if (ctx.dataset.label === "6th Place (0)") return null;
              const val = ctx.parsed.y;
              const sign = val > 0 ? "+" : "";
              return ` ${ctx.dataset.label}: ${sign}${val.toFixed(1)}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { color: "#64748b", font: { size: 11 } },
          grid: { color: "#1e2535" },
        },
        y: {
          title: { display: true, text: "Points vs. 6th Place", color: "#64748b" },
          ticks: {
            color: "#64748b",
            font: { size: 11 },
            callback: (v) => (v > 0 ? `+${v}` : v),
          },
          grid: { color: "#1e2535" },
        },
      },
    },
  }); } catch (chartErr) { console.error("Chart error:", chartErr); }

  // Standings table — sorted by normalized score at latest matchup week
  const sorted = [...teams].sort((a, b) => {
    const av = a.normalized_by_week[currentMatchupWeek - 1] ?? -Infinity;
    const bv = b.normalized_by_week[currentMatchupWeek - 1] ?? -Infinity;
    return bv - av;
  });

  const tbody = document.getElementById("standings-body");
  sorted.forEach((team, rank) => {
    const norm = team.normalized_by_week[currentMatchupWeek - 1];
    const cumPts = team.cumulative_points_by_week?.[currentMatchupWeek - 1];
    const normDisplay = norm == null ? "—" : (norm > 0 ? `+${norm.toFixed(1)}` : norm.toFixed(1));
    const scoreClass = norm == null ? "" : norm > 0 ? "score-positive" : norm < 0 ? "score-negative" : "score-zero";
    const rowClass = norm == null ? "" : norm >= 0 ? "in-playoffs" : "out-playoffs";

    const tr = document.createElement("tr");
    tr.className = rowClass;

    // Add dashed border after playoff cutoff
    if (rank === playoffCutoff - 1) tr.classList.add("cutoff-border");

    tr.innerHTML = `
      <td>${rank + 1}</td>
      <td>${team.team_name}</td>
      <td>${cumPts?.toFixed(1) ?? "—"}</td>
      <td>${team.total_score?.toFixed(1) ?? "—"}</td>
      <td class="${scoreClass}">${normDisplay}</td>
    `;
    tbody.appendChild(tr);
  });

  // Top scorers table
  if (top_players_by_week?.length) {
    buildTopScorersTable(top_players_by_week, currentMatchupWeek);
  }

  // Weekly tables
  buildWeeklyTable(
    document.getElementById("ranking-points-head"),
    document.getElementById("ranking-points-body"),
    teams, currentMatchupWeek, "ranking_points_by_week", rankingPointsColor
  );
  buildWeeklyTable(
    document.getElementById("actual-points-head"),
    document.getElementById("actual-points-body"),
    teams, currentMatchupWeek, "scores_by_week", actualPointsColor
  );
})();
