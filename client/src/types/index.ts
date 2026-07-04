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

// Factual death axes (v2 logging) — the player records observable facts, not a
// felt verdict. Shared by the Log Match tagger and the advisor's death analysis.
export type Trade = 'traded' | 'free';
export type Timing = 'first' | 'middle' | 'last';
export type Grouping = 'grouped' | 'alone';
export type Awareness = 'saw' | 'caught';
export interface DeathRecord {
  trade: Trade;
  timing: Timing;
  grouping: Grouping;
  awareness: Awareness;
}

export interface DeathScenario {
  label: string;
  hint: string;
  record: DeathRecord;
}

// 8 scenarios covering the most common death patterns. Each maps to a full
// 4-axis DeathRecord so the advisor's existing aggregation works unchanged.
// Pairs are drawn randomly at log time — the player picks whichever is closer.
export const DEATH_SCENARIOS: DeathScenario[] = [
  { label: 'Caught out alone',       hint: "Away from team, didn't see it coming",    record: { trade: 'free',   timing: 'first',  grouping: 'alone',   awareness: 'caught' } },
  { label: 'Dove in, got nothing',   hint: 'Entered before the team — no trade',      record: { trade: 'free',   timing: 'first',  grouping: 'grouped', awareness: 'saw'    } },
  { label: 'Held on too long',       hint: "Should've disengaged, didn't",            record: { trade: 'free',   timing: 'last',   grouping: 'alone',   awareness: 'saw'    } },
  { label: 'Stranded after team wiped', hint: 'Last alive with nowhere to go',        record: { trade: 'free',   timing: 'last',   grouping: 'grouped', awareness: 'caught' } },
  { label: 'Flanked mid-fight',      hint: "An angle I didn't check hit me",          record: { trade: 'free',   timing: 'middle', grouping: 'grouped', awareness: 'caught' } },
  { label: 'Lost the duel I chose',  hint: 'Full read, just got outplayed',           record: { trade: 'free',   timing: 'middle', grouping: 'alone',   awareness: 'saw'    } },
  { label: 'Traded — got value',     hint: 'Kill, cooldown, or real pressure gained', record: { trade: 'traded', timing: 'middle', grouping: 'grouped', awareness: 'saw'    } },
  { label: 'Burned in to open space', hint: 'Sacrificed to create a fight',           record: { trade: 'traded', timing: 'first',  grouping: 'grouped', awareness: 'saw'    } },
];

// Axis distributions (percentages of total deaths) for a scope, from the advisor.
export interface AxisPayload {
  deaths: number;
  games: number;
  trade: { free: number; traded: number };
  timing: { first: number; middle: number; last: number };
  grouping: { alone: number; grouped: number };
  awareness: { caught: number; saw: number };
  top_pattern: { label: string; count: number } | null;
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
