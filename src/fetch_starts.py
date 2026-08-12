import os
import json
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
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
START_LIMIT = 8
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "starts_data.json")
MLB_API = "https://statsapi.mlb.com/api/v1"
ESPN_SCHEDULE_URL = f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/flb/seasons/{SEASON_YEAR}?view=proTeamSchedules_wl"

# MLB Stats API abbreviation → ESPN PRO_TEAM_MAP abbreviation
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
    """Return (start, end) as date objects for the current Mon-Sun fantasy week."""
    today = datetime.now(ET).date()
    start = today - timedelta(days=today.weekday())  # Monday
    end = start + timedelta(days=6)                  # Sunday
    return start, end


def fetch_espn_pro_schedule():
    """Fetch the ESPN pro game schedule and return {game_id: {date, home_team_id, away_team_id}}."""
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
    """Return {pro_team_id: {date_str: (opponent_id, home_bool)}} from the pro schedule."""
    sched = defaultdict(dict)
    for g in game_lookup.values():
        d = g["date"]
        home_id = g["home_team_id"]
        away_id = g["away_team_id"]
        # first game of a doubleheader wins the slot; a team starts one pitcher/day anyway
        sched[home_id].setdefault(d, (away_id, True))
        sched[away_id].setdefault(d, (home_id, False))
    return sched


def project_rotation(anchor_date_str, pro_team_id, team_sched, horizon_end_str,
                     existing_dates, cadence=5, max_starts=6):
    """
    Estimate a starter's future start dates by rolling their rotation turn forward.

    From the anchor (their last known start), step `cadence` days at a time and snap to
    the team's nearest actually-scheduled game day (within +/-2 days). Skips dates that
    already have a real (probable/confirmed) start. Returns a list of date strings.
    """
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


def fetch_daily_pitcher_points(league, week_start, today_date):
    """
    Fetch per-day fantasy points for all rostered pitchers on past days of the week.
    Returns {player_full_name: {date_str: points}}.
    """
    today_sp = league.current_week
    pitcher_slot_ids = {13, 14, 15}
    daily_points = defaultdict(dict)

    d = week_start
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


def fetch_espn_starters(league, game_lookup, week_start, week_end, today_date):
    """
    Use ESPN's starterStatusByProGame from rosters to get probable/starting pitchers.
    Also attaches `points` to past starts (game already played).

    Returns:
      rostered: {fantasy_team_abbrev: {pitcher_name: [start_info, ...]}}
      fa_starters: {pitcher_name: [start_info, ...]}  (free agents with starts)
      fa_player_info: {pitcher_name: {mlb_team, pro_team_id}}
      pitcher_pro_team: {pitcher_name: pro_team_id}  (rostered SPs, for rotation projection)
    """
    start_str = week_start.strftime("%Y-%m-%d")
    end_str = week_end.strftime("%Y-%m-%d")
    today_str = today_date.strftime("%Y-%m-%d")

    # Fetch actual daily points for past days in this week
    daily_points_map = fetch_daily_pitcher_points(league, week_start, today_date)

    # Get rostered players with starterStatusByProGame
    data = league.espn_request.league_get(params={"view": "mRoster"})
    team_map = {t.team_id: t.team_abbrev for t in league.teams}

    rostered = defaultdict(lambda: defaultdict(list))
    pitcher_pro_team = {}
    pitcher_slot_ids = {13, 14, 15}  # P, SP, RP

    for team_data in data.get("teams", []):
        abbrev = team_map.get(team_data.get("id"), "?")
        for entry in team_data.get("roster", {}).get("entries", []):
            player = entry.get("playerPoolEntry", {}).get("player", {})
            eligible = set(player.get("eligibleSlots", []))
            if not eligible & pitcher_slot_ids:
                continue

            name = player.get("fullName", "")
            pro_team_id = player.get("proTeamId", 0)
            mlb_team = PRO_TEAM_MAP.get(pro_team_id, "?")
            # Only SP-eligible arms get rotation projection (slot 14 = SP)
            if 14 in eligible and name:
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
                    opp_id = game["away_team_id"]
                    home = True
                else:
                    opp_id = game["home_team_id"]
                    home = False

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
                rostered[abbrev][name].append(start_entry)

    # Get free agent pitchers with starts
    fa_params = {
        "view": "kona_player_info",
        "scoringPeriodId": league.current_week,
    }
    fa_filters = {
        "players": {
            "filterStatus": {"value": ["FREEAGENT", "WAIVERS"]},
            "filterSlotIds": {"value": [14]},  # SP lineup slot
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
                opp_id = game["away_team_id"]
                home = True
            else:
                opp_id = game["home_team_id"]
                home = False

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

        # Store info even if no starts (for stats lookup)
        if name not in fa_player_info:
            fa_player_info[name] = {"mlb_team": mlb_team, "pro_team_id": pro_team_id}

    return rostered, fa_starters, fa_player_info, pitcher_pro_team


def fetch_free_agent_stats(league):
    """
    Returns {player_name: {name, mlb_team, season_pts, gs, pts_per_gs, pr30_pts}}
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
    """Returns {team_id: abbreviation} for all active MLB teams."""
    data = mlb_get(f"/teams?sportId=1&season={SEASON_YEAR}")
    return {
        t["id"]: t.get("abbreviation", "?")
        for t in data.get("teams", [])
    }


def fetch_team_ops_date_range(week_end, team_id_map, days):
    """Returns {espn_team_abbrev: ops_float} for the trailing N days ending on week_end."""
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


def fetch_team_ops_30d(week_end, team_id_map):
    return fetch_team_ops_date_range(week_end, team_id_map, 30)


def fetch_team_split_factors(team_id_map):
    """
    Fetch season-long h/a/vl/vr OPS and overall season OPS per team.
    Returns {espn_team_abbrev: {h, a, vl, vr, overall}} where each value is OPS float.
    """
    factors = defaultdict(dict)
    # Splits: home, away, vs LHP, vs RHP
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
    # Season overall OPS
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
    """Returns {pitcher_full_name: 'L'|'R'} for all MLB pitchers this season."""
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
    """
    Compute split-adjusted OPS using multiplicative model:
      split_ops = trailing_45d × (vs_hand_OPS / overall_OPS) × (location_OPS / overall_OPS)
    Returns float OPS or None if data missing.
    """
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
        return base  # fall back to plain 45d
    return round(base * (hand_ops / overall) * (loc_ops / overall), 3)


def find_current_matchup_period(league):
    """Determine the current matchup period from schedule data.

    league.current_week is the scoringPeriodId (day number), not the
    matchup period. This function finds which matchupPeriodId contains
    the current scoring period.
    """
    data = league.espn_request.league_get(params={"view": "mMatchup"})
    current_sp = league.current_week

    for matchup in data.get("schedule", []):
        for side in ("home", "away"):
            if side not in matchup:
                continue
            pbsp = matchup[side].get("pointsByScoringPeriod", {})
            if str(current_sp) in pbsp or current_sp in pbsp:
                return matchup["matchupPeriodId"]

    # Current scoring period not found — likely start of a new matchup week
    # before any games have been played. Find the lowest matchup period
    # that has no scoring data yet (i.e. the new week).
    periods_with_data = set()
    all_periods = set()
    for matchup in data.get("schedule", []):
        all_periods.add(matchup["matchupPeriodId"])
        for side in ("home", "away"):
            if side not in matchup:
                continue
            if matchup[side].get("pointsByScoringPeriod"):
                periods_with_data.add(matchup["matchupPeriodId"])

    periods_without_data = all_periods - periods_with_data
    if periods_without_data:
        return min(periods_without_data)

    # All periods have data — return the highest
    return max(all_periods) if all_periods else 1


def fetch_actual_gs(league, matchup_period):
    """Fetch actual GS (games started) per fantasy team for the given matchup period."""
    filters = {
        "schedule": {
            "filterMatchupPeriodIds": {"value": [matchup_period]}
        }
    }
    headers = {"x-fantasy-filter": json.dumps(filters)}

    # Need a valid scoringPeriodId for this matchup period to get roster data
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
        print(f"  Warning: no scoring period found for matchup period {matchup_period}")
        return {}

    data = league.espn_request.league_get(
        params={"view": ["mMatchupScore", "mScoreboard"], "scoringPeriodId": sp_for_period},
        headers=headers,
    )

    team_map = {t.team_id: t.team_abbrev for t in league.teams}
    team_gs = {}

    for matchup in data.get("schedule", []):
        if matchup.get("matchupPeriodId") != matchup_period:
            continue
        for side in ("home", "away"):
            team_data = matchup.get(side)
            if not team_data:
                continue
            abbrev = team_map.get(team_data.get("teamId"), "?")
            gs = 0
            roster = team_data.get("rosterForMatchupPeriod", {})
            for entry in roster.get("entries", []):
                player = entry.get("playerPoolEntry", {}).get("player", {})
                for s in player.get("stats", []):
                    if s.get("statSourceId") == 0:  # actual stats
                        gs += int(float(s.get("stats", {}).get("33", 0)))
                        break
            team_gs[abbrev] = gs

    return team_gs


def main():
    week_start, week_end = current_week_dates()
    week2_start = week_end + timedelta(days=1)
    week2_end = week2_start + timedelta(days=6)
    today_date = datetime.now(ET).date()
    print(f"Week 1: {week_start} → {week_end}")
    print(f"Week 2: {week2_start} → {week2_end} (rotation-projected)")

    print("Fetching ESPN pro game schedule...")
    game_lookup = fetch_espn_pro_schedule()
    print(f"  Got {len(game_lookup)} games in schedule")
    team_sched = build_team_schedule(game_lookup)

    print("Fetching MLB team info...")
    team_id_map = fetch_mlb_teams()
    print(f"  Got {len(team_id_map)} MLB teams")

    print("Fetching team OPS (last 30 days)...")
    team_ops = fetch_team_ops_30d(week_end, team_id_map)
    print(f"  Got OPS for {len(team_ops)} MLB teams")

    print("Fetching team OPS (last 45 days) for split mode...")
    team_ops_45d = fetch_team_ops_date_range(week_end, team_id_map, 45)
    print(f"  Got 45d OPS for {len(team_ops_45d)} MLB teams")

    print("Fetching season split factors (h/a/vL/vR/overall)...")
    split_factors = fetch_team_split_factors(team_id_map)
    print(f"  Got split factors for {len(split_factors)} MLB teams")

    print("Fetching MLB pitcher handedness...")
    pitcher_hands = fetch_pitcher_hands()
    print(f"  Got handedness for {len(pitcher_hands)} pitchers")

    print("Fetching ESPN rosters + probable starters + daily scores...")
    league = League(league_id=LEAGUE_ID, year=SEASON_YEAR, espn_s2=ESPN_S2, swid=SWID)
    # Widen the real-probable window to cover both weeks (ESPN only flags ~5 days out,
    # so week 2 is mostly empty here and gets filled by rotation projection below).
    rostered_starts, fa_starters, fa_player_info, pitcher_pro_team = fetch_espn_starters(
        league, game_lookup, week_start, week2_end, today_date
    )
    rostered_count = sum(
        sum(len(starts) for starts in pitchers.values())
        for pitchers in rostered_starts.values()
    )
    print(f"  Found {rostered_count} rostered starts, {sum(len(s) for s in fa_starters.values())} FA starts")

    print("Fetching actual games started from ESPN...")
    matchup_period = find_current_matchup_period(league)
    print(f"  Current matchup period: {matchup_period} (scoringPeriodId={league.current_week})")
    actual_gs = fetch_actual_gs(league, matchup_period)
    print(f"  Got actual GS for {len(actual_gs)} teams: {actual_gs}")

    print("Fetching free agent pitcher stats...")
    fa_stats = fetch_free_agent_stats(league)
    print(f"  Got stats for {len(fa_stats)} free agent pitchers")

    # Build per-week date lists
    def date_range(a, b):
        out, d = [], a
        while d <= b:
            out.append(d.strftime("%Y-%m-%d"))
            d += timedelta(days=1)
        return out

    dates = date_range(week_start, week_end)          # week 1
    dates2 = date_range(week2_start, week2_end)        # week 2 (projected)
    week2_end_str = week2_end.strftime("%Y-%m-%d")

    # Rotation projection: fill week 2 (and any un-flagged tail) for each rostered SP.
    # Anchor from the pitcher's last known real start, then roll their turn forward.
    proj_count = 0
    for abbrev, pitchers in rostered_starts.items():
        for name, starts in pitchers.items():
            pro_team_id = pitcher_pro_team.get(name)
            if pro_team_id is None or not starts:
                continue
            existing_dates = {s["date"] for s in starts}
            anchor = max(existing_dates)
            for pdate in project_rotation(anchor, pro_team_id, team_sched,
                                          week2_end_str, existing_dates):
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
    print(f"  Projected {proj_count} week-2 rotation starts")

    # Add opponent OPS (30d standard + split-adjusted) to start info
    def annotate(name, starts):
        hand = pitcher_hands.get(name)
        for s in starts:
            s["opponent_ops"] = team_ops.get(s["opponent"])
            opp_is_home = not s["home"]
            split = compute_split_ops(
                s["opponent"], opp_is_home, hand, team_ops_45d, split_factors
            )
            if split is not None:
                s["opponent_ops_split"] = split
            if hand:
                s["pitcher_hand"] = hand

    for abbrev, pitchers in rostered_starts.items():
        for name, starts in pitchers.items():
            annotate(name, starts)

    for name, starts in fa_starters.items():
        annotate(name, starts)

    # Structure rostered output
    output_teams = {}
    for fantasy_team, pitcher_map in rostered_starts.items():
        output_teams[fantasy_team] = [
            {
                "name": name,
                "mlb_team": starts[0]["mlb_team"] if starts else "?",
                "starts": sorted(starts, key=lambda s: s["date"]),
            }
            for name, starts in sorted(pitcher_map.items())
        ]

    # Include teams with no starts this week
    all_team_abbrevs = {t.team_abbrev for t in league.teams}
    for abbrev in all_team_abbrevs:
        if abbrev not in output_teams:
            output_teams[abbrev] = []

    # Build streaming options (FA pitchers with starts + stats)
    streaming_options = []
    for pitcher_name, starts in sorted(fa_starters.items()):
        stats = fa_stats.get(pitcher_name, {})
        streaming_options.append({
            "name": pitcher_name,
            "mlb_team": starts[0]["mlb_team"] if starts else stats.get("mlb_team", "?"),
            "season_pts": stats.get("season_pts", 0),
            "gs": stats.get("gs", 0),
            "pts_per_gs": stats.get("pts_per_gs", 0),
            "pr30_pts": stats.get("pr30_pts"),
            "starts": sorted(starts, key=lambda s: s["date"]),
        })
    streaming_options.sort(key=lambda x: x["pts_per_gs"], reverse=True)

    output = {
        "metadata": {
            "week_start": week_start.strftime("%Y-%m-%d"),
            "week_end": week_end.strftime("%Y-%m-%d"),
            "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "start_limit": START_LIMIT,
        },
        "weeks": [
            {
                "label": "Week 1",
                "week_start": week_start.strftime("%Y-%m-%d"),
                "week_end": week_end.strftime("%Y-%m-%d"),
                "dates": dates,
                "projected": False,
            },
            {
                "label": "Week 2",
                "week_start": week2_start.strftime("%Y-%m-%d"),
                "week_end": week2_end.strftime("%Y-%m-%d"),
                "dates": dates2,
                "projected": True,
            },
        ],
        "dates": dates,
        "team_ops_30d": team_ops,
        "fantasy_teams": output_teams,
        "actual_gs": actual_gs,
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
