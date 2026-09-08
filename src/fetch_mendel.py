"""
Championship start planner — single-team, 14-day continuous view.

Builds docs/data/mendel_starts_data.json for ONE fantasy team
("I'm Ben F'n Mendel", teamId 12) in league 435298, covering the current
2-week championship matchup as one continuous 14-day window.

Week 1 = real ESPN probable starters (with points on days already played).
Week 2 = rotation-projected turns (ESPN only flags ~5-6 days out).
Streaming options = free-agent SPs with a real probable start in the window.

Start cap: this league limits Games Started to 12 per weekly matchup
(lineupSlotStatLimits statId 33 = 1.714/day * 7). The championship spans two
matchup weeks, so the whole-championship pool is 24, with a 12 ceiling per week.
"""

import os
import json
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from collections import defaultdict

# espn_api patch — use the read replica endpoint
import espn_api.requests.espn_requests as _espn_req
_espn_req.FANTASY_BASE_ENDPOINT = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/"

from espn_api.baseball import League
from espn_api.baseball.constant import PRO_TEAM_MAP

ESPN_S2 = os.environ.get(
    "ESPN_S2",
    "AEBR5IPlQxSuwODQSQyHmqvsTZBzAWqXT70wHw0WbL2nOagMjCXjcaRORLDvAGyLqx1tUpLx3D22mg%2BEK2Ie2YUNDGAWUe1bsdXxOoyf1BGI5NqdoH7lSg3le1hsb3tGv%2FzOTnOrG2Te%2Bv98sWz5dkK6F4dagCJy9bHeQ4bk9QZMnrs0QeK0m1CkWwdZBoy9X0IyC5%2BZ3lVPHBbI4JvZR%2F3021eKy2XalfIxsGKu0LAy169kYxGj005s3faA5XLKHLFm25RYnAZZCicarYzJt09k9FUzhkgwgmY9I1XQn4RjKQ%3D%3D",
)
SWID = os.environ.get("SWID", "{EEFDF804-ED17-4981-BDF8-04ED173981C0}")

LEAGUE_ID = 435298
TEAM_ID = 12
SEASON_YEAR = 2026
START_LIMIT_WEEK = 12       # per-week GS cap for this league
START_LIMIT_TOTAL = 24      # whole 2-week championship pool
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "mendel_starts_data.json")
MLB_API = "https://statsapi.mlb.com/api/v1"
ESPN_SCHEDULE_URL = f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/flb/seasons/{SEASON_YEAR}?view=proTeamSchedules_wl"

ET = ZoneInfo("America/New_York")

MLB_TO_ESPN_ABBREV = {
    "ATH": "Oak", "ATL": "Atl", "AZ": "Ari", "BAL": "Bal", "BOS": "Bos",
    "CHC": "ChC", "CIN": "Cin", "CLE": "Cle", "COL": "Col", "CWS": "ChW",
    "DET": "Det", "HOU": "Hou", "KC": "KC", "LAA": "LAA", "LAD": "LAD",
    "MIA": "Mia", "MIL": "Mil", "MIN": "Min", "NYM": "NYM", "NYY": "NYY",
    "OAK": "Oak", "PHI": "Phi", "PIT": "Pit", "SD": "SD", "SEA": "Sea",
    "SF": "SF", "STL": "StL", "TB": "TB", "TEX": "Tex", "TOR": "Tor",
    "WSH": "Wsh",
}


def mlb_get(path):
    url = MLB_API + path
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def current_week_dates():
    """Return (start, end) date objects for the current Mon-Sun fantasy week."""
    today = datetime.now(ET).date()
    start = today - timedelta(days=today.weekday())  # Monday
    end = start + timedelta(days=6)                  # Sunday
    return start, end


def fetch_espn_pro_schedule():
    """{game_id: {date, home_team_id, away_team_id}} from ESPN's pro schedule."""
    headers = {
        "User-Agent": "Mozilla/5.0",
        "Cookie": f"espn_s2={ESPN_S2}; SWID={SWID}",
    }
    req = urllib.request.Request(ESPN_SCHEDULE_URL, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.loads(r.read())

    game_lookup = {}
    for pt in data.get("settings", {}).get("proTeams", []):
        for sp, games in pt.get("proGamesByScoringPeriod", {}).items():
            for game in games:
                gid = game["id"]
                if gid not in game_lookup:
                    dt = datetime.fromtimestamp(game["date"] / 1000, tz=timezone.utc).astimezone(ET)
                    game_lookup[gid] = {
                        "date": dt.strftime("%Y-%m-%d"),
                        "home_team_id": game["homeProTeamId"],
                        "away_team_id": game["awayProTeamId"],
                    }
    return game_lookup


def build_team_schedule(game_lookup):
    """{pro_team_id: {date_str: (opponent_id, home_bool)}}."""
    sched = defaultdict(dict)
    for g in game_lookup.values():
        d = g["date"]
        home_id = g["home_team_id"]
        away_id = g["away_team_id"]
        sched[home_id].setdefault(d, (away_id, True))
        sched[away_id].setdefault(d, (home_id, False))
    return sched


def project_rotation(anchor_date_str, pro_team_id, team_sched, horizon_end_str,
                     existing_dates, cadence=5, max_starts=6):
    """Roll a starter's rotation turn forward, snapping to real team game days."""
    def parse(s):
        return datetime.strptime(s, "%Y-%m-%d").date()

    games = team_sched.get(pro_team_id, {})
    if not games:
        return []

    anchor = parse(anchor_date_str)
    end = parse(horizon_end_str)
    last = anchor
    target = anchor + timedelta(days=cadence)
    projected = []
    guard = 0
    while target <= end and len(projected) < max_starts and guard < 60:
        guard += 1
        best = None
        for off in (0, 1, -1, 2, -2):
            cand = target + timedelta(days=off)
            if cand <= last or cand > end:
                continue
            if cand.strftime("%Y-%m-%d") in games:
                best = cand
                break
        if best is None:
            target += timedelta(days=1)
            continue
        bs = best.strftime("%Y-%m-%d")
        if bs not in existing_dates:
            projected.append(bs)
        last = best
        target = best + timedelta(days=cadence)
    return projected


def fetch_daily_pitcher_points(league, window_start, today_date):
    """{player_full_name: {date_str: points}} for past days in the window."""
    today_sp = league.current_week
    pitcher_slot_ids = {13, 14, 15}
    daily_points = defaultdict(dict)

    d = window_start
    while d < today_date:
        sp = today_sp + (d - today_date).days
        if sp < 1:
            d += timedelta(days=1)
            continue
        date_str = d.strftime("%Y-%m-%d")
        try:
            data = league.espn_request.league_get(
                params={"view": "mRoster", "scoringPeriodId": sp}
            )
            for team_data in data.get("teams", []):
                for entry in team_data.get("roster", {}).get("entries", []):
                    player = entry.get("playerPoolEntry", {}).get("player", {})
                    eligible = set(player.get("eligibleSlots", []))
                    if not eligible & pitcher_slot_ids:
                        continue
                    name = player.get("fullName", "")
                    if not name:
                        continue
                    for s in player.get("stats", []):
                        if (s.get("statSourceId") == 0
                                and s.get("statSplitTypeId") == 5
                                and s.get("scoringPeriodId") == sp):
                            pts = round(s.get("appliedTotal", 0.0), 1)
                            if pts != 0.0:
                                daily_points[name][date_str] = pts
                            break
        except Exception as e:
            print(f"  Warning: could not fetch roster for SP {sp} ({date_str}): {e}")
        d += timedelta(days=1)

    return dict(daily_points)


def fetch_starters(league, game_lookup, window_start, window_end, today_date):
    """
    Probable/starting pitchers within the window.

    Returns:
      team_pitchers: {pitcher_name: [start_info, ...]}   (TEAM_ID only)
      fa_starters:   {pitcher_name: [start_info, ...]}    (free agents)
      fa_player_info:{pitcher_name: {mlb_team, pro_team_id}}
      pitcher_pro_team: {pitcher_name: pro_team_id}       (team SPs, for projection)
    """
    start_str = window_start.strftime("%Y-%m-%d")
    end_str = window_end.strftime("%Y-%m-%d")
    today_str = today_date.strftime("%Y-%m-%d")

    daily_points_map = fetch_daily_pitcher_points(league, window_start, today_date)

    data = league.espn_request.league_get(params={"view": "mRoster"})

    team_pitchers = defaultdict(list)
    pitcher_pro_team = {}
    pitcher_slot_ids = {13, 14, 15}

    for team_data in data.get("teams", []):
        if team_data.get("id") != TEAM_ID:
            continue
        for entry in team_data.get("roster", {}).get("entries", []):
            player = entry.get("playerPoolEntry", {}).get("player", {})
            eligible = set(player.get("eligibleSlots", []))
            if not eligible & pitcher_slot_ids:
                continue

            name = player.get("fullName", "")
            pro_team_id = player.get("proTeamId", 0)
            mlb_team = PRO_TEAM_MAP.get(pro_team_id, "?")
            if 14 in eligible and name:  # SP-eligible → gets rotation projection
                pitcher_pro_team[name] = pro_team_id
            starter_map = player.get("starterStatusByProGame", {})

            for gid_str, status in starter_map.items():
                if status not in ("PROBABLE", "STARTING"):
                    continue
                game = game_lookup.get(int(gid_str))
                if not game:
                    continue
                if not (start_str <= game["date"] <= end_str):
                    continue

                if game["home_team_id"] == pro_team_id:
                    opp_id, home = game["away_team_id"], True
                else:
                    opp_id, home = game["home_team_id"], False

                start_entry = {
                    "date": game["date"],
                    "mlb_team": mlb_team,
                    "opponent": PRO_TEAM_MAP.get(opp_id, "?"),
                    "home": home,
                }
                if game["date"] < today_str:
                    pts = daily_points_map.get(name, {}).get(game["date"])
                    if pts is not None:
                        start_entry["points"] = pts
                team_pitchers[name].append(start_entry)

    # Free agent SPs with starts (streaming pool)
    fa_params = {"view": "kona_player_info", "scoringPeriodId": league.current_week}
    fa_filters = {
        "players": {
            "filterStatus": {"value": ["FREEAGENT", "WAIVERS"]},
            "filterSlotIds": {"value": [14]},
            "limit": 200,
            "sortPercOwned": {"sortPriority": 1, "sortAsc": False},
        }
    }
    fa_headers = {"x-fantasy-filter": json.dumps(fa_filters)}
    fa_data = league.espn_request.league_get(params=fa_params, headers=fa_headers)

    fa_starters = defaultdict(list)
    fa_player_info = {}

    for fa_entry in fa_data.get("players", []):
        player = fa_entry.get("player", {})
        name = player.get("fullName", "")
        if not name:
            continue
        pro_team_id = player.get("proTeamId", 0)
        mlb_team = PRO_TEAM_MAP.get(pro_team_id, "?")
        starter_map = player.get("starterStatusByProGame", {})

        for gid_str, status in starter_map.items():
            if status not in ("PROBABLE", "STARTING"):
                continue
            game = game_lookup.get(int(gid_str))
            if not game:
                continue
            if not (start_str <= game["date"] <= end_str):
                continue

            if game["home_team_id"] == pro_team_id:
                opp_id, home = game["away_team_id"], True
            else:
                opp_id, home = game["home_team_id"], False

            start_entry = {
                "date": game["date"],
                "mlb_team": mlb_team,
                "opponent": PRO_TEAM_MAP.get(opp_id, "?"),
                "home": home,
            }
            if game["date"] < today_str:
                pts = daily_points_map.get(name, {}).get(game["date"])
                if pts is not None:
                    start_entry["points"] = pts
            fa_starters[name].append(start_entry)
            fa_player_info[name] = {"mlb_team": mlb_team, "pro_team_id": pro_team_id}

        if name not in fa_player_info:
            fa_player_info[name] = {"mlb_team": mlb_team, "pro_team_id": pro_team_id}

    return dict(team_pitchers), dict(fa_starters), fa_player_info, pitcher_pro_team


def fetch_free_agent_stats(league):
    """{name: {name, mlb_team, season_pts, gs, pts_per_gs, pr30_pts}} for FA SPs."""
    params = {"view": "kona_player_info", "scoringPeriodId": league.current_week}
    filters = {
        "players": {
            "filterStatus": {"value": ["FREEAGENT", "WAIVERS"]},
            "filterSlotIds": {"value": [14]},
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

        season_pts = 0.0
        season_gs = 0
        pr30_pts = None
        for s in player.get("stats", []):
            src = s.get("statSourceId", -1)
            st = s.get("statSplitTypeId", -1)
            if src != 0 or s.get("seasonId") != SEASON_YEAR:
                continue
            if st == 0:
                total = s.get("appliedTotal", 0)
                gs = int(s.get("stats", {}).get("33", 0))
                if total > season_pts:
                    season_pts = total
                    season_gs = gs
            elif st == 3:
                pr30_pts = round(s.get("appliedTotal", 0), 2)

        pts_per_gs = round(season_pts / season_gs, 2) if season_gs > 0 else 0.0
        fa_stats[name] = {
            "name": name,
            "mlb_team": mlb_team,
            "season_pts": round(season_pts, 2),
            "gs": season_gs,
            "pts_per_gs": pts_per_gs,
            "pr30_pts": pr30_pts,
        }
    return fa_stats


def fetch_mlb_teams():
    data = mlb_get(f"/teams?sportId=1&season={SEASON_YEAR}")
    return {t["id"]: t.get("abbreviation", "?") for t in data.get("teams", [])}


def fetch_team_ops_date_range(week_end, team_id_map, days):
    end_str = week_end.strftime("%Y-%m-%d")
    start_str = (week_end - timedelta(days=days)).strftime("%Y-%m-%d")
    try:
        data = mlb_get(
            f"/teams/stats?season={SEASON_YEAR}&stats=byDateRange"
            f"&startDate={start_str}&endDate={end_str}&group=hitting&gameType=R&sportId=1"
        )
        ops_map = {}
        for entry in data.get("stats", [{}])[0].get("splits", []):
            team_id = entry.get("team", {}).get("id")
            mlb_abbrev = team_id_map.get(team_id, "?")
            espn_abbrev = MLB_TO_ESPN_ABBREV.get(mlb_abbrev)
            ops = entry.get("stat", {}).get("ops")
            if espn_abbrev and ops is not None:
                ops_map[espn_abbrev] = round(float(ops), 3)
        return ops_map
    except Exception as e:
        print(f"  Warning: could not fetch trailing-{days}d team OPS — {e}")
        return {}


def fetch_team_split_factors(team_id_map):
    factors = defaultdict(dict)
    try:
        data = mlb_get(
            f"/teams/stats?stats=statSplits&group=hitting&season={SEASON_YEAR}"
            f"&sportId=1&sitCodes=h,a,vl,vr&limit=200"
        )
        for entry in data.get("stats", [{}])[0].get("splits", []):
            team_id = entry.get("team", {}).get("id")
            mlb_abbrev = team_id_map.get(team_id, "?")
            espn_abbrev = MLB_TO_ESPN_ABBREV.get(mlb_abbrev)
            if not espn_abbrev:
                continue
            code = entry.get("split", {}).get("code")
            ops = entry.get("stat", {}).get("ops")
            if code and ops is not None:
                factors[espn_abbrev][code] = float(ops)
    except Exception as e:
        print(f"  Warning: could not fetch team split OPS — {e}")
    try:
        data = mlb_get(
            f"/teams/stats?stats=season&group=hitting&season={SEASON_YEAR}&sportId=1&limit=50"
        )
        for entry in data.get("stats", [{}])[0].get("splits", []):
            team_id = entry.get("team", {}).get("id")
            mlb_abbrev = team_id_map.get(team_id, "?")
            espn_abbrev = MLB_TO_ESPN_ABBREV.get(mlb_abbrev)
            ops = entry.get("stat", {}).get("ops")
            if espn_abbrev and ops is not None:
                factors[espn_abbrev]["overall"] = float(ops)
    except Exception as e:
        print(f"  Warning: could not fetch season overall OPS — {e}")
    return dict(factors)


def fetch_pitcher_hands():
    try:
        data = mlb_get(f"/sports/1/players?season={SEASON_YEAR}")
        hands = {}
        for p in data.get("people", []):
            if p.get("primaryPosition", {}).get("type") != "Pitcher":
                continue
            name = p.get("fullName", "").strip()
            hand = p.get("pitchHand", {}).get("code")
            if name and hand:
                hands[name] = hand
        return hands
    except Exception as e:
        print(f"  Warning: could not fetch pitcher handedness — {e}")
        return {}


def compute_split_ops(opponent, opponent_is_home, pitcher_hand, ops_45d, factors):
    base = ops_45d.get(opponent)
    f = factors.get(opponent)
    if base is None or not f:
        return None
    overall = f.get("overall")
    if not overall:
        return None
    hand_code = "vl" if pitcher_hand == "L" else "vr" if pitcher_hand == "R" else None
    loc_code = "h" if opponent_is_home else "a"
    hand_ops = f.get(hand_code)
    loc_ops = f.get(loc_code)
    if hand_ops is None or loc_ops is None:
        return base
    return round(base * (hand_ops / overall) * (loc_ops / overall), 3)


def find_matchup_period_for_sp(schedule, target_sp):
    """Which matchupPeriodId contains the given scoringPeriodId."""
    for matchup in schedule:
        for side in ("home", "away"):
            if side not in matchup:
                continue
            pbsp = matchup[side].get("pointsByScoringPeriod", {})
            if str(target_sp) in pbsp or target_sp in pbsp:
                return matchup["matchupPeriodId"]
    return None


def fetch_team_gs_for_period(league, matchup_period):
    """Games started by TEAM_ID during the given matchup period (0 if none yet)."""
    if matchup_period is None:
        return 0
    matchup_data = league.espn_request.league_get(params={"view": "mMatchup"})
    sp_for_period = None
    for matchup in matchup_data.get("schedule", []):
        if matchup["matchupPeriodId"] != matchup_period:
            continue
        for side in ("home", "away"):
            if side not in matchup:
                continue
            pbsp = matchup[side].get("pointsByScoringPeriod", {})
            if pbsp:
                sp_for_period = max(int(k) for k in pbsp)
                break
        if sp_for_period:
            break
    if not sp_for_period:
        return 0

    filters = {"schedule": {"filterMatchupPeriodIds": {"value": [matchup_period]}}}
    headers = {"x-fantasy-filter": json.dumps(filters)}
    data = league.espn_request.league_get(
        params={"view": ["mMatchupScore", "mScoreboard"], "scoringPeriodId": sp_for_period},
        headers=headers,
    )
    for matchup in data.get("schedule", []):
        if matchup.get("matchupPeriodId") != matchup_period:
            continue
        for side in ("home", "away"):
            team_data = matchup.get(side)
            if not team_data or team_data.get("teamId") != TEAM_ID:
                continue
            gs = 0
            for entry in team_data.get("rosterForMatchupPeriod", {}).get("entries", []):
                player = entry.get("playerPoolEntry", {}).get("player", {})
                for s in player.get("stats", []):
                    if s.get("statSourceId") == 0:
                        gs += int(float(s.get("stats", {}).get("33", 0)))
                        break
            return gs
    return 0


def main():
    w1_start, w1_end = current_week_dates()
    w2_start = w1_end + timedelta(days=1)
    w2_end = w2_start + timedelta(days=6)
    today_date = datetime.now(ET).date()
    print(f"Championship window: {w1_start} → {w2_end} (14 continuous days)")

    print("Fetching ESPN pro game schedule...")
    game_lookup = fetch_espn_pro_schedule()
    print(f"  Got {len(game_lookup)} games")
    team_sched = build_team_schedule(game_lookup)

    print("Fetching MLB team info...")
    team_id_map = fetch_mlb_teams()

    print("Fetching team OPS (30d / 45d) + split factors + handedness...")
    team_ops = fetch_team_ops_date_range(w1_end, team_id_map, 30)
    team_ops_45d = fetch_team_ops_date_range(w1_end, team_id_map, 45)
    split_factors = fetch_team_split_factors(team_id_map)
    pitcher_hands = fetch_pitcher_hands()

    print("Fetching ESPN rosters + probables + daily scores...")
    league = League(league_id=LEAGUE_ID, year=SEASON_YEAR, espn_s2=ESPN_S2, swid=SWID)
    team_map = {t.team_id: (t.team_abbrev, t.team_name) for t in league.teams}
    team_abbrev, team_name = team_map.get(TEAM_ID, ("?", "?"))

    team_pitchers, fa_starters, fa_player_info, pitcher_pro_team = fetch_starters(
        league, game_lookup, w1_start, w2_end, today_date
    )
    print(f"  {team_name}: {len(team_pitchers)} SPs with probables, "
          f"{sum(len(s) for s in fa_starters.values())} FA starts")

    print("Fetching actual GS for the two championship weeks...")
    schedule = league.espn_request.league_get(params={"view": "mMatchup"}).get("schedule", [])
    cur_sp = league.current_week
    mp1 = find_matchup_period_for_sp(schedule, cur_sp)
    gs_w1 = fetch_team_gs_for_period(league, mp1)
    gs_w2 = fetch_team_gs_for_period(league, (mp1 + 1) if mp1 else None)
    print(f"  Week 1 (mp {mp1}) GS used: {gs_w1} · Week 2 GS used: {gs_w2}")

    print("Fetching free agent pitcher stats...")
    fa_stats = fetch_free_agent_stats(league)

    def date_range(a, b):
        out, d = [], a
        while d <= b:
            out.append(d.strftime("%Y-%m-%d"))
            d += timedelta(days=1)
        return out

    dates_w1 = date_range(w1_start, w1_end)
    dates_w2 = date_range(w2_start, w2_end)
    dates_all = date_range(w1_start, w2_end)
    w2_end_str = w2_end.strftime("%Y-%m-%d")

    # Rotation projection: fill the back of the window for each team SP.
    proj_count = 0
    for name, starts in team_pitchers.items():
        pro_team_id = pitcher_pro_team.get(name)
        if pro_team_id is None or not starts:
            continue
        existing_dates = {s["date"] for s in starts}
        anchor = max(existing_dates)
        for pdate in project_rotation(anchor, pro_team_id, team_sched, w2_end_str, existing_dates):
            game = team_sched.get(pro_team_id, {}).get(pdate)
            if not game:
                continue
            opp_id, home = game
            starts.append({
                "date": pdate,
                "mlb_team": PRO_TEAM_MAP.get(pro_team_id, "?"),
                "opponent": PRO_TEAM_MAP.get(opp_id, "?"),
                "home": home,
                "projected": True,
            })
            proj_count += 1
    print(f"  Projected {proj_count} rotation starts across the window")

    def annotate(name, starts):
        hand = pitcher_hands.get(name)
        for s in starts:
            s["opponent_ops"] = team_ops.get(s["opponent"])
            opp_is_home = not s["home"]
            split = compute_split_ops(s["opponent"], opp_is_home, hand, team_ops_45d, split_factors)
            if split is not None:
                s["opponent_ops_split"] = split
            if hand:
                s["pitcher_hand"] = hand

    for name, starts in team_pitchers.items():
        annotate(name, starts)
    for name, starts in fa_starters.items():
        annotate(name, starts)

    pitchers_out = [
        {
            "name": name,
            "mlb_team": starts[0]["mlb_team"] if starts else "?",
            "starts": sorted(starts, key=lambda s: s["date"]),
        }
        for name, starts in sorted(team_pitchers.items())
        if starts
    ]

    # Streaming options: FA SPs with a real start anywhere in the 14-day window.
    win_set = set(dates_all)
    streaming_options = []
    for pitcher_name, starts in sorted(fa_starters.items()):
        win_starts = [s for s in starts if s["date"] in win_set]
        if not win_starts:
            continue
        stats = fa_stats.get(pitcher_name, {})
        streaming_options.append({
            "name": pitcher_name,
            "mlb_team": win_starts[0]["mlb_team"],
            "season_pts": stats.get("season_pts", 0),
            "gs": stats.get("gs", 0),
            "pts_per_gs": stats.get("pts_per_gs", 0),
            "pr30_pts": stats.get("pr30_pts"),
            "starts": sorted(win_starts, key=lambda s: s["date"]),
        })
    streaming_options.sort(key=lambda x: x["pts_per_gs"], reverse=True)

    output = {
        "metadata": {
            "team_id": TEAM_ID,
            "team_name": team_name,
            "team_abbrev": team_abbrev,
            "league_id": LEAGUE_ID,
            "season": SEASON_YEAR,
            "window_start": w1_start.strftime("%Y-%m-%d"),
            "window_end": w2_end.strftime("%Y-%m-%d"),
            "today": today_date.strftime("%Y-%m-%d"),
            "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "start_limit_week": START_LIMIT_WEEK,
            "start_limit_total": START_LIMIT_TOTAL,
        },
        "weeks": [
            {"label": "Week 1", "week_start": w1_start.strftime("%Y-%m-%d"),
             "week_end": w1_end.strftime("%Y-%m-%d"), "dates": dates_w1,
             "projected": False, "gs_used": gs_w1},
            {"label": "Week 2", "week_start": w2_start.strftime("%Y-%m-%d"),
             "week_end": w2_end.strftime("%Y-%m-%d"), "dates": dates_w2,
             "projected": True, "gs_used": gs_w2},
        ],
        "dates": dates_all,
        "team_ops_30d": team_ops,
        "pitchers": pitchers_out,
        "streaming_options": streaming_options,
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(output, f, indent=2)

    print(f"Wrote {OUTPUT_PATH}")
    total = sum(len(p["starts"]) for p in pitchers_out)
    print(f"  {len(pitchers_out)} pitchers, {total} starts in window")
    print(f"  Streaming: {len(streaming_options)} FA SPs")


if __name__ == "__main__":
    main()
