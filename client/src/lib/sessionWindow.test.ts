import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldSessionRows, MIN_GAMES } from './sessionWindow';

const DAYS = ['Monday', 'Tuesday'] as const;
const row = (d: string, hour: number, games: number, wins: number) =>
  ({ day_of_week: d, hour, games, wins, win_rate: games ? wins / games * 100 : 0 });

test('hours with MIN_GAMES or more keep their own row', () => {
  const rows = foldSessionRows([row('Monday', 8, MIN_GAMES, 5), row('Monday', 9, MIN_GAMES, 4)], DAYS);
  assert.deepEqual(rows.map(r => r.key), ['h8', 'h9']);
});

test('thin hours before and after fold, sums per day', () => {
  const data = [
    row('Monday', 2, 3, 1), row('Tuesday', 3, 2, 2), row('Monday', 3, 1, 0),
    row('Monday', 10, 12, 6),
    row('Monday', 20, 4, 1), row('Monday', 22, 1, 1),
  ];
  const rows = foldSessionRows(data, DAYS);
  assert.deepEqual(rows.map(r => r.key), ['before', 'h10', 'after']);
  const b = rows[0].cells.get('Monday')!;
  assert.equal(b.games, 4); assert.equal(b.wins, 1); assert.equal(b.rate, 25);
  assert.equal(rows[0].cells.get('Tuesday')!.games, 2);
  const a = rows[2].cells.get('Monday')!;
  assert.equal(a.games, 5); assert.equal(a.wins, 2);
});

test('thin hour between own-row hours keeps its row; thin cell is muted', () => {
  const data = [row('Monday', 8, 10, 5), row('Monday', 9, 2, 1), row('Tuesday', 10, 10, 5), row('Monday', 10, 10, 5)];
  const rows = foldSessionRows(data, DAYS);
  assert.deepEqual(rows.map(r => r.key), ['h8', 'h9', 'h10']);
  assert.equal(rows[1].cells.get('Monday')!.muted, true);
  assert.equal(rows[0].cells.get('Monday')!.muted, false);
});

test('empty data gives no rows', () => {
  assert.deepEqual(foldSessionRows([], DAYS), []);
});
