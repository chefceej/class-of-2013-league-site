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

  const { metadata, teams } = data;
  const currentWeek = metadata.current_week;
  const numTeams = metadata.num_teams;
  const playoffCutoff = metadata.playoff_cutoff;

  // Update last-updated timestamp
  const updated = new Date(metadata.last_updated);
  document.getElementById("last-updated").textContent =
    `Last updated: ${updated.toLocaleString("en-US", { timeZoneName: "short" })}`;

  // Week labels
  const weekLabels = Array.from({ length: currentWeek }, (_, i) => `Wk ${i + 1}`);

  // Evenly spaced HSL colors
  const color = (i) => `hsl(${Math.round((i / numTeams) * 360)}, 70%, 62%)`;

  // Build datasets — one per team, only up to currentWeek
  const teamDatasets = teams.map((team, i) => ({
    label: team.team_abbrev || team.team_name,
    data: team.normalized_by_week.slice(0, currentWeek),
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
    data: Array(currentWeek).fill(0),
    borderColor: "#f87171",
    borderDash: [6, 4],
    borderWidth: 1.5,
    pointRadius: 0,
    pointHoverRadius: 0,
    fill: false,
  };

  const ctx = document.getElementById("playoffChart").getContext("2d");
  new Chart(ctx, {
    type: "line",
    data: { labels: weekLabels, datasets: [...teamDatasets, zeroLine] },
    options: {
      responsive: true,
      maintainAspectRatio: true,
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
  });

  // Standings table — sorted by normalized score at latest week
  const sorted = [...teams].sort((a, b) => {
    const av = a.normalized_by_week[currentWeek - 1] ?? -Infinity;
    const bv = b.normalized_by_week[currentWeek - 1] ?? -Infinity;
    return bv - av;
  });

  const tbody = document.getElementById("standings-body");
  sorted.forEach((team, rank) => {
    const norm = team.normalized_by_week[currentWeek - 1];
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
      <td>${team.wins}</td>
      <td>${team.losses}</td>
      <td class="${scoreClass}">${normDisplay}</td>
    `;
    tbody.appendChild(tr);
  });
})();
