const PLAYOFF_START = "2026-08-10";
const WEEKS_PER_ROUND = 2;

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return d;
}

function formatRange(startDate, weeks) {
  const end = new Date(startDate);
  end.setDate(end.getDate() + weeks * 7 - 1);
  const opts = { month: "short", day: "numeric" };
  return `${startDate.toLocaleDateString("en-US", opts)} – ${end.toLocaleDateString("en-US", opts)}`;
}

function buildMatchupEl(teamA, teamB) {
  const div = document.createElement("div");
  div.className = "matchup";
  div.appendChild(buildTeamRow(teamA));
  div.appendChild(buildTeamRow(teamB));
  return div;
}

function buildTeamRow(team) {
  const row = document.createElement("div");
  row.className = "matchup-team" + (team.bye ? " bye" : "");

  const seed = document.createElement("span");
  seed.className = "seed";
  seed.textContent = team.seed != null ? `#${team.seed}` : "";
  row.appendChild(seed);

  const name = document.createElement("span");
  name.className = "team-name" + (team.tbd ? " tbd" : "");
  name.textContent = team.name;
  row.appendChild(name);

  return row;
}

function buildBracket(containerEl, rounds) {
  containerEl.innerHTML = "";
  rounds.forEach((round, i) => {
    const roundDiv = document.createElement("div");
    roundDiv.className = "bracket-round";

    const label = document.createElement("div");
    label.className = "round-label";
    label.textContent = round.label;
    roundDiv.appendChild(label);

    const dates = document.createElement("div");
    dates.className = "round-dates";
    dates.textContent = round.dates;
    roundDiv.appendChild(dates);

    for (const matchup of round.matchups) {
      roundDiv.appendChild(buildMatchupEl(matchup[0], matchup[1]));
    }

    containerEl.appendChild(roundDiv);

    if (i < rounds.length - 1) {
      const conn = document.createElement("div");
      conn.className = "bracket-connector";
      containerEl.appendChild(conn);
    }
  });
}

(async () => {
  let data;
  try {
    const resp = await fetch("data/league_data.json");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    data = await resp.json();
  } catch (err) {
    document.getElementById("winners-bracket").innerHTML =
      `<p style="color:#f87171;padding:2rem">Failed to load data: ${err.message}</p>`;
    return;
  }

  const { metadata, teams } = data;
  const currentMatchupWeek = metadata.current_matchup_week ?? metadata.current_week;

  const updated = new Date(metadata.last_updated);
  document.getElementById("last-updated").textContent =
    `Last updated: ${updated.toLocaleString("en-US", { timeZoneName: "short" })}`;

  // Sort teams by current normalized standings (same as standings page)
  const sorted = [...teams].sort((a, b) => {
    const av = a.normalized_by_week[currentMatchupWeek - 1] ?? -Infinity;
    const bv = b.normalized_by_week[currentMatchupWeek - 1] ?? -Infinity;
    return bv - av;
  });

  function teamInfo(seed) {
    const t = sorted[seed - 1];
    return t ? { seed, name: `${t.team_abbrev} — ${t.team_name}` } : { seed, name: "TBD", tbd: true };
  }

  function tbd(label) {
    return { seed: null, name: label || "TBD", tbd: true };
  }

  // Round dates
  const r1Start = addDays(PLAYOFF_START, 0);
  const r2Start = addDays(PLAYOFF_START, WEEKS_PER_ROUND * 7);
  const r3Start = addDays(PLAYOFF_START, WEEKS_PER_ROUND * 7 * 2);

  const r1Dates = formatRange(r1Start, WEEKS_PER_ROUND);
  const r2Dates = formatRange(r2Start, WEEKS_PER_ROUND);
  const r3Dates = formatRange(r3Start, WEEKS_PER_ROUND);

  // Winners bracket: 1 & 2 bye, 3v6, 4v5
  const winnersRounds = [
    {
      label: "Round 1",
      dates: r1Dates,
      matchups: [
        [{ ...teamInfo(1), bye: true }, tbd("BYE")],
        [teamInfo(3), teamInfo(6)],
        [teamInfo(4), teamInfo(5)],
        [{ ...teamInfo(2), bye: true }, tbd("BYE")],
      ],
    },
    {
      label: "Semifinals",
      dates: r2Dates,
      matchups: [
        [teamInfo(1), tbd("Winner 3v6")],
        [teamInfo(2), tbd("Winner 4v5")],
      ],
    },
    {
      label: "Championship",
      dates: r3Dates,
      matchups: [
        [tbd("Semifinal 1 Winner"), tbd("Semifinal 2 Winner")],
      ],
    },
  ];

  // Losers bracket: 11 & 12 bye, 10v7, 9v8
  const losersRounds = [
    {
      label: "Round 1",
      dates: r1Dates,
      matchups: [
        [{ ...teamInfo(12), bye: true }, tbd("BYE")],
        [teamInfo(10), teamInfo(7)],
        [teamInfo(9), teamInfo(8)],
        [{ ...teamInfo(11), bye: true }, tbd("BYE")],
      ],
    },
    {
      label: "Semifinals",
      dates: r2Dates,
      matchups: [
        [teamInfo(12), tbd("Winner 10v7")],
        [teamInfo(11), tbd("Winner 9v8")],
      ],
    },
    {
      label: "Toilet Bowl",
      dates: r3Dates,
      matchups: [
        [tbd("Semifinal 1 Winner"), tbd("Semifinal 2 Winner")],
      ],
    },
  ];

  buildBracket(document.getElementById("winners-bracket"), winnersRounds);
  buildBracket(document.getElementById("losers-bracket"), losersRounds);
})();
