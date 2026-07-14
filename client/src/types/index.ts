export type QueueMode = 'qp_role' | 'comp_role' | 'comp_open';

export const QUEUE_MODES: { value: QueueMode; label: string; short: string }[] = [
  { value: 'qp_role',   label: 'Quickplay Role',    short: 'Quickplay Role'    },
  { value: 'comp_role', label: 'Competitive Role',  short: 'Competitive Role'  },
  { value: 'comp_open', label: 'Competitive Open',  short: 'Competitive Open'  },
];

// Full Tailwind class strings (JIT requires static class names — don't interpolate).
// qp = blue, comp_role = red, comp_open = pink.
//   selected: pill style · card: selected-card border+bg · accent: label text color
export const QUEUE_MODE_COLORS: Record<QueueMode, { selected: string; card: string; tileDim: string; accent: string; glow: string; bright: string }> = {
  qp_role:   { selected: 'border-blue-300 bg-blue-100 text-blue-700 dark:border-blue-500 dark:bg-blue-500/20 dark:text-blue-400', card: 'bg-blue-100 dark:bg-blue-500/40', tileDim: 'bg-blue-500/10 dark:bg-blue-500/20', accent: 'text-blue-600 dark:text-blue-400', glow: 'shadow-[0_10px_30px_-12px_rgba(59,130,246,0.45)]',  bright: 'rgba(147,197,253,0.9)' },
  comp_role: { selected: 'border-red-300 bg-red-100 text-red-700 dark:border-red-500 dark:bg-red-500/20 dark:text-red-400',   card: 'bg-red-100 dark:bg-red-500/40',   tileDim: 'bg-red-500/10 dark:bg-red-500/20',   accent: 'text-red-600 dark:text-red-400',   glow: 'shadow-[0_10px_30px_-12px_rgba(239,68,68,0.45)]',   bright: 'rgba(252,165,165,0.9)' },
  comp_open: { selected: 'border-pink-300 bg-pink-100 text-pink-700 dark:border-pink-500 dark:bg-pink-500/20 dark:text-pink-400', card: 'bg-pink-100 dark:bg-pink-500/40', tileDim: 'bg-pink-500/10 dark:bg-pink-500/20', accent: 'text-pink-600 dark:text-pink-400', glow: 'shadow-[0_10px_30px_-12px_rgba(236,72,153,0.45)]', bright: 'rgba(249,168,212,0.9)' },
};

// Short tag shown as the big italic mode watermark (the "background lettering").
export const MODE_TAG: Record<QueueMode, string> = { qp_role: 'QP', comp_role: 'V5', comp_open: 'V6' };

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
  strip: {
    qp_role:   'text-[5rem] translate-x-[-0.075em] translate-y-[0em]',
    comp_role: 'text-[5rem] translate-x-[-0.075em] translate-y-[0.057em]',
    comp_open: 'text-[5rem] translate-x-[-0.075em] translate-y-[0.057em]',
  },
  selector: {
    qp_role:   'text-[5rem] translate-x-[-0.125em] translate-y-[0.057em]',
    comp_role: 'text-[5rem] translate-x-[-0.125em] translate-y-[0.057em]',
    comp_open: 'text-[5rem] translate-x-[-0.125em] translate-y-[0.057em]',
  },
  tile: {
    qp_role:   'text-[4.5rem] translate-x-[-0.075em] translate-y-[-0.35em]',
    comp_role: 'text-[4.5rem] translate-x-[-0.075em] translate-y-[-0.35em]',
    comp_open: 'text-[4.5rem] translate-x-[-0.075em] translate-y-[-0.35em]',
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

export type DeathScope = 'map' | 'map_type' | 'overall';

export interface DeathReasonCorrelation {
  reason: string;
  in_wins: number;
  in_losses: number;
  win_per_match: number;
  loss_per_match: number;
  loss_multiplier: number | null;
}

export interface DeathInsights {
  tagged_games: number;
  win_games: number;
  loss_games: number;
  total_deaths: number;
  breakdown: DeathSlice[];
  reasons: DeathReasonCorrelation[];
  deaths_per_win: number | null;
  deaths_per_loss: number | null;
  has_outcome_split: boolean;
}

// Factual death axes (v3 logging) — the player rates ONE axis per death on a
// 0.0–1.0 spectrum, rather than picking a fully-specified 4-axis scenario. Only
// one axis is asked per death (time is short at respawn), and the four axes are
// sampled evenly over time via a persistent least-sampled tally (see MatchContext).
export type DeathAxisKey = 'trade' | 'timing' | 'grouping' | 'awareness';

export interface DeathRecord {
  axis: DeathAxisKey;
  value: number; // 0.0 (low end) → 1.0 (high end)
}

// Axis metadata — drives both the slider (DeathLogger) and the spectrum bars
// (AdvisorCard). Endpoint convention: value→0 is the "low" pole, value→1 the
// "high" pole. Where an axis has a clear worse end, it sits at 0 (rendered red).
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
  game_type: string;
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

export const ROLE_COLORS: Record<string, string> = {
  DPS: 'bg-red-500/15 text-red-700 dark:text-red-400',
  Tank: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  Support: 'bg-green-600/15 text-green-700 dark:text-green-400',
};

export const TYPE_COLORS: Record<string, string> = {
  Control: 'bg-purple-500/15 text-purple-700 dark:text-purple-400',
  Hybrid: 'bg-yellow-600/15 text-yellow-800 dark:text-yellow-400',
  Escort: 'bg-orange-500/15 text-orange-700 dark:text-orange-400',
  Push: 'bg-cyan-600/15 text-cyan-800 dark:text-cyan-400',
  Flashpoint: 'bg-pink-500/15 text-pink-700 dark:text-pink-400',
  Clash: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
};
