# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This project has two components:
1. A legacy ESPN → Google Sheets pipeline (`src/main.py`)
2. A static website (`docs/`) showing cumulative standings points normalized so 6th place = 0, deployed to GitHub Pages and refreshed daily via GitHub Actions

## Running the Scripts

```bash
# Fetch ESPN data → docs/data/league_data.json (no Google Sheets)
python src/fetch_data.py

# Serve the site locally (fetch() requires a server, not file://)
python -m http.server 8080 --directory docs/
# Open http://localhost:8080

# Legacy: fetches scores + exports to Google Sheets
python src/main.py

# Legacy test/print-only script
python src/score_testint.py
```

Dependencies for `fetch_data.py`: `espn_api` only.
Dependencies for `main.py`: `espn_api`, `gspread`, `oauth2client`.

## Architecture

**`src/main.py`** — The primary script. It:
1. Authenticates with Google Sheets via a service account key at `credentials/sheetsapijsonkey.json`
2. Authenticates with ESPN using hardcoded `espn_s2` and `swid` session cookies for the private league (`league_id=37734`, `year=2025`)
3. Loops weeks 1–19, calls `league.scoreboard(week)` to get matchups, and collects home/away team names, abbreviations, and final scores
4. Clears and rewrites the `scores_import` worksheet in the "2025 League Standings" Google Sheet starting at cell A1

**`src/score_testint.py`** — An older/testing version that fetches the same data (2023 season) but only prints to stdout; no Google Sheets integration.

**`credentials/sheetsapijsonkey.json`** — Google Service Account JSON key. Required for Google Sheets writes. Path is hardcoded in `main.py`.

**`src/fetch_data.py`** — NEW primary fetch script. ESPN → `docs/data/league_data.json`. Reads `ESPN_S2` / `SWID` from env vars, falls back to hardcoded cookies. Computes ranking points (12→1 per week, ties averaged), cumulative totals, and normalization where 6th place = 0.

**`docs/`** — GitHub Pages root. `index.html` + `css/styles.css` + `js/charts.js` render the playoff position chart and standings table from `docs/data/league_data.json`.

**`.github/workflows/update_data.yml`** — Runs `fetch_data.py` daily at 7 AM UTC and commits updated JSON.

**`.github/workflows/deploy_pages.yml`** — Deploys `docs/` to GitHub Pages via an Actions workflow (repo Pages `build_type: workflow`, NOT the legacy branch builder). Triggers on `workflow_run` after "Update League Data" finishes (its bot-token commit doesn't fire a `push` event) and on direct `push` to main touching `docs/**`. Deploys take ~20s. Do not use the old `gh api --method POST .../pages/builds` force-rebuild — the legacy builder is disabled.

**`data/`** — Currently empty; likely intended for local data caching.

## Key Configuration

- **ESPN League ID**: `37734`
- **Season year**: `2025` (in `main.py`), `2023` (in `score_testint.py`)
- **Weeks per season**: 19 (hardcoded as `range(1, 20)`)
- **Target Google Sheet**: `"2025 League Standings"` → worksheet `"scores_import"`
- **ESPN auth**: `espn_s2` and `swid` cookies are hardcoded in the script — update these when session cookies expire
- **Credentials path**: `/Users/connorkraus/Documents/FantasyCodeProject/credentials/sheetsapijsonkey.json` (absolute path hardcoded)

## GitHub Pages Setup

1. Repo Settings → Pages → Source: **GitHub Actions** (build_type `workflow`). Publishing is handled by `deploy_pages.yml`, not a branch/folder source. (Was previously `main` branch `/docs` via the legacy builder, which hung repeatedly — migrated 2026-08-12.)
2. Settings → Secrets → Add `ESPN_S2` and `SWID` (copy from `src/main.py` or browser cookies)
3. Run `python src/fetch_data.py` locally to generate initial JSON, commit it
4. Trigger workflow manually in Actions tab to verify

## Changelog Maintenance (REQUIRED before commit/push)

Whenever a session makes user-visible changes (UI, new features, bug fixes, behavior changes), update `docs/changelog.html` **before** the final commit. Internal-only refactors, dep bumps, or data refreshes do not need entries.

**Versioning rule — consolidate by session:**
- All changes from a single conversation/session go into ONE version entry.
- If the most recent `<article class="version">` was authored in the same session, **append** new `<li>` items to it instead of creating a new version block. (Today's date in the `<time>` tag is the signal — if it's today and you wrote it, append.)
- If the most recent entry is from a previous session/day, create a new `<article class="version">` at the top with bumped semver:
  - **MAJOR** (`v3.0.0`) — breaking redesign or removed page
  - **MINOR** (`v2.5.0`) — new feature/page (most common)
  - **PATCH** (`v2.4.1`) — fix-only or small tweak session

**Tag classes:** `feat` (NEW), `improve` (UPD), `fix` (FIX) — pick the one that best matches the change. Keep each `<li>` to one short sentence focused on user impact, not implementation.

## ESPN Cookie Maintenance

`espn_s2` and `swid` expire periodically. When expired, Actions will fail or produce empty JSON.
Refresh: ESPN Fantasy in browser → DevTools → Application → Cookies → copy `espn_s2` and `SWID` → update GitHub Secrets and hardcoded fallbacks in `src/fetch_data.py`.
