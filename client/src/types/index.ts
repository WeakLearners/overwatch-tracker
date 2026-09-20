import type { CSSProperties } from 'react';

export type QueueMode = 'qp_role' | 'comp_role' | 'comp_open';

export const QUEUE_MODES: { value: QueueMode; label: string; short: string }[] = [
  { value: 'qp_role',   label: 'Quickplay Role',    short: 'Quickplay Role'    },
  { value: 'comp_role', label: 'Competitive Role',  short: 'Competitive Role'  },
  { value: 'comp_open', label: 'Competitive Open',  short: 'Competitive Open'  },
];

// Full Tailwind class strings (JIT requires static class names — don't interpolate).
// qp = blue, comp_role = red — the game's own queue-select convention (blue
// Quick Play tile, red Competitive tile), kept recognizable rather than
// reinvented. comp_open is a third, open-queue variant of Competitive, so it
// gets a related warm tone (orange, close to the brand accent) instead of a
// fourth unrelated hue.
//   selected: pill style · card: selected-card border+bg · accent: label text color
export const QUEUE_MODE_COLORS: Record<QueueMode, { selected: string; card: string; tileDim: string; accent: string; glow: string; bright: string }> = {
  qp_role:   { selected: 'border-sky-400 bg-sky-50 text-sky-700 dark:border-sky-400 dark:bg-sky-500/15 dark:text-sky-300', card: 'bg-sky-50 dark:bg-sky-500/25', tileDim: 'bg-sky-500/5 dark:bg-sky-500/10', accent: 'text-sky-700 dark:text-sky-300', glow: 'shadow-[0_10px_30px_-12px_rgba(56,189,248,0.45)]', bright: 'rgba(125,211,252,0.9)' },
  comp_role: { selected: 'border-red-400 bg-red-50 text-red-700 dark:border-red-400 dark:bg-red-500/15 dark:text-red-300', card: 'bg-red-50 dark:bg-red-500/25', tileDim: 'bg-red-500/5 dark:bg-red-500/10', accent: 'text-red-700 dark:text-red-300', glow: 'shadow-[0_10px_30px_-12px_rgba(239,68,68,0.45)]', bright: 'rgba(252,165,165,0.9)' },
  comp_open: { selected: 'border-orange-400 bg-orange-50 text-orange-700 dark:border-orange-400 dark:bg-orange-500/15 dark:text-orange-300', card: 'bg-orange-50 dark:bg-orange-500/25', tileDim: 'bg-orange-500/5 dark:bg-orange-500/10', accent: 'text-orange-700 dark:text-orange-300', glow: 'shadow-[0_10px_30px_-12px_rgba(249,115,22,0.45)]', bright: 'rgba(253,186,116,0.9)' },
};

// Each mode's selected-state hue, as bare RGB channels for the --sel custom
// property that .is-selected reads (see index.css). Matches the border-*-400
// each tile already used: sky, red, orange. A mode's identity is its colour, so
// these override the shared class's accent default rather than replacing the
// class — the bottom-lit treatment is the same everywhere, only the hue moves.
export const QUEUE_MODE_SEL_RGB: Record<QueueMode, string> = {
  qp_role:   '56 189 248',  // sky-400
  comp_role: '248 113 113', // red-400
  comp_open: '251 146 60',  // orange-400
};

// Short tag shown as the big italic mode watermark (the "background lettering").
export const MODE_TAG: Record<QueueMode, string> = { qp_role: 'QP', comp_role: 'V5', comp_open: 'V6' };

// Subtle per-mode background wash for match-card rows (Today's Matches,
// Awaiting Stats, Logged Today) — see .mode-wash-* in index.css. Distinct
// from QUEUE_MODE_COLORS.card, which is a flatter fill used for mode-selector
// buttons/tiles where a stronger, non-gradient fill reads better.
export const MODE_WASH_CLASS: Record<QueueMode, string> = {
  qp_role: 'mode-wash-qp_role',
  comp_role: 'mode-wash-comp_role',
  comp_open: 'mode-wash-comp_open',
};

// Two-line mode labels — shared by LogMatch's in-form mode toggle and every
// hero/map history strip's win/loss-dash tooltip (Today's Matches, Logged
// Today), so a queue mode reads the same way wherever it's spelled out.
export const MODE_COMPACT: Record<string, { top: string; bot: string }> = {
  qp_role:   { top: 'Quickplay',   bot: 'Role' },
  comp_role: { top: 'Competitive', bot: 'Role' },
  comp_open: { top: 'Competitive', bot: 'Open' },
};

// Hero/map history strips draw newest-first (leftmost); only the last dash —
// whichever one lands oldest, however many are actually present — fades out
// left-to-right within itself (opaque at its own left edge, transparent at
// its right) to mark the tail end of the group, via a mask instead of a flat
// opacity so its fill color still shows through where it's visible. Shared by
// every history strip (Today's Matches, Logged Today).
export const OLDEST_DASH_FADE_STYLE: CSSProperties = {
  WebkitMaskImage: 'linear-gradient(to right, black, transparent)',
  maskImage: 'linear-gradient(to right, black, transparent)',
};

// The three contexts the watermark appears in. Each gets its own size/position
// config below so tuning one never affects the others.
//   strip    — Recently Logged rows (Log Match page)
//   selector — Mode buttons in the Match Details card
//   tile     — Mode tiles at the top of the Dashboard
export type ModeWatermarkVariant = 'strip' | 'selector' | 'tile';

// Per-variant, per-mode sizing/position for the watermark. JIT requires static
// class names — don't interpolate. Edit a single variant's row to nudge just that
// context; the dashboard tile also gets a `className` scale at its call site.
export const MODE_TAG_CLS: Record<ModeWatermarkVariant, Record<QueueMode, string>> = {
  // No weight override here — falls back to num-display's own base 200, the
  // original light readout weight (pre font-black bump).
  strip: {
    qp_role:   'text-[4.9368rem] translate-x-[-0.06em] translate-y-[0em]',
    comp_role: 'text-[4.9368rem] translate-x-[-0.06em] translate-y-[0.057em]',
    comp_open: 'text-[4.9368rem] translate-x-[-0.06em] translate-y-[0.057em]',
  },
  selector: {
    qp_role:   'text-[5rem] translate-x-[-0.125em] translate-y-[0.057em] font-black',
    comp_role: 'text-[5rem] translate-x-[-0.125em] translate-y-[0.057em] font-black',
    comp_open: 'text-[5rem] translate-x-[-0.125em] translate-y-[0.057em] font-black',
  },
  tile: {
    qp_role:   'text-[4.5rem] translate-x-[-0.075em] translate-y-[-0.35em] font-black',
    comp_role: 'text-[4.5rem] translate-x-[-0.075em] translate-y-[-0.35em] font-black',
    comp_open: 'text-[4.5rem] translate-x-[-0.075em] translate-y-[-0.35em] font-black',
  },
};

export interface Match {
  id: number;
  date: string;
  time: string | null;
  day_of_week: string | null;
  hour: number | null;
  hero: string;
  role: string;
  map: string;
  game_type: string;
  win: 0 | 1;
  queue_mode: QueueMode | null;
  created_at: string;
}

export interface DeathSlice {
  reason: string;
  count: number;
  pct: number;
}

// hero_* scopes are narrowed to the coaching column's own recommended hero;
// the plain map/map_type/overall scopes fall back to all heroes when that
// hero-specific slice is too thin.
export type DeathScope = 'hero_map' | 'hero_type' | 'hero' | 'map' | 'map_type' | 'overall';

export interface DeathReasonCorrelation {
  reason: string;
  in_wins: number;
  in_losses: number;
  win_per_match: number;
  loss_per_match: number;
  loss_multiplier: number | null;
}

// Factual death axes (v1/v2/v3 logging, historical — matches.deaths JSON).
// No longer captured (see MatchDeathEntry/match_deaths below, 2026-09-09) —
// the axis sliders decayed the same way this codebase already scars for:
// per-event judgment calls don't survive contact with real use. Kept here
// only because AdvisorCard still renders the axis breakdown computed
// server-side from that frozen historical data.
export type DeathAxisKey = 'trade' | 'timing' | 'grouping' | 'awareness';

// Axis metadata — drives the spectrum bars in AdvisorCard (historical data
// only; no longer drives a capture UI — see DEATH_AXES comment above).
// Endpoint convention: value→0 is the "low" pole, value→1 the "high" pole.
// Where an axis has a clear worse end, it sits at 0 (rendered red).
export interface DeathAxis {
  key: DeathAxisKey;
  label: string;
  low: string;   // full label for value → 0
  high: string;  // full label for value → 1
  lowShort: string;
  highShort: string;
}

export const DEATH_AXES: DeathAxis[] = [
  { key: 'trade',     label: 'Trade',     low: 'Wasted — nothing gained', high: 'Traded — got value',    lowShort: 'Wasted',    highShort: 'Got value' },
  { key: 'timing',    label: 'Timing',    low: 'Died first (over-eager)', high: 'Died last (staggered)',  lowShort: 'First',     highShort: 'Last'      },
  { key: 'grouping',  label: 'Grouping',  low: 'Alone / isolated',        high: 'With the team',          lowShort: 'Alone',     highShort: 'Grouped'   },
  { key: 'awareness', label: 'Awareness', low: 'Caught by surprise',      high: 'Full read, lost anyway', lowShort: 'Caught out', highShort: 'Read it'  },
];

// Per-death FACTS (2026-09-09 on) — who killed Sean, and whether it was an
// ult. Replaces the axis-judgment capture above. Buffered client-side during
// a match (MatchContext.deathBuffer) and sent as match_deaths on match
// create; the server writes one match_deaths row per entry, in array order.
export interface MatchDeathEntry {
  killer: string;      // hero name, a key of HEROES
  killer_role: string; // 'Tank' | 'DPS' | 'Support'
  ult: boolean;
}

// Per-axis mean position (0–1) and sample count for a scope, from the advisor.
export interface AxisPayload {
  deaths: number; // total death records counted
  games: number;
  axes: Record<DeathAxisKey, { mean: number; n: number }>;
  // The axis leaning furthest from neutral (0.5), with enough samples to trust.
  strongest_lean: { axis: DeathAxisKey; mean: number; n: number; label: string } | null;
}

export interface Recommendation {
  primary: string;
  stretch: string | null;
  stretch_untested: boolean;
  insight: string;
  death_axes: AxisPayload | null;
  death_scope: DeathScope;
  primary_stats: { games: number; win_rate: number } | null;
  user_map_stats: { games: number; win_rate: number | null };
  cached: boolean;
}

export interface MapVotingRow {
  map: string;
  total_games: number;
  historical_rate: number;
  recent_games: number;
  recent_rate: number | null;
  blended_score: number;
}

export interface HeroStat {
  hero: string;
  role: string;
  games: number;
  wins: number;
  win_rate: number;
}

export interface MapStat {
  map: string;
  game_type: string;
  games: number;
  wins: number;
  win_rate: number;
}

export interface TimeStat {
  hour?: number;
  day_of_week?: string;
  games: number;
  wins: number;
  win_rate: number;
}

export interface ModeComparison {
  queue_mode: QueueMode;
  games: number;
  wins: number;
  losses: number;
  win_rate: number;
  recent_win_rate: number | null;
  recent_games: number;
  recent_wins: number;
  recent_window: number;
  heroes_played: number;
  maps_played: number;
  top_hero: { hero: string; role: string; games: number; win_rate: number } | null;
}

export interface Overview {
  total: number;
  wins: number;
  win_rate: number;
  heroes_played: number;
  maps_played: number;
}

export interface TrendPoint {
  id: number;
  date: string;
  hero: string;
  map: string;
  game_type: string;
  win: 0 | 1;
  queue_mode: QueueMode;
  rolling_win_rate: number;
  /**
   * The rank this match ENDED at, 1-45, or null for quickplay and for every
   * match logged before the rank drum existed.
   */
  player_rank: number | null;
  /**
   * The rank this match STARTED at. Together with player_rank it makes the
   * move a property of the match that caused it, so the chart reads one row
   * instead of comparing two. Null on quickplay and on every row logged
   * before this column existed (2026-09-20), and never backfilled — the rank
   * those matches began at is not recorded anywhere.
   */
  player_rank_start: number | null;
  /** Role played, e.g. 'Support' | 'DPS' | 'Tank' — Overwatch ranks each role separately. */
  role: string;
  /**
   * Which of Sean's four accounts played the match, or null for matches
   * logged before this column existed. Same ladder-identity role as `role`
   * above: a rank means nothing without knowing which account/role climbed it.
   */
  account: Account | null;
}

export interface WeeklyTrend {
  week: string;
  week_start: string;
  games: number;
  wins: number;
  win_rate: number;
}

export interface Streaks {
  currentStreak: number;
  currentStreakType: 0 | 1;
  longestWin: number;
  longestLoss: number;
}

export const HEROES: Record<string, string> = {
  Ana: 'Support', Ashe: 'DPS', Baptiste: 'Support', Bastion: 'DPS',
  Brigitte: 'Support', Cassidy: 'DPS', Doomfist: 'Tank', 'D.Va': 'Tank',
  Echo: 'DPS', Genji: 'DPS', Hanzo: 'DPS', Illari: 'Support',
  'Junker Queen': 'Tank', Junkrat: 'DPS', Juno: 'Support', Kiriko: 'Support', Lifeweaver: 'Support',
  Lucio: 'Support', Mauga: 'Tank', Mei: 'DPS', Mercy: 'Support',
  Moira: 'Support', Orisa: 'Tank', Pharah: 'DPS', Ramattra: 'Tank',
  Reaper: 'DPS', Reinhardt: 'Tank', Roadhog: 'Tank', Sigma: 'Tank',
  Sojourn: 'DPS', 'Soldier: 76': 'DPS', Sombra: 'DPS', Symmetra: 'DPS',
  Torbjorn: 'DPS', Tracer: 'DPS', Venture: 'DPS', Widowmaker: 'DPS',
  Winston: 'Tank', 'Wrecking Ball': 'Tank', Zarya: 'Tank', Zenyatta: 'Support',
  Hazard: 'Tank', Freja: 'DPS',
  // 2025-2026 additions
  Shion: 'DPS', 'Jetpack Cat': 'Support', Domina: 'Tank', Sierra: 'DPS',
  Mizuki: 'Support', Emre: 'DPS', Wuyang: 'Support', Anran: 'DPS', Vendetta: 'DPS',
  'D.Mon': 'Tank',
};

// Hanaoka and Anubis removed from active rotation indefinitely
export const MAPS: Record<string, string> = {
  Aatlis: 'Flashpoint', Antarctica: 'Control',
  'Blizzard World': 'Hybrid', Busan: 'Control', 'Circuit Royale': 'Escort',
  Colosseo: 'Push', Dorado: 'Escort', Eichenwalde: 'Hybrid',
  Esperanca: 'Push', Gibraltar: 'Escort', Havana: 'Escort',
  Hollywood: 'Hybrid', 'Ilios': 'Control', 'Junkertown': 'Escort',
  "King's Row": 'Hybrid', 'Lijiang Tower': 'Control', 'Midtown': 'Hybrid',
  'Nepal': 'Control', 'Neon Junction': 'Hybrid',
  'New Junk City': 'Flashpoint', 'New Queen Street': 'Push',
  'Numbani': 'Hybrid', 'Oasis': 'Control', 'Paraiso': 'Hybrid',
  'Rialto': 'Escort', 'Route 66': 'Escort', 'Runasapi': 'Push',
  'Samoa': 'Control', 'Shambali Monastery': 'Escort', 'Suravasa': 'Flashpoint',
  'Throne of Anubis': 'Clash',
};

// DPS teal / Support pink (not red/green) — this app already uses red for
// Loss and Comp-Role mode, and emerald for Win, so a red DPS badge or green
// Support badge read as an outcome/mode signal instead of a role one. Tank
// keeps blue since nothing else in the app claims that hue.
export const ROLE_COLORS: Record<string, string> = {
  DPS: 'bg-teal-600/15 text-teal-700 dark:text-teal-400',
  Tank: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  Support: 'bg-pink-500/15 text-pink-700 dark:text-pink-400',
};

// Each role's selected-state hue, as bare RGB channels for the --sel custom
// property .is-selected reads. Matches the border-*-400 the role toggle used to
// hand-write next to this table.
export const ROLE_SEL_RGB: Record<string, string> = {
  DPS:     '45 212 191',  // teal-400
  Tank:    '96 165 250',  // blue-400
  Support: '244 114 182', // pink-400
};

// Role text colour on its own. ROLE_COLORS bundles a flat background with the
// text colour, and .is-selected now supplies the background — layering the two
// muddies the hue, since a background-image sits over a background-color rather
// than replacing it. This exists so a caller can take the text without the fill
// instead of string-indexing ROLE_COLORS apart.
export const ROLE_TEXT: Record<string, string> = {
  DPS:     'text-teal-700 dark:text-teal-400',
  Tank:    'text-blue-700 dark:text-blue-400',
  Support: 'text-pink-700 dark:text-pink-400',
};

// Same reasoning as ROLE_COLORS above, for the solid role-pill treatment used
// on match-card hero tags (Today's Matches, Awaiting Stats, Logged Today).
export const ROLE_PILL_CLASS: Record<string, string> = {
  DPS: 'bg-teal-600 border-teal-600',
  Tank: 'bg-blue-600 border-blue-600',
  Support: 'bg-pink-600 border-pink-600',
};

// Mid-match switch heroes (slots 2/3) peek out from behind the primary pill —
// indexed one shade darker per slot (index 0 = 2nd hero, index 1 = 3rd hero)
// so they read as further back in the stack instead of just a repeat of the
// primary pill's color.
export const ROLE_PILL_CLASS_DARK: Record<string, [string, string]> = {
  DPS: ['bg-teal-700 border-teal-700', 'bg-teal-900 border-teal-900'],
  Tank: ['bg-blue-700 border-blue-700', 'bg-blue-900 border-blue-900'],
  Support: ['bg-pink-700 border-pink-700', 'bg-pink-900 border-pink-900'],
};

export const TYPE_COLORS: Record<string, string> = {
  Control: 'bg-purple-500/15 text-purple-700 dark:text-purple-400',
  Hybrid: 'bg-yellow-600/15 text-yellow-800 dark:text-yellow-400',
  Escort: 'bg-orange-500/15 text-orange-700 dark:text-orange-400',
  Push: 'bg-cyan-600/15 text-cyan-800 dark:text-cyan-400',
  Flashpoint: 'bg-pink-500/15 text-pink-700 dark:text-pink-400',
  Clash: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
};

// ---------------------------------------------------------------------------
// Competitive rank ladder
// ---------------------------------------------------------------------------
// Overwatch ranks are a strict ladder, so we store them as one integer: 1-40.
// Bronze 5 = 1 (bottom), Gold 5 = 11, Champion 1 = 45 (top). Within a tier the
// divisions count DOWN as you climb — Gold 5 is worse than Gold 1 — so the
// arithmetic below inverts the division number on purpose.
//
// The reason for an integer rather than the text 'Gold 5': every question this
// data exists to answer is a distance. How wide was the lobby? Where did Sean
// sit inside it? Both are subtraction here. Neither is possible on a string.
//
// This must stay in step with the player_rank/lobby_low/lobby_high migration in
// server/src/db/schema.ts.

export const RANK_TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Emerald', 'Diamond', 'Master', 'Grandmaster', 'Champion'] as const;
export type RankTier = typeof RANK_TIERS[number];

export const RANK_MIN = 1;
export const RANK_MAX = RANK_TIERS.length * 5; // 45

/** The standard lobby spread: Sean sees nobody more than 5 divisions away, ~99% of the time. */
export const DEFAULT_LOBBY_SPREAD = 5;

export const RANK_TIER_COLOR: Record<RankTier, string> = {
  Bronze:       '#a1663a',
  Silver:       '#9aa4ad',
  Gold:         '#e0a63c',
  Platinum:     '#59c3c3',
  Emerald:      '#3fb984',
  Diamond:      '#6f9dfb',
  Master:       '#d8b23a',
  Grandmaster:  '#c05b9c',
  Champion:     '#e05a4a',
};

// The same tier colours as bare RGB channels, for the --tier custom property
// the lobby slider's CSS reads. Kept beside RANK_TIER_COLOR rather than derived
// at runtime: a hex-to-rgb helper called once per pane per render is work for
// values that never change.
/**
 * Sean's four Overwatch accounts. Each one carries its own competitive rank, so
 * the rank drum and the lobby range are stored per account rather than once —
 * a single stored rank would follow him onto an account it does not belong to.
 *
 * The names are also the localStorage key suffix ('ow-player-rank:Pinx'), so
 * renaming one strands whatever that account had stored. Only the default
 * account is protected, by the legacy single-key adoption below it.
 */
export const ACCOUNTS = ['Pinx', 'Jinx', 'Winx', 'Linx'] as const;
export type Account = typeof ACCOUNTS[number];
export const DEFAULT_ACCOUNT: Account = 'Pinx';
export function isAccount(v: unknown): v is Account {
  return typeof v === 'string' && (ACCOUNTS as readonly string[]).includes(v);
}

export const RANK_TIER_RGB: Record<RankTier, string> = {
  Bronze:      '161 102 58',
  Silver:      '154 164 173',
  Gold:        '224 166 60',
  Platinum:    '89 195 195',
  Emerald:     '63 185 132',
  Diamond:     '111 157 251',
  Master:      '216 178 58',
  Grandmaster: '192 91 156',
  Champion:    '224 90 74',
};

export function rankTier(r: number): RankTier {
  return RANK_TIERS[Math.floor((clampRank(r) - 1) / 5)];
}

/** Division within the tier, 5 (lowest) down to 1 (highest). */
export function rankDivision(r: number): number {
  return 5 - ((clampRank(r) - 1) % 5);
}

export function clampRank(r: number): number {
  return Math.max(RANK_MIN, Math.min(RANK_MAX, Math.round(r)));
}

/** "Gold 5" */
export function rankLabel(r: number | null | undefined): string {
  if (r == null) return '—';
  return `${rankTier(r)} ${rankDivision(r)}`;
}

/** "G5" — for tight spaces like a match row. */
export function rankShort(r: number | null | undefined): string {
  if (r == null) return '—';
  const t = rankTier(r);
  const c = t === 'Grandmaster' ? 'GM' : t === 'Champion' ? 'C' : t[0];
  return `${c}${rankDivision(r)}`;
}

/** Turn a tier + division back into the single number. */
export function rankFromParts(tier: RankTier, division: number): number {
  return RANK_TIERS.indexOf(tier) * 5 + (5 - division) + 1;
}
