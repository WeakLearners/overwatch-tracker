# OW2 Match Tracker

Personal Overwatch 2 performance tracker with pre-match advisor, hero stats, and trend analysis.

## Starting the app

Two terminals from the project root (`/Users/Sean/Code/overwatch`):

```bash
# Terminal 1 — backend (port 3001)
node --experimental-sqlite -r tsx/cjs server/src/index.ts

# Terminal 2 — frontend (port 5173)
cd client && npx vite
```

Open **http://localhost:5173**

## Importing match history

If you update the source spreadsheet, re-run the migration to rebuild the database:

```bash
python3 scripts/migrate.py
```

## Stack

- **Frontend** — React, TypeScript, Vite, Tailwind, Recharts
- **Backend** — Express, TypeScript, node:sqlite (built-in, no native addons)
- **Data** — SQLite at `data/overwatch.db`

## Pages

| Page | What it does |
|---|---|
| Dashboard | Overview stats, rolling win rate chart, recent matches |
| Pre-Match | Map voting selector, hero recommendation, session health, tilt alert |
| Heroes | Per-hero cards — win rate, best/worst maps, best/worst mode, career sparkline |
| Maps | Win rates by map |
| Timing | Win rates by hour and day of week |
| Trends | Rolling win rate chart, momentum, hero/map/mode trajectories |
| Log Match | Log a match with death reason tagging |
