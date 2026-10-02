// "Game crashed" matches (2026-10-02): result-only records. The scoreboard
// resets when Overwatch crashes and Sean rejoins, so any stats would describe
// only the tail of the game. See the `crashed` column comment in db/schema.ts
// for the full contract (what counts, what is excluded, and why).

/** Placeholder for matches.hero, which is NOT NULL. Never a real hero; a crashed row has no match_heroes row, so no by-hero view ever sees it. */
export const CRASHED_HERO = 'Game crashed';

/** Fields a crashed match may still edit: context and result, never scoreboard data. */
export const CRASHED_EDITABLE = [
  'date', 'time', 'day_of_week', 'hour', 'role', 'map', 'game_type', 'win', 'queue_mode', 'notes',
  'leaver', 'leaver_side', 'player_rank', 'player_rank_start', 'lobby_low', 'lobby_high', 'account',
] as const;
