import os
import json
import urllib.request
from datetime import datetime, timedelta, timezone
from collections import defaultdict

# espn_api patch
import espn_api.requests.espn_requests as _espn_req
_espn_req.FANTASY_BASE_ENDPOINT = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/"

from espn_api.baseball import League
from espn_api.baseball.constant import PRO_TEAM_MAP

ESPN_S2 = os.environ.get(
    "ESPN_S2",
    "AEBR5IPlQxSuwODQSQyHmqvsTZBzAWqXT70wHw0WbL2nOagMjCXjcaRORLDvAGyLqx1tUpLx3D22mg%2BEK2Ie2YUNDGAWUe1bsdXxOoyf1BGI5NqdoH7lSg3le1hsb3tGv%2FzOTnOrG2Te%2Bv98sWz5dkK6F4dagCJy9bHeQ4bk9QZMnrs0QeK0m1CkWwdZBoy9X0IyC5%2BZ3lVPHBbI4JvZR%2F3021eKy2XalfIxsGKu0LAy169kYxGj005s3faA5XLKHLFm25RYnAZZCicarYzJt09k9FUzhkgwgmY9I1XQn4RjKQ%3D%3D",
)
SWID = os.environ.get("SWID", "{EEFDF804-ED17-4981-BDF8-04ED173981C0}")

LEAGUE_ID = 37734
SEASON_YEAR = 2026
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "starts_data.json")
MLB_API = "https://statsapi.mlb.com/api/v1"


def mlb_get(path):
    url = MLB_API + path
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def current_week_dates():
    """Return (start, end) as date objects for the current Mon–Sun fantasy week."""
    today = datetime.now(timezone.utc).date()
    start = today - timedelta(days=today.weekday())  # Monday
    end = start + timedelta(days=6)                  # Sunday
    return start, end


def fetch_probable_starters(week_start, week_end):
    """
    Returns {date_str: [{pitcher_name, mlb_team_abbrev, opponent_abbrev, home: bool}]}
    using MLB Stats API probable pitchers.
    """
    start_str = week_start.strftime("%Y-%m-%d")
    end_str = week_end.strftime("%Y-%m-%d")
    data = mlb_get(
        f"/schedule?sportId=1&startDate={start_str}&endDate={end_str}"
        f"&hydrate=probablePitcher,team&gameType=R"
    )

    by_date = defaultdict(list)
    for date_entry in data.get("dates", []):
        date_str = date_entry["date"]
        for game in date_entry.get("games", []):
            home = game["teams"]["home"]
            away = game["teams"]["away"]
            home_abbrev = home["team"].get("abbreviation", "?")
            away_abbrev = away["team"].get("abbreviation", "?")

            for side, opponent in [("home", away_abbrev), ("away", home_abbrev)]:
                pitcher = game["teams"][side].get("probablePitcher")
                if pitcher:
                    by_date[date_str].append({
                        "name": pitcher["fullName"],
                        "mlb_team": game["teams"][side]["team"].get("abbreviation", "?"),
                        "opponent": opponent,
                        "home": side == "home",
                    })
    return by_date


def fetch_mlb_teams():
    """Returns {team_id: abbreviation} for all active MLB teams."""
    data = mlb_get(f"/teams?sportId=1&season={SEASON_YEAR}")
    return {
        t["id"]: t.get("abbreviation", "?")
        for t in data.get("teams", [])
    }


def fetch_team_ops_30d(week_end, team_id_map):
    """Returns {mlb_team_abbrev: ops_float} for the 30 days ending on week_end."""
    end_str = week_end.strftime("%Y-%m-%d")
    start_str = (week_end - timedelta(days=30)).strftime("%Y-%m-%d")
    try:
        data = mlb_get(
            f"/teams/stats?season={SEASON_YEAR}&stats=byDateRange"
            f"&startDate={start_str}&endDate={end_str}&group=hitting&gameType=R&sportId=1"
        )
        ops_map = {}
        for entry in data.get("stats", [{}])[0].get("splits", []):
            team_id = entry.get("team", {}).get("id")
            abbrev = team_id_map.get(team_id, "?")
            ops = entry.get("stat", {}).get("ops")
            if abbrev != "?" and ops is not None:
                ops_map[abbrev] = round(float(ops), 3)
        return ops_map
    except Exception as e:
        print(f"  Warning: could not fetch team OPS — {e}")
        return {}



def fetch_free_agent_stats(league):
    """
    Returns {normalized_name: {name, mlb_team, season_pts, gs, pts_per_gs, pr30_pts}}
    for free agent / waiver starting pitchers, using the raw ESPN API.
    """
    params = {
        "view": "kona_player_info",
        "scoringPeriodId": league.current_week,
    }
    filters = {
        "players": {
            "filterStatus": {"value": ["FREEAGENT", "WAIVERS"]},
            "filterSlotIds": {"value": [14]},  # SP lineup slot
            "limit": 200,
            "sortPercOwned": {"sortPriority": 1, "sortAsc": False},
        }
    }
    headers = {"x-fantasy-filter": json.dumps(filters)}
    data = league.espn_request.league_get(params=params, headers=headers)

    fa_stats = {}
    for entry in data.get("players", []):
        player = entry.get("player", {})
        name = player.get("fullName", "")
        if not name:
            continue
        mlb_team = PRO_TEAM_MAP.get(player.get("proTeamId"), "?")

        # Extract stats from raw stat entries (current season only)
        season_pts = 0.0
        season_gs = 0
        pr30_pts = None
        for s in player.get("stats", []):
            src = s.get("statSourceId", -1)
            st = s.get("statSplitTypeId", -1)
            if src != 0 or s.get("seasonId") != SEASON_YEAR:
                continue
            if st == 0:  # Season stats
                total = s.get("appliedTotal", 0)
                gs = int(s.get("stats", {}).get("33", 0))
                if total > season_pts:
                    season_pts = total
                    season_gs = gs
            elif st == 3:  # PR30 (last 30 days)
                pr30_pts = round(s.get("appliedTotal", 0), 2)

        pts_per_gs = round(season_pts / season_gs, 2) if season_gs > 0 else 0.0

        fa_stats[normalize_name(name)] = {
            "name": name,
            "mlb_team": mlb_team,
            "season_pts": round(season_pts, 2),
            "gs": season_gs,
            "pts_per_gs": pts_per_gs,
            "pr30_pts": pr30_pts,
        }
    return fa_stats


def normalize_name(name):
    """Lowercase, strip accents roughly, for fuzzy matching."""
    replacements = {"á": "a", "é": "e", "í": "i", "ó": "o", "ú": "u",
                    "ñ": "n", "ü": "u", "ä": "a", "ö": "o"}
    n = name.lower()
    for src, dst in replacements.items():
        n = n.replace(src, dst)
    return n


def main():
    week_start, week_end = current_week_dates()
    print(f"Week: {week_start} → {week_end}")

    print("Fetching probable starters from MLB Stats API...")
    probable_by_date = fetch_probable_starters(week_start, week_end)
    total_games = sum(len(v) for v in probable_by_date.values())
    print(f"  Found {total_games} probable pitcher slots across {len(probable_by_date)} days")

    print("Fetching MLB team info...")
    team_id_map = fetch_mlb_teams()
    print(f"  Got {len(team_id_map)} MLB teams")

    print("Fetching team OPS (last 30 days)...")
    team_ops = fetch_team_ops_30d(week_end, team_id_map)
    print(f"  Got OPS for {len(team_ops)} MLB teams")

    print("Fetching ESPN rosters...")
    league = League(league_id=LEAGUE_ID, year=SEASON_YEAR, espn_s2=ESPN_S2, swid=SWID)
    rosters = {}
    for team in league.teams:
        pitchers = []
        for player in team.roster:
            if player.eligibleSlots and any(
                pos in ["SP", "RP", "P"] for pos in player.eligibleSlots
            ):
                pitchers.append(player.name)
        rosters[team.team_abbrev] = pitchers
    print(f"  Got rosters for {len(rosters)} fantasy teams")

    print("Fetching free agent pitcher stats...")
    fa_stats = fetch_free_agent_stats(league)
    print(f"  Got stats for {len(fa_stats)} free agent pitchers")

    # Build a lookup: normalized pitcher name → fantasy team
    name_to_fantasy_team = {}
    for fantasy_team, pitchers in rosters.items():
        for name in pitchers:
            name_to_fantasy_team[normalize_name(name)] = fantasy_team

    # Build per-fantasy-team pitcher start schedule
    # fantasy_starts[fantasy_team][pitcher_name] = [{date, opponent, opponent_ops, home}]
    fantasy_starts = defaultdict(lambda: defaultdict(list))
    # Also track unrostered starters for streaming options
    streaming_starts = defaultdict(list)  # pitcher_name -> [start_info]

    dates = []
    d = week_start
    while d <= week_end:
        dates.append(d.strftime("%Y-%m-%d"))
        d += timedelta(days=1)

    for date_str, starters in probable_by_date.items():
        for starter in starters:
            norm = normalize_name(starter["name"])
            fantasy_team = name_to_fantasy_team.get(norm)
            start_info = {
                "date": date_str,
                "mlb_team": starter["mlb_team"],
                "opponent": starter["opponent"],
                "opponent_ops": team_ops.get(starter["opponent"]),
                "home": starter["home"],
            }
            if fantasy_team:
                fantasy_starts[fantasy_team][starter["name"]].append(start_info)
            elif norm in fa_stats:
                streaming_starts[starter["name"]].append(start_info)

    # Structure rostered output
    output_teams = {}
    for fantasy_team, pitcher_map in fantasy_starts.items():
        output_teams[fantasy_team] = [
            {
                "name": name,
                "mlb_team": starts[0]["mlb_team"] if starts else "?",
                "starts": sorted(starts, key=lambda s: s["date"]),
            }
            for name, starts in sorted(pitcher_map.items())
        ]

    # Also include teams with no starts this week
    for fantasy_team in rosters:
        if fantasy_team not in output_teams:
            output_teams[fantasy_team] = []

    # Build streaming options
    streaming_options = []
    for pitcher_name, starts in sorted(streaming_starts.items()):
        norm = normalize_name(pitcher_name)
        stats = fa_stats.get(norm, {})
        streaming_options.append({
            "name": pitcher_name,
            "mlb_team": starts[0]["mlb_team"] if starts else stats.get("mlb_team", "?"),
            "season_pts": stats.get("season_pts", 0),
            "gs": stats.get("gs", 0),
            "pts_per_gs": stats.get("pts_per_gs", 0),
            "pr30_pts": stats.get("pr30_pts"),
            "starts": sorted(starts, key=lambda s: s["date"]),
        })
    # Default sort by pts_per_gs descending
    streaming_options.sort(key=lambda x: x["pts_per_gs"], reverse=True)

    output = {
        "metadata": {
            "week_start": week_start.strftime("%Y-%m-%d"),
            "week_end": week_end.strftime("%Y-%m-%d"),
            "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        },
        "dates": dates,
        "team_ops_30d": team_ops,
        "fantasy_teams": output_teams,
        "streaming_options": streaming_options,
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(output, f, indent=2)

    print(f"Wrote {OUTPUT_PATH}")
    for ft, pitchers in sorted(output_teams.items()):
        total_starts = sum(len(p["starts"]) for p in pitchers)
        print(f"  {ft}: {len(pitchers)} pitchers, {total_starts} starts")
    stream_starts = sum(len(p["starts"]) for p in streaming_options)
    print(f"  Streaming: {len(streaming_options)} FA pitchers, {stream_starts} starts")


if __name__ == "__main__":
    main()
