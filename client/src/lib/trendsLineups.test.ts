import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTrendsDerived } from './trendsDerived';

// OW-0008: the candle tooltip names the account and role played that day.
const game = (over: Record<string, unknown>) => ({
  id: 1, date: '2026-11-10T20:00:00', hero: 'Ana', map: 'Numbani', game_type: 'competitive',
  win: 1, queue_mode: 'comp_role', rolling_win_rate: 50, player_rank: null, player_rank_start: null,
  placement: 0, role: 'Support', account: 'Pinx', ...over,
});

test('candle lineups: one entry per account and role, with a count when repeated', () => {
  const trends = [
    game({ id: 1 }),
    game({ id: 2, win: 0 }),
    game({ id: 3, role: 'Tank', account: 'Winx' }),
    game({ id: 4, queue_mode: 'comp_open', role: 'DPS', account: 'Winx' }),
    game({ id: 5, account: null, queue_mode: 'qp_role', role: 'DPS' }),
  ];
  const { candles } = computeTrendsDerived(trends as never);
  assert.equal(candles.length, 1);
  assert.equal(candles[0].lineups, 'Pinx Support ×2, Winx Tank, Winx Open, no account DPS');
});
