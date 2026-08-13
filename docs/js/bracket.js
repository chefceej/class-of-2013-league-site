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
  row.className = "matchup-team"
    + (team.bye ? " bye" : "")
    + (team.won ? " winner" : "")
    + (team.leading ? " leading" : "")
    + (team.champion ? " champion" : "");

  const seed = document.createElement("span");
  seed.className = "seed";
  seed.textContent = team.seed != null ? `#${team.seed}` : "";
  row.appendChild(seed);

  const name = document.createElement("span");
  name.className = "team-name" + (team.tbd ? " tbd" : "");
  name.textContent = team.name;
  if (team.champion) name.textContent = "🏆 " + name.textContent;
  row.appendChild(name);

  const score = document.createElement("span");
  score.className = "team-score";
  if (team.bye && team.score == null) {
    score.textContent = "";
  } else if (team.score != null) {
    score.textContent = team.score.toFixed(1);
  } else {
    score.textContent = "";
  }
  row.appendChild(score);

  return row;
}

function buildBracket(containerEl, rounds, currentRoundIdx) {
  containerEl.innerHTML = "";
  rounds.forEach((round, i) => {
    const roundDiv = document.createElement("div");
    roundDiv.className = "bracket-round" + (i === currentRoundIdx ? " active-round" : "");

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
  const playoff = data.playoff || { rounds: [], current_round: 0, round_length_weeks: WEEKS_PER_ROUND };
  const roundsData = playoff.rounds || [];
  const roundLen = playoff.round_length_weeks || WEEKS_PER_ROUND;
  const currentMatchupWeek = metadata.current_matchup_week ?? metadata.current_week;

  const updated = new Date(metadata.last_updated);
  document.getElementById("last-updated").textContent =
    `Last updated: ${updated.toLocaleString("en-US", { timeZoneName: "short" })}`;

  // Seed by the site's cumulative normalized standings, frozen at the last
  // regular-season week (playoff rounds don't earn ranking points).
  const seedWeekIdx = Math.min(currentMatchupWeek, playoff.regular_season_periods || currentMatchupWeek) - 1;
  const sorted = [...teams].sort((a, b) => {
    const av = a.normalized_by_week[seedWeekIdx] ?? -Infinity;
    const bv = b.normalized_by_week[seedWeekIdx] ?? -Infinity;
    return bv - av;
  });

  // ── Round score / completion helpers ──
  function roundScore(roundIdx, abbrev) {
    const r = roundsData[roundIdx];
    return r && r.scores ? r.scores[abbrev] : undefined;
  }
  function roundEndDate(roundIdx) {
    const start = new Date(PLAYOFF_START + "T12:00:00");
    start.setDate(start.getDate() + roundIdx * roundLen * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + roundLen * 7 - 1);
    return end;
  }
  // A round is "settled" (winners final) when ESPN has rolled past it OR its
  // date window has closed — the latter also crowns the final, which never
  // gets a later matchup period to compare against.
  function roundSettled(roundIdx) {
    const r = roundsData[roundIdx];
    if (r && r.complete) return true;
    return new Date() > roundEndDate(roundIdx);
  }

  function seedTeam(seed) {
    const t = sorted[seed - 1];
    if (!t) return { seed, name: "TBD", tbd: true };
    return { seed, abbrev: t.team_abbrev, name: `${t.team_abbrev} — ${t.team_name}` };
  }
  function tbd(label) {
    return { seed: null, name: label || "TBD", tbd: true };
  }
  function clean(team) {
    // strip per-round decoration before reusing a team in a later round
    return { seed: team.seed, abbrev: team.abbrev, name: team.name, tbd: team.tbd };
  }

  // Attach this round's scores + leader/winner state to both sides of a matchup.
  function decorate(a, b, roundIdx) {
    const A = { ...a }, B = { ...b };
    A.score = A.tbd ? null : roundScore(roundIdx, A.abbrev) ?? null;
    B.score = B.tbd ? null : roundScore(roundIdx, B.abbrev) ?? null;
    if (A.score != null && B.score != null && A.score !== B.score) {
      const settled = roundSettled(roundIdx);
      const leader = A.score > B.score ? A : B;
      if (settled) leader.won = true; else leader.leading = true;
    }
    return [A, B];
  }

  // Who advances out of (a vs b) played in roundIdx. Byes auto-advance.
  function advance(a, b, roundIdx) {
    if (a && a.bye && !b.bye) return clean(a);
    if (b && b.bye && !a.bye) return clean(b);
    if (!a || !b || a.tbd || b.tbd) return tbd();
    if (!roundSettled(roundIdx)) return tbd();
    const sa = roundScore(roundIdx, a.abbrev), sb = roundScore(roundIdx, b.abbrev);
    if (sa == null || sb == null) return tbd();
    return sa >= sb ? clean(a) : clean(b);
  }

  const r1Dates = formatRange(addDays(PLAYOFF_START, 0), roundLen);
  const r2Dates = formatRange(addDays(PLAYOFF_START, roundLen * 7), roundLen);
  const r3Dates = formatRange(addDays(PLAYOFF_START, roundLen * 7 * 2), roundLen);

  // Build one bracket (winners or losers) from its four round-1 seeds.
  // seeds: { byeTop, byeBottom, mt' } — pass the seed numbers explicitly.
  function buildRounds(labels, s) {
    // s: {topBye, a1, a2, b1, b2, botBye}  → R1: [topBye bye], [a1 v a2], [b1 v b2], [botBye bye]
    const topBye = seedTeam(s.topBye);
    const botBye = seedTeam(s.botBye);

    // Round 1
    const [a1, a2] = decorate(seedTeam(s.a1), seedTeam(s.a2), 0);
    const [b1, b2] = decorate(seedTeam(s.b1), seedTeam(s.b2), 0);
    const topByeR1 = { ...topBye, bye: true, score: roundScore(0, topBye.abbrev) ?? null };
    const botByeR1 = { ...botBye, bye: true, score: roundScore(0, botBye.abbrev) ?? null };

    // Semis: bye teams vs round-1 winners
    const semiTopA = clean(topBye);
    const semiTopB = advance(seedTeam(s.a1), seedTeam(s.a2), 0);
    const semiBotA = clean(botBye);
    const semiBotB = advance(seedTeam(s.b1), seedTeam(s.b2), 0);
    const [st1, st2] = decorate(semiTopA, semiTopB, 1);
    const [sb1, sb2] = decorate(semiBotA, semiBotB, 1);

    // Final: semi winners
    const finA = advance(semiTopA, semiTopB, 1);
    const finB = advance(semiBotA, semiBotB, 1);
    const [f1, f2] = decorate(finA, finB, 2);
    // Crown the champion once the final is settled
    if (roundSettled(2) && f1.score != null && f2.score != null && f1.score !== f2.score) {
      (f1.score > f2.score ? f1 : f2).champion = true;
    }

    return [
      { label: labels[0], dates: r1Dates, matchups: [[topByeR1, tbd("BYE")], [a1, a2], [b1, b2], [botByeR1, tbd("BYE")]] },
      { label: labels[1], dates: r2Dates, matchups: [[st1, st2], [sb1, sb2]] },
      { label: labels[2], dates: r3Dates, matchups: [[f1, f2]] },
    ];
  }

  // Winners: 1 & 2 bye, 3v6, 4v5
  const winnersRounds = buildRounds(
    ["Round 1", "Semifinals", "Championship"],
    { topBye: 1, a1: 3, a2: 6, b1: 4, b2: 5, botBye: 2 }
  );
  // Losers: 12 & 11 bye, 10v7, 9v8
  const losersRounds = buildRounds(
    ["Round 1", "Semifinals", "Toilet Bowl"],
    { topBye: 12, a1: 10, a2: 7, b1: 9, b2: 8, botBye: 11 }
  );

  const currentRoundIdx = (playoff.current_round || 1) - 1;
  buildBracket(document.getElementById("winners-bracket"), winnersRounds, currentRoundIdx);
  buildBracket(document.getElementById("losers-bracket"), losersRounds, currentRoundIdx);
})();
