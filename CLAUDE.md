# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Before searching for where a specific UI feature or API behavior lives, check `.claude/FEATURE-MAP.md` — it maps every visible feature to a grep-able anchor string, its file, and its backend dependency. Update the relevant row in the same commit whenever a feature is added, renamed, or moved.

Whenever a `data-inspect-id`/`dataInspectId` is added, removed, or renamed anywhere in `client/src/`, update `docs/overwatch-frontend-map.json` in the same change (add/remove/rename the matching entry under that file's node in `uiElements`). This file is the index the in-app element inspector (`client/src/debug/InspectorOverlay.tsx`) dynamically imports at runtime to resolve a clicked element to its label/description/locate-grep — an id missing from it silently breaks that element's inspector click (the hover highlight still works since that doesn't consult the map, which makes the failure easy to miss). Keep `locate.grep` anchored to a stable string in the element's JSX, not a line number.

Then run `python3 scripts/sync-frontend-map-html.py` in the same change. `docs/overwatch-frontend-map.html` is a second copy of that same map — a self-contained browser viewer with the JSON inlined as a `const DATA = {...}` literal — and it is what Sean actually clicks through. Never hand-edit it; the script rewrites the literal from the JSON, which is the only source of truth. `--check` reports drift without writing (exit 1), so it doubles as a pre-commit verification. This rule exists because the HTML previously fell two capture-model generations behind — still listing a deleted component and a retired death-capture UI — while the JSON stayed current.

## Commands

From the project root:

```bash
# Run both client and server concurrently (recommended)
npm run dev

# Or run individually:
node --experimental-sqlite -r tsx/cjs server/src/index.ts   # backend, port 3001
cd client && npx vite                                         # frontend, port 5173

# Rebuild SQLite DB from the Numbers spreadsheet
python3 scripts/migrate.py

# Re-inline docs/overwatch-frontend-map.json into the HTML map viewer
# (--check verifies without writing; exits 1 on drift)
python3 scripts/sync-frontend-map-html.py

# Type-check client
cd client && npx tsc --noEmit

# Type-check server
cd server && npx tsc --noEmit
```

There are no automated tests. Type checking is the primary correctness gate.

## Architecture

npm workspaces monorepo with two packages: `client/` and `server/`. The only inter-package coupling is the REST API and the hero/map roster (kept in sync manually — see below).

### Server (`server/src/`)

Express + TypeScript running on Node's built-in `node:sqlite` (no ORM, no native addons). Port 3001.

**`db/schema.ts`** — Singleton `DatabaseSync` connection. Schema is created in-process on first `getDb()` call. New columns are added via `PRAGMA table_info` check + `ALTER TABLE` — there are no migration files. The DB lives at `data/overwatch.db`.

Three route files:
- **`routes/matches.ts`** — CRUD for individual match records (`GET/POST /api/matches`, `PUT/DELETE /api/matches/:id`). `GET` supports filtering by hero, map, game_type, queue_mode, date range.
- **`routes/stats.ts`** — Read-only analytics endpoints (overview, by-hero, by-map, by-hour, by-day, trends, prematch, momentum, weekly, streaks, map-voting, hero-cards, hero-detail, map-detail, death-trends, death-segments, mode-comparison). All use a shared `whereClause()` helper that builds parameterized SQL from query params.
- **`routes/advisor.ts`** — LLM-powered pre-match advisor. Calls `claude-haiku-4-5` via the Anthropic SDK with a structured JSON output schema. Results are cached in the `advisor_cache` table (7-day TTL, keyed by `map + queue_mode`). Only the LLM insight and stretch pick are cached; death-axis stats are recomputed fresh on every request so they always reflect newly logged matches.

**Advisor logic flow:** comfort pool (≥ 20 career games in allowed roles) → `pickPrimary` (best map WR in pool, fallback to best career WR) → stretch candidates (played ≥ 3 times, not in comfort pool) → untested meta pool (never played) → LLM produces `insight` + `stretch` pick → cached.

**Death data has two formats stored in `matches.deaths` (JSON):**
- **v1 (legacy):** `{ reasons: { "reason": count }, total: N }` — subjective self-labels. Used by `deathInsights()`, `/death-trends`, `/death-segments`.
- **v2 (current):** `{ v: 2, deaths: [{ trade, timing, grouping, awareness }] }` — factual 4-axis records per death. Used exclusively by the advisor's `axisStats()`. The advisor deliberately ignores v1 rows.

### Client (`client/src/`)

React 18 + TypeScript + Vite + Tailwind CSS + Recharts. Port 5173.

**Single-page app.** All routes (`/`, `/prematch`, `/log`, `/trends`) render `<Dashboard>`. The route aliases exist only to keep any hardcoded links working.

**State management — React Context:**
- **`MatchContext`** — The core shared state: selected queue mode, selected map, advisor recommendation (`rec`), `pendingHero` (pre-fills the log form from a hero card), `lastLog` (drives the win/loss flash animation on mode tiles), and `matchLoggedSignal` (bumped on every log so child sections reset). This is the main coordination layer between the Pre-Match, Log Match, and Mode sections on the Dashboard.
- **`HeroDrawerContext` / `MapDrawerContext`** — Slide-in detail drawers triggered from anywhere in the tree.
- **`MatchEditDrawerContext`** — Slide-in editor for past matches, opened by clicking a tile in the Recent Matches row.

**Data fetching — `useApi<T>(url)`** (`hooks/useApi.ts`): a lightweight hook that fetches on mount and re-fetches on `revalidateAll()`. After any mutation (log, edit, delete), call `revalidateAll()` to refresh all mounted hooks simultaneously without a page reload.

**`types/index.ts`** — Central source of truth for:
- `QUEUE_MODE_COLORS` — all mode-specific Tailwind classes (glow shadow, card bg, accent color, tile dim). Edit here to restyle mode cards everywhere.
- `HEROES` and `MAPS` — the canonical hero and map rosters. The server's `HEROES_BY_ROLE` in `advisor.ts` must be kept in sync with `HEROES` manually when heroes are added.
- All shared TypeScript interfaces (`Match`, `TrendPoint`, `Recommendation`, `DeathRecord`, etc.).

### Styling

Tailwind with dark mode via `html.dark` class (toggled by `App.tsx`, persisted to `localStorage` as `ow-theme`).

CSS custom properties in `index.css` define the full theming system: `--ow-card`, `--ow-border`, `--ow-darker`, `--surface`, `--ink`, `--ink-2`, `--faint`, etc. The Tailwind config bridges these to utility classes (`bg-ow-card`, `border-ow-border`, etc.) using RGB channel values so opacity modifiers (`/50`, `/30`) work.

Reusable component classes are defined in `index.css` under `@layer components`: `.card`, `.field`, `.btn-primary`, `.heading-display`, `.num-display`, `.grad-win`, `.grad-loss`, etc.

Font family: `Oxanium` (Google Fonts, loaded in `index.html`) for all display text and numerals.

### API Key

The Anthropic API key goes in `server/.env` as `ANTHROPIC_API_KEY`. The server loads it explicitly with `dotenv.config({ path: path.resolve(__dirname, '../.env') })` so it works regardless of the working directory at launch.
