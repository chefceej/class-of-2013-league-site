import os
import json
from collections import defaultdict
from datetime import datetime, timezone

# espn_api uses an outdated base URL; patch it before importing League
import espn_api.requests.espn_requests as _espn_req
_espn_req.FANTASY_BASE_ENDPOINT = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/"

from espn_api.baseball import League
from espn_api.baseball.constant import PRO_TEAM_MAP

# Auth: env vars take priority, fall back to hardcoded session cookies
ESPN_S2 = os.environ.get(
    "ESPN_S2",
    "AEBR5IPlQxSuwODQSQyHmqvsTZBzAWqXT70wHw0WbL2nOagMjCXjcaRORLDvAGyLqx1tUpLx3D22mg%2BEK2Ie2YUNDGAWUe1bsdXxOoyf1BGI5NqdoH7lSg3le1hsb3tGv%2FzOTnOrG2Te%2Bv98sWz5dkK6F4dagCJy9bHeQ4bk9QZMnrs0QeK0m1CkWwdZBoy9X0IyC5%2BZ3lVPHBbI4JvZR%2F3021eKy2XalfIxsGKu0LAy169kYxGj005s3faA5XLKHLFm25RYnAZZCicarYzJt09k9FUzhkgwgmY9I1XQn4RjKQ%3D%3D",
)
SWID = os.environ.get("SWID", "{EEFDF804-ED17-4981-BDF8-04ED173981C0}")

LEAGUE_ID = 37734
SEASON_YEAR = 2025
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
    Returns {espn_matchup_period_id: last_scoring_period_in_that_week}.
    Used to select the right scoringPeriodId when fetching rosterForMatchupPeriod.
    """
    data = req.league_get(params={"view": "mMatchup"})
    period_map = {}
    for matchup in data["schedule"]:
        period_id = matchup["matchupPeriodId"]
        for side in ["home", "away"]:
            if side in matchup and "pointsByScoringPeriod" in matchup[side]:
                last_sp = max(int(sp) for sp in matchup[side]["pointsByScoringPeriod"])
                if period_id not in period_map or last_sp > period_map[period_id]:
                    period_map[period_id] = last_sp
    return period_map


def fetch_top_players(req, espn_periods, espn_period_sp_map, team_abbrev_map, top_n=10):
    """
    Fetches top N active players by fantasy score across all ESPN matchup periods
    that make up one custom matchup week. Sums scores across periods for merged weeks.

    espn_periods: list of ESPN matchup period IDs (e.g. [1, 2] for a merged week)
    espn_period_sp_map: {espn_period_id: scoring_period_id}
    team_abbrev_map: {team_id: team_abbrev}
    """
    player_totals = {}  # player_id -> {name, mlb_team, fantasy_team, score}

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
                    if pid in player_totals:
                        player_totals[pid]["score"] += score
                    else:
                        player_totals[pid] = {
                            "name": p["fullName"],
                            "mlb_team": PRO_TEAM_MAP.get(p["proTeamId"], "?"),
                            "fantasy_team": fantasy_team,
                            "score": score,
                        }

    players = list(player_totals.values())
    players.sort(key=lambda x: x["score"], reverse=True)
    for p in players:
        p["score"] = round(p["score"], 2)
    return players[:top_n]


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

    # Fetch top players per matchup week
    print("Fetching player scores per matchup week...")
    espn_period_sp_map = build_espn_period_scoring_map(req)
    top_players_by_week = []
    for mw in range(1, current_matchup_week + 1):
        espn_periods = matchup_to_espn[mw]
        top = fetch_top_players(req, espn_periods, espn_period_sp_map, team_abbrev_map)
        top_players_by_week.append(top)
        print(f"  MW {mw}: {top[0]['name']} ({top[0]['score']}) leads" if top else f"  MW {mw}: no data")

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
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(output, f, indent=2)

    print(f"Wrote {OUTPUT_PATH} (through ESPN week {current_espn_week} / matchup week {current_matchup_week})")


if __name__ == "__main__":
    main()
