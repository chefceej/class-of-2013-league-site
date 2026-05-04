import os
import json
from collections import defaultdict
from datetime import datetime, timezone

# espn_api uses an outdated base URL; patch it before importing League
import espn_api.requests.espn_requests as _espn_req
_espn_req.FANTASY_BASE_ENDPOINT = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/"

from espn_api.baseball import League
from espn_api.baseball.constant import PRO_TEAM_MAP

# ESPN baseball uses its own 1-based defaultPositionId system (different from POSITION_MAP)
BASEBALL_POSITION_MAP = {
    1: "SP",
    2: "C",
    3: "1B",
    4: "2B",
    5: "3B",
    6: "SS",
    7: "OF",
    8: "OF",
    9: "OF",
    11: "RP",
}

# ESPN lineupSlotId → position name (actual lineup slot, not eligibility)
LINEUP_SLOT_MAP = {
    0: "C",
    1: "1B",
    2: "2B",
    3: "SS",
    4: "3B",
    5: "OF",
    6: "OF",
    7: "OF",
    12: "UTIL",
    13: "SP",
    14: "SP",
    15: "RP",
    16: "RP",
    # 20 = Bench, 21 = IL — skip these
}

# Auth: env vars take priority, fall back to hardcoded session cookies
ESPN_S2 = os.environ.get(
    "ESPN_S2",
    "AEBR5IPlQxSuwODQSQyHmqvsTZBzAWqXT70wHw0WbL2nOagMjCXjcaRORLDvAGyLqx1tUpLx3D22mg%2BEK2Ie2YUNDGAWUe1bsdXxOoyf1BGI5NqdoH7lSg3le1hsb3tGv%2FzOTnOrG2Te%2Bv98sWz5dkK6F4dagCJy9bHeQ4bk9QZMnrs0QeK0m1CkWwdZBoy9X0IyC5%2BZ3lVPHBbI4JvZR%2F3021eKy2XalfIxsGKu0LAy169kYxGj005s3faA5XLKHLFm25RYnAZZCicarYzJt09k9FUzhkgwgmY9I1XQn4RjKQ%3D%3D",
)
SWID = os.environ.get("SWID", "{EEFDF804-ED17-4981-BDF8-04ED173981C0}")

LEAGUE_ID = 37734
SEASON_YEAR = 2026
TOTAL_WEEKS = 19
PLAYOFF_CUTOFF = 6
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "league_data.json")
WEEK_CONFIG_PATH = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "week_config.json")


def load_week_config(path, total_espn_weeks):
    try:
        with open(path) as f:
            cfg = json.load(f)
        mapping = cfg["espn_to_matchup"]
        assert len(mapping) == total_espn_weeks
        return mapping
    except Exception:
        return list(range(1, total_espn_weeks + 1))  # fallback: 1:1


def assign_ranking_points(scores_by_team_id, num_teams):
    """
    Given {team_id: score}, return {team_id: ranking_points}.
    Highest score gets num_teams points, lowest gets 1.
    Ties share the average of the tied ranks.
    """
    sorted_teams = sorted(scores_by_team_id.items(), key=lambda x: x[1], reverse=True)
    points = {}
    i = 0
    while i < len(sorted_teams):
        j = i
        # Find extent of tie group
        while j < len(sorted_teams) - 1 and sorted_teams[j][1] == sorted_teams[j + 1][1]:
            j += 1
        # Ranks occupied: (num_teams - i) down to (num_teams - j), averaged
        rank_sum = sum(num_teams - k for k in range(i, j + 1))
        avg_points = rank_sum / (j - i + 1)
        for k in range(i, j + 1):
            points[sorted_teams[k][0]] = avg_points
        i = j + 1
    return points


def build_espn_period_scoring_map(req):
    """
    Returns:
      last_sp_map: {espn_matchup_period_id: last_scoring_period_in_that_week}
      all_sps_map: {espn_matchup_period_id: sorted list of all scoring period ids}
    """
    data = req.league_get(params={"view": "mMatchup"})
    last_sp_map = {}
    all_sps_map = {}
    for matchup in data["schedule"]:
        period_id = matchup["matchupPeriodId"]
        if period_id not in all_sps_map:
            all_sps_map[period_id] = set()
        for side in ["home", "away"]:
            if side in matchup and "pointsByScoringPeriod" in matchup[side]:
                sps = {int(sp) for sp in matchup[side]["pointsByScoringPeriod"]}
                all_sps_map[period_id].update(sps)
                last_sp = max(sps)
                if period_id not in last_sp_map or last_sp > last_sp_map[period_id]:
                    last_sp_map[period_id] = last_sp
    # Convert sets to sorted lists
    all_sps_map = {k: sorted(v) for k, v in all_sps_map.items()}
    return last_sp_map, all_sps_map


def fetch_top_players(req, espn_periods, espn_period_sp_map, team_abbrev_map, top_n=10):
    """
    Fetches top N active players by fantasy score across all ESPN matchup periods
    that make up one custom matchup week. Sums scores across periods for merged weeks.

    Returns dict {all: [...], pitchers: [...], hitters: [...]} each top_n by score.

    espn_periods: list of ESPN matchup period IDs (e.g. [1, 2] for a merged week)
    espn_period_sp_map: {espn_period_id: scoring_period_id}
    team_abbrev_map: {team_id: team_abbrev}
    """
    player_totals = {}  # player_id -> {name, mlb_team, fantasy_team, score, is_pitcher}

    for espn_period in espn_periods:
        sp = espn_period_sp_map.get(espn_period)
        if sp is None:
            continue

        filters = {"schedule": {"filterMatchupPeriodIds": {"value": [espn_period]}}}
        headers = {"x-fantasy-filter": json.dumps(filters)}
        data = req.league_get(
            params={"view": ["mMatchupScore", "mScoreboard"], "scoringPeriodId": sp},
            headers=headers,
        )

        for matchup in data["schedule"]:
            if matchup["matchupPeriodId"] != espn_period:
                continue
            for side in ["home", "away"]:
                if side not in matchup:
                    continue
                side_data = matchup[side]
                fantasy_team = team_abbrev_map.get(side_data["teamId"], str(side_data["teamId"]))
                for entry in side_data.get("rosterForMatchupPeriod", {}).get("entries", []):
                    pool = entry["playerPoolEntry"]
                    p = pool["player"]
                    pid = p["id"]
                    score = pool["appliedStatTotal"]
                    # Pitcher if eligible for SP (slot 13) or RP (slot 15) and NOT a position player
                    eligible = set(p.get("eligibleSlots", []))
                    pitcher_slots = {13, 14, 15}
                    hitter_slots = {0, 1, 2, 3, 4, 5, 6, 7, 12}  # C/1B/2B/SS/3B/OF/UTIL
                    is_pitcher = bool(eligible & pitcher_slots) and not (eligible & hitter_slots)

                    if pid in player_totals:
                        player_totals[pid]["score"] += score
                    else:
                        player_totals[pid] = {
                            "name": p["fullName"],
                            "mlb_team": PRO_TEAM_MAP.get(p["proTeamId"], "?"),
                            "fantasy_team": fantasy_team,
                            "score": score,
                            "is_pitcher": is_pitcher,
                        }

    players = list(player_totals.values())
    players.sort(key=lambda x: x["score"], reverse=True)
    for p in players:
        p["score"] = round(p["score"], 2)

    def strip(plist):
        return [{k: v for k, v in p.items() if k != "is_pitcher"} for p in plist]

    return {
        "all": strip(players[:top_n]),
        "pitchers": strip([p for p in players if p["is_pitcher"]][:top_n]),
        "hitters": strip([p for p in players if not p["is_pitcher"]][:top_n]),
    }


def fetch_gs_per_week(req, espn_periods, espn_period_sp_map, team_ids):
    """
    Returns {team_id: gs_total} summed across ESPN periods in a matchup week.
    GS stat id = 33, statSourceId 0 = actual stats.
    """
    gs_totals = defaultdict(int)
    for espn_period in espn_periods:
        sp = espn_period_sp_map.get(espn_period)
        if sp is None:
            continue
        filters = {"schedule": {"filterMatchupPeriodIds": {"value": [espn_period]}}}
        headers = {"x-fantasy-filter": json.dumps(filters)}
        data = req.league_get(
            params={"view": ["mMatchupScore", "mScoreboard"], "scoringPeriodId": sp},
            headers=headers,
        )
        for matchup in data.get("schedule", []):
            if matchup.get("matchupPeriodId") != espn_period:
                continue
            for side in ("home", "away"):
                side_data = matchup.get(side)
                if not side_data:
                    continue
                team_id = side_data.get("teamId")
                if team_id not in team_ids:
                    continue
                roster = side_data.get("rosterForMatchupPeriod", {})
                for entry in roster.get("entries", []):
                    player = entry.get("playerPoolEntry", {}).get("player", {})
                    for s in player.get("stats", []):
                        if s.get("statSourceId") == 0:
                            gs_totals[team_id] += int(float(s.get("stats", {}).get("33", 0)))
                            break
    return dict(gs_totals)


# Bench and IL lineup slot IDs (excluded from position scoring)
BENCH_IL_SLOTS = {16, 17}


def fetch_position_scores(req, espn_periods, all_sps_map, team_abbrev_map):
    """
    Fetches position scores using actual lineup slots from daily rosters (mRoster view).
    For each scoring period (day) in the matchup week, gets each team's roster with
    real lineup slot assignments and credits the day's score to that slot's position.

    Returns {team_abbrev: {pos_name: score}}.
    """
    position_scores = defaultdict(lambda: defaultdict(float))

    for espn_period in espn_periods:
        scoring_periods = all_sps_map.get(espn_period, [])
        for sp in scoring_periods:
            data = req.league_get(
                params={"view": "mRoster", "scoringPeriodId": sp},
            )
            for team in data.get("teams", []):
                team_id = team["id"]
                abbrev = team_abbrev_map.get(team_id, str(team_id))
                for entry in team.get("roster", {}).get("entries", []):
                    slot_id = entry.get("lineupSlotId")
                    if slot_id in BENCH_IL_SLOTS:
                        continue
                    pos_name = LINEUP_SLOT_MAP.get(slot_id)
                    if not pos_name:
                        continue
                    # Get this player's score for this specific scoring period
                    player = entry["playerPoolEntry"]["player"]
                    day_score = 0.0
                    for stat in player.get("stats", []):
                        if stat.get("scoringPeriodId") == sp and stat.get("statSplitTypeId") == 5:
                            day_score = stat.get("appliedTotal", 0.0)
                            break
                    position_scores[abbrev][pos_name] += day_score

    return {
        team: {pos: round(score, 2) for pos, score in slots.items()}
        for team, slots in position_scores.items()
    }


def main():
    league = League(league_id=LEAGUE_ID, year=SEASON_YEAR, espn_s2=ESPN_S2, swid=SWID)

    if len(league.teams) == 0:
        raise RuntimeError("No teams found in league — check ESPN credentials or league ID.")

    num_teams = len(league.teams)
    req = league.espn_request

    # Load week config
    espn_to_matchup = load_week_config(WEEK_CONFIG_PATH, TOTAL_WEEKS)
    total_matchup_weeks = max(espn_to_matchup)
    matchup_to_espn = defaultdict(list)
    for idx, mw in enumerate(espn_to_matchup):
        matchup_to_espn[mw].append(idx + 1)
    current_espn_week = min(league.current_week, TOTAL_WEEKS)
    current_matchup_week = espn_to_matchup[current_espn_week - 1]

    # Build team lookup keyed by team_id
    team_data = {}
    for team in league.teams:
        team_data[team.team_id] = {
            "team_id": team.team_id,
            "team_name": team.team_name,
            "team_abbrev": team.team_abbrev,
            "wins": team.wins,
            "losses": team.losses,
            "scores_by_week": [None] * total_matchup_weeks,
            "ranking_points_by_week": [None] * total_matchup_weeks,
            "cumulative_points_by_week": [None] * total_matchup_weeks,
            "normalized_by_week": [None] * total_matchup_weeks,
            "gs_by_week": [None] * total_matchup_weeks,
        }

    team_abbrev_map = {tid: tdata["team_abbrev"] for tid, tdata in team_data.items()}

    # Pass 1: Collect raw ESPN scores into matchup-week accumulators
    raw_scores = defaultdict(lambda: defaultdict(float))  # mw -> {team_id: summed score}
    raw_espn_week_scores = {}  # espn_week -> {team_id: score}

    for espn_week in range(1, current_espn_week + 1):
        mw = espn_to_matchup[espn_week - 1]
        matchups = league.scoreboard(espn_week)
        wk_scores = {}
        for matchup in matchups:
            home_id = matchup.home_team.team_id
            away_id = matchup.away_team.team_id
            if home_id in team_data:
                raw_scores[mw][home_id] += matchup.home_final_score
                wk_scores[home_id] = matchup.home_final_score
            if away_id in team_data:
                raw_scores[mw][away_id] += matchup.away_final_score
                wk_scores[away_id] = matchup.away_final_score
        raw_espn_week_scores[espn_week] = wk_scores

    # Recalculate current_matchup_week based on last MW with any non-zero scores
    # (ESPN's current_week counter can run ahead of actual scored data)
    last_scored_mw = 0
    for mw in range(1, current_matchup_week + 1):
        if any(s > 0 for s in raw_scores[mw].values()):
            last_scored_mw = mw
    current_matchup_week = last_scored_mw or 1

    # Pass 2: Compute ranking points, cumulative, normalized per matchup week
    cumulative = {tid: 0.0 for tid in team_data}
    for mw in range(1, current_matchup_week + 1):
        mw_idx = mw - 1
        scores_this_mw = dict(raw_scores[mw])
        if not scores_this_mw:
            continue
        for tid, score in scores_this_mw.items():
            team_data[tid]["scores_by_week"][mw_idx] = round(score, 2)
        ranking_pts = assign_ranking_points(scores_this_mw, num_teams)
        for tid, pts in ranking_pts.items():
            team_data[tid]["ranking_points_by_week"][mw_idx] = pts
            cumulative[tid] += pts
            team_data[tid]["cumulative_points_by_week"][mw_idx] = cumulative[tid]
        sorted_cumulative = sorted(cumulative.values(), reverse=True)
        cutoff_value = sorted_cumulative[PLAYOFF_CUTOFF - 1]
        for tid in team_data:
            team_data[tid]["normalized_by_week"][mw_idx] = round(
                cumulative[tid] - cutoff_value, 4
            )

    # Add total_score per team
    for tid in team_data:
        team_data[tid]["total_score"] = round(
            sum(s for s in team_data[tid]["scores_by_week"] if s is not None), 2
        )

    # Fetch top players + position scores per matchup week
    print("Fetching player scores per matchup week...")
    espn_period_sp_map, all_sps_map = build_espn_period_scoring_map(req)
    top_players_by_week = []
    position_scores_by_week = []
    team_id_set = set(team_data.keys())
    for mw in range(1, current_matchup_week + 1):
        espn_periods = matchup_to_espn[mw]
        top = fetch_top_players(req, espn_periods, espn_period_sp_map, team_abbrev_map)
        pos_scores = fetch_position_scores(req, espn_periods, all_sps_map, team_abbrev_map)
        gs_totals = fetch_gs_per_week(req, espn_periods, espn_period_sp_map, team_id_set)
        top_players_by_week.append(top)
        position_scores_by_week.append(pos_scores)
        for tid, gs in gs_totals.items():
            team_data[tid]["gs_by_week"][mw - 1] = gs
        leader = top["all"][0] if top["all"] else None
        print(f"  MW {mw}: {leader['name']} ({leader['score']}) leads" if leader else f"  MW {mw}: no data")

    output = {
        "metadata": {
            "league_id": LEAGUE_ID,
            "season_year": SEASON_YEAR,
            "num_teams": num_teams,
            "total_weeks": TOTAL_WEEKS,
            "playoff_cutoff": PLAYOFF_CUTOFF,
            "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "current_week": current_espn_week,
            "total_matchup_weeks": total_matchup_weeks,
            "current_matchup_week": current_matchup_week,
            "espn_to_matchup": espn_to_matchup,
        },
        "teams": list(team_data.values()),
        "espn_week_scores": {
            str(wk): {str(tid): score for tid, score in scores.items()}
            for wk, scores in raw_espn_week_scores.items()
        },
        "top_players_by_week": top_players_by_week,
        "position_scores_by_week": position_scores_by_week,
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(output, f, indent=2)

    print(f"Wrote {OUTPUT_PATH} (through ESPN week {current_espn_week} / matchup week {current_matchup_week})")


if __name__ == "__main__":
    main()
