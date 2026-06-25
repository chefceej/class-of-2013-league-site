"""
Bulk-reliever finder.

Walks the full season's scoring periods for current free-agent / waiver
RP-eligible pitchers, reconstructs each pitcher's per-appearance log
(date, innings, fantasy points, started-flag) entirely from ESPN daily
splits, and derives:

  - per-inning value (total fantasy pts / total relief IP)
  - bulk tendency (share of relief outings of 1.1-3.0 IP)
  - over-3.0-IP outings (these flip to a "start" in our league)
  - appearance cadence (avg rest between outings, days since last, due?)

No MLB Stats API needed: outs (stat 34) and appliedTotal both come back on
the statSourceId=0 / statSplitTypeId=5 daily split when you request a past
scoringPeriodId.
"""

import os
import json
import statistics
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from collections import defaultdict

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
ET = ZoneInfo("America/New_York")
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "relievers_data.json")

RP_SLOT = 15           # RP lineup slot
STAT_OUTS = "34"       # outs recorded (IP = outs / 3)
STAT_GS = "33"         # games started

# Shortlist qualification (tunable)
MIN_APPEARANCES = 8    # enough sample for rate + cadence
MIN_BULK_RATE = 0.50   # majority of outings are multi-inning 1.1-3.0


def fetch_fa_rp_daily(league, current_sp):
    """
    For every current FA/waiver RP-eligible pitcher, collect every daily
    split across the season. Returns:
      logs:  {name: [ {date, outs, ip, pts, gs}, ... ]}
      meta:  {name: {mlb_team, eligible}}
    """
    logs = defaultdict(list)
    meta = {}

    base_filter = {
        "players": {
            "filterStatus": {"value": ["FREEAGENT", "WAIVERS"]},
            "filterSlotIds": {"value": [RP_SLOT]},
            "limit": 350,
            "sortPercOwned": {"sortPriority": 1, "sortAsc": False},
        }
    }

    for sp in range(1, current_sp + 1):
        params = {"view": "kona_player_info", "scoringPeriodId": sp}
        headers = {"x-fantasy-filter": json.dumps(base_filter)}
        try:
            data = league.espn_request.league_get(params=params, headers=headers)
        except Exception as e:
            print(f"  Warning: SP {sp} fetch failed: {e}")
            continue

        day_date = (datetime.now(ET).date() + timedelta(days=sp - current_sp)).strftime("%Y-%m-%d")
        hits = 0
        for pe in data.get("players", []):
            p = pe.get("player", {})
            name = p.get("fullName", "")
            if not name:
                continue
            if name not in meta:
                meta[name] = {
                    "mlb_team": PRO_TEAM_MAP.get(p.get("proTeamId"), "?"),
                    "eligible": p.get("eligibleSlots", []),
                }
            for s in p.get("stats", []):
                if (s.get("statSourceId") == 0
                        and s.get("statSplitTypeId") == 5
                        and s.get("scoringPeriodId") == sp):
                    st = s.get("stats") or {}
                    outs = int(float(st.get(STAT_OUTS, 0) or 0))
                    if outs <= 0:
                        break
                    logs[name].append({
                        "date": day_date,
                        "outs": outs,
                        "ip": round(outs / 3, 2),
                        "pts": round(s.get("appliedTotal", 0.0), 1),
                        "gs": int(float(st.get(STAT_GS, 0) or 0)),
                    })
                    hits += 1
                    break
        print(f"  SP {sp:>3} ({day_date}): {hits} appearances")

    return dict(logs), meta


def analyze(logs, meta, today):
    out = []
    for name, log in logs.items():
        log.sort(key=lambda a: a["date"])
        relief = [a for a in log if a["gs"] == 0]
        gs_apps = [a for a in log if a["gs"] > 0]
        n = len(relief)
        if n == 0:
            continue

        total_outs = sum(a["outs"] for a in relief)
        total_ip = total_outs / 3
        total_pts = sum(a["pts"] for a in relief)
        avg_ip = total_ip / n
        pts_per_ip = total_pts / total_ip if total_ip else 0.0
        bulk = [a for a in relief if 4 <= a["outs"] <= 9]        # 1.1-3.0 IP
        over3 = [a for a in relief if a["outs"] >= 10]            # >3.0 IP -> counts as a start
        bulk_rate = len(bulk) / n

        # Recent role: if the 3 most recent appearances are all >3.0 IP
        # (outs >= 10), the pitcher has moved into a starting role — exclude.
        recent3 = log[-3:]
        recent_ip = [a["ip"] for a in recent3]
        likely_starter = len(recent3) >= 3 and all(a["outs"] >= 10 for a in recent3)

        # Cadence across ALL appearances (relief + any spot starts)
        dates = sorted({a["date"] for a in log})
        gaps = []
        for i in range(1, len(dates)):
            d0 = datetime.strptime(dates[i - 1], "%Y-%m-%d").date()
            d1 = datetime.strptime(dates[i], "%Y-%m-%d").date()
            gaps.append((d1 - d0).days)
        avg_rest = round(statistics.mean(gaps), 1) if gaps else None
        med_rest = round(statistics.median(gaps)) if gaps else None
        last_date = datetime.strptime(dates[-1], "%Y-%m-%d").date()
        days_since = (today - last_date).days
        cadence = med_rest if med_rest else (round(avg_rest) if avg_rest else None)
        projected_next = (last_date + timedelta(days=cadence)).strftime("%Y-%m-%d") if cadence else None

        # Status: rested (pitched within cadence), due (at/just past cadence),
        # stale (well past cadence -> likely IL/optioned)
        if cadence is None:
            status = "unknown"
        elif days_since < cadence:
            status = "rested"
        elif days_since <= cadence + 2:
            status = "due"
        else:
            status = "stale"

        out.append({
            "name": name,
            "mlb_team": meta.get(name, {}).get("mlb_team", "?"),
            "appearances": n,
            "gs_count": len(gs_apps),
            "total_ip": round(total_ip, 1),
            "total_pts": round(total_pts, 1),
            "pts_per_ip": round(pts_per_ip, 2),
            "avg_ip": round(avg_ip, 2),
            "bulk_count": len(bulk),
            "bulk_rate": round(bulk_rate, 2),
            "over3_count": len(over3),
            "recent_ip": recent_ip,
            "likely_starter": likely_starter,
            "avg_rest": avg_rest,
            "med_rest": med_rest,
            "last_date": dates[-1],
            "days_since": days_since,
            "projected_next": projected_next,
            "status": status,
        })
    return out


def qualifies(r):
    """True bulk reliever: frequent multi-inning work, rarely over 3.0 IP,
    not a current starter, and currently active (not stale)."""
    return (
        r["appearances"] >= MIN_APPEARANCES
        and r["bulk_rate"] >= MIN_BULK_RATE
        and r["over3_count"] <= 2
        and r["avg_ip"] <= 2.6
        and not r["likely_starter"]
        and r["status"] != "stale"
    )


def main():
    today = datetime.now(ET).date()
    league = League(league_id=LEAGUE_ID, year=SEASON_YEAR, espn_s2=ESPN_S2, swid=SWID)
    current_sp = league.current_week
    print(f"Today {today} · current scoringPeriodId {current_sp}")
    print("Walking season scoring periods for FA/waiver RPs...")

    logs, meta = fetch_fa_rp_daily(league, current_sp)
    print(f"\nCollected appearance logs for {len(logs)} pitchers")

    rows = analyze(logs, meta, today)
    shortlist = [r for r in rows if qualifies(r)]
    # Due first, then by value
    order = {"due": 0, "rested": 1, "unknown": 2}
    shortlist.sort(key=lambda r: (order.get(r["status"], 3), -r["pts_per_ip"]))

    # Trim to the simple UI shape: name, status, days since last, pts/ip
    relievers = [
        {
            "name": r["name"],
            "mlb_team": r["mlb_team"],
            "status": r["status"],
            "days_since": r["days_since"],
            "pts_per_ip": r["pts_per_ip"],
        }
        for r in shortlist
    ]

    print(f"\n{'='*64}")
    print(f"BULK RELIEVERS  (FA/waiver, >={MIN_APPEARANCES} app, bulk-rate>={MIN_BULK_RATE}, not a current starter)")
    print(f"{'='*64}")
    hdr = f"{'Pitcher':22} {'Tm':4} {'Status':>7} {'Last':>5} {'Pts/IP':>6}"
    print(hdr)
    print("-" * len(hdr))
    for r in relievers:
        print(f"{r['name'][:22]:22} {r['mlb_team']:4} {r['status']:>7} "
              f"{str(r['days_since'])+'d':>5} {r['pts_per_ip']:>6.2f}")
    print(f"\n{len(relievers)} bulk relievers of {len(rows)} FA RPs analyzed.")
    excluded = [r for r in rows if r["likely_starter"] and r["appearances"] >= MIN_APPEARANCES and r["bulk_rate"] >= MIN_BULK_RATE]
    if excluded:
        print("Excluded as current starters (last 3 all >3.0 IP): "
              + ", ".join(r["name"] for r in excluded))

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    payload = {
        "metadata": {
            "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "today": today.strftime("%Y-%m-%d"),
            "current_sp": current_sp,
            "season_year": SEASON_YEAR,
            "start_limit": START_LIMIT,
            "qualify": {"min_app": MIN_APPEARANCES, "min_bulk_rate": MIN_BULK_RATE},
        },
        "relievers": relievers,
    }
    with open(OUTPUT_PATH, "w") as f:
        json.dump(payload, f, indent=2)
    print(f"Wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
