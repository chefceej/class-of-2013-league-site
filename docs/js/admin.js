(async () => {
  const errorEl = document.getElementById("admin-error");

  let data, config;
  try {
    const [dataResp, configResp] = await Promise.all([
      fetch("data/league_data.json"),
      fetch("data/week_config.json"),
    ]);
    if (!dataResp.ok) throw new Error(`league_data.json: HTTP ${dataResp.status}`);
    if (!configResp.ok) throw new Error(`week_config.json: HTTP ${configResp.status}`);
    data = await dataResp.json();
    config = await configResp.json();
  } catch (err) {
    errorEl.textContent = `Failed to load data: ${err.message}`;
    errorEl.style.display = "block";
    return;
  }

  const { teams, espn_week_scores } = data;
  const espn_to_matchup = config.espn_to_matchup;
  const totalEspnWeeks = espn_to_matchup.length;

  // Sort teams by team_id for consistent column order
  const sortedTeams = [...teams].sort((a, b) => a.team_id - b.team_id);

  // Build header
  const headEl = document.getElementById("admin-head");
  const headerRow = document.createElement("tr");

  const espnWkTh = document.createElement("th");
  espnWkTh.textContent = "ESPN Week";
  espnWkTh.className = "sticky-col";
  headerRow.appendChild(espnWkTh);

  sortedTeams.forEach(team => {
    const th = document.createElement("th");
    th.textContent = team.team_abbrev || team.team_name;
    headerRow.appendChild(th);
  });

  const matchupWkTh = document.createElement("th");
  matchupWkTh.textContent = "Matchup Week";
  headerRow.appendChild(matchupWkTh);

  headEl.appendChild(headerRow);

  // Build body
  const bodyEl = document.getElementById("admin-body");
  const inputs = [];

  for (let espnWeek = 1; espnWeek <= totalEspnWeeks; espnWeek++) {
    const tr = document.createElement("tr");

    const weekTd = document.createElement("td");
    weekTd.textContent = `Wk ${espnWeek}`;
    weekTd.className = "sticky-col";
    tr.appendChild(weekTd);

    const weekScores = (espn_week_scores || {})[String(espnWeek)] || {};
    sortedTeams.forEach(team => {
      const td = document.createElement("td");
      const score = weekScores[String(team.team_id)];
      td.textContent = score != null ? score.toFixed(1) : "—";
      tr.appendChild(td);
    });

    const inputTd = document.createElement("td");
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.max = String(totalEspnWeeks);
    input.value = espn_to_matchup[espnWeek - 1] ?? espnWeek;
    input.className = "matchup-week-input";
    inputTd.appendChild(input);
    inputs.push(input);
    tr.appendChild(inputTd);

    bodyEl.appendChild(tr);
  }

  // Download button
  document.getElementById("download-btn").addEventListener("click", () => {
    const mapping = inputs.map(inp => {
      const v = parseInt(inp.value, 10);
      return isNaN(v) ? 1 : v;
    });
    const configObj = { espn_to_matchup: mapping };
    const blob = new Blob([JSON.stringify(configObj, null, 2) + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "week_config.json";
    a.click();
    URL.revokeObjectURL(url);
  });
})();
