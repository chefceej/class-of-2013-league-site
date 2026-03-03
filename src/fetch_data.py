import os
import json
from datetime import datetime, timezone

# espn_api uses an outdated base URL; patch it before importing League
import espn_api.requests.espn_requests as _espn_req
_espn_req.FANTASY_BASE_ENDPOINT = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/"

from espn_api.baseball import League

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


def main():
    league = League(league_id=LEAGUE_ID, year=SEASON_YEAR, espn_s2=ESPN_S2, swid=SWID)

    if len(league.teams) == 0:
        raise RuntimeError("No teams found in league — check ESPN credentials or league ID.")

    num_teams = len(league.teams)
    current_week = min(league.current_week, TOTAL_WEEKS)

    # Build team lookup keyed by team_id
    team_data = {}
    for team in league.teams:
        team_data[team.team_id] = {
            "team_id": team.team_id,
            "team_name": team.team_name,
            "team_abbrev": team.team_abbrev,
            "wins": team.wins,
            "losses": team.losses,
            "scores_by_week": [None] * TOTAL_WEEKS,
            "ranking_points_by_week": [None] * TOTAL_WEEKS,
            "cumulative_points_by_week": [None] * TOTAL_WEEKS,
            "normalized_by_week": [None] * TOTAL_WEEKS,
        }

    # Fetch weekly scores and compute rankings
    cumulative = {tid: 0.0 for tid in team_data}

    for week in range(1, current_week + 1):
        week_idx = week - 1
        matchups = league.scoreboard(week)

        scores_this_week = {}
        for matchup in matchups:
            home_id = matchup.home_team.team_id
            away_id = matchup.away_team.team_id
            if home_id in team_data:
                scores_this_week[home_id] = matchup.home_final_score
                team_data[home_id]["scores_by_week"][week_idx] = matchup.home_final_score
            if away_id in team_data:
                scores_this_week[away_id] = matchup.away_final_score
                team_data[away_id]["scores_by_week"][week_idx] = matchup.away_final_score

        if not scores_this_week:
            continue

        ranking_pts = assign_ranking_points(scores_this_week, num_teams)
        for tid, pts in ranking_pts.items():
            team_data[tid]["ranking_points_by_week"][week_idx] = pts
            cumulative[tid] += pts
            team_data[tid]["cumulative_points_by_week"][week_idx] = cumulative[tid]

        # Normalize: sorted cumulative values, 6th place (index 5) = 0
        sorted_cumulative = sorted(cumulative.values(), reverse=True)
        cutoff_value = sorted_cumulative[PLAYOFF_CUTOFF - 1]
        for tid in team_data:
            team_data[tid]["normalized_by_week"][week_idx] = round(
                cumulative[tid] - cutoff_value, 4
            )

    output = {
        "metadata": {
            "league_id": LEAGUE_ID,
            "season_year": SEASON_YEAR,
            "num_teams": num_teams,
            "total_weeks": TOTAL_WEEKS,
            "playoff_cutoff": PLAYOFF_CUTOFF,
            "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "current_week": current_week,
        },
        "teams": list(team_data.values()),
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(output, f, indent=2)

    print(f"Wrote {OUTPUT_PATH} (through week {current_week})")


if __name__ == "__main__":
    main()
