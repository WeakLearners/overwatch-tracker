import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { makeCallVisionCli, cliEnv, CLI_AUTH_ENV_VARS, readScoreboard, SCOREBOARD_MODEL, type CliRunner } from './scoreboard';

const FIXTURE = path.resolve(__dirname, '../test/fixtures/scoreboard-36.png');
const parsedOk = { page_type: 'other', is_scoreboard: false, rows: [] };
const ok = (stdout: string): CliRunner => async () => ({ stdout, stderr: '', code: 0, timedOut: false });

describe('callVisionCli (stubbed process)', () => {
  test('parses structured_output and passes model, tools and settings flags', async () => {
    let seen: string[] = [];
    const run: CliRunner = async (_b, args) => { seen = args; return { stdout: JSON.stringify({ is_error: false, structured_output: parsedOk }), stderr: '', code: 0, timedOut: false }; };
    const p = await makeCallVisionCli(run)(FIXTURE);
    assert.deepEqual(p, parsedOk);
    assert.equal(seen[seen.indexOf('--model') + 1], SCOREBOARD_MODEL);
    assert.equal(seen[seen.indexOf('--setting-sources') + 1], 'user');
    assert.equal(seen[seen.indexOf('--tools') + 1], 'Read');
    assert.ok(seen.includes('--json-schema'));
  });
  test('spawn env has no auth-forcing variables even when process.env sets them', async () => {
    const saved: Record<string, string | undefined> = {};
    for (const k of CLI_AUTH_ENV_VARS) { saved[k] = process.env[k]; process.env[k] = 'x'; }
    process.env.OW_KEEP_ME = '1';
    try {
      let env: NodeJS.ProcessEnv = {};
      const run: CliRunner = async (_b, _a, o) => { env = o.env; return { stdout: JSON.stringify({ is_error: false, structured_output: parsedOk }), stderr: '', code: 0, timedOut: false }; };
      await makeCallVisionCli(run)(FIXTURE);
      for (const k of CLI_AUTH_ENV_VARS) assert.equal(env[k], undefined, k);
      assert.equal(env.OW_KEEP_ME, '1');
      assert.equal(process.env.ANTHROPIC_API_KEY, 'x', 'process.env itself is untouched');
      assert.equal(cliEnv({ ANTHROPIC_API_KEY: 'k', PATH: '/bin' }).ANTHROPIC_API_KEY, undefined);
    } finally {
      for (const k of CLI_AUTH_ENV_VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      delete process.env.OW_KEEP_ME;
    }
  });
  test('falls back to a fenced JSON result string', async () => {
    const p = await makeCallVisionCli(ok(JSON.stringify({ result: '```json\n' + JSON.stringify(parsedOk) + '\n```' })))(FIXTURE);
    assert.deepEqual(p, parsedOk);
  });
  test('bad JSON in the result throws a clear error', async () => {
    await assert.rejects(makeCallVisionCli(ok(JSON.stringify({ result: 'sorry, cannot' })))(FIXTURE), /not valid JSON/);
    await assert.rejects(makeCallVisionCli(ok('garbage'))(FIXTURE), /output is not JSON/);
  });
  test('non-zero exit throws with stderr', async () => {
    const run: CliRunner = async () => ({ stdout: '', stderr: 'Not logged in', code: 1, timedOut: false });
    await assert.rejects(makeCallVisionCli(run)(FIXTURE), /exited 1: Not logged in/);
  });
  test('non-zero exit with a JSON envelope reports its result, not the usage data before it', async () => {
    const stdout = JSON.stringify({ duration_api_ms: 0, stop_reason: 'stop_sequence', usage: { pad: 'x'.repeat(800) }, is_error: true, result: "You've hit your limit" });
    const run: CliRunner = async () => ({ stdout, stderr: '', code: 1, timedOut: false });
    await assert.rejects(makeCallVisionCli(run)(FIXTURE), /exited 1: You've hit your limit/);
  });
  test('CLI-reported error throws', async () => {
    await assert.rejects(makeCallVisionCli(ok(JSON.stringify({ is_error: true, result: 'rate limited' })))(FIXTURE), /rate limited/);
  });
  test('timeout throws', async () => {
    const run: CliRunner = async () => ({ stdout: '', stderr: '', code: 1, timedOut: true });
    await assert.rejects(makeCallVisionCli(run, 5000)(FIXTURE), /timed out after 5s/);
  });
  test('readScoreboard defaults to cli (api key not needed)', async () => {
    const prev = process.env.SCOREBOARD_READER; delete process.env.SCOREBOARD_READER;
    try { assert.equal(typeof readScoreboard, 'function'); } finally { if (prev !== undefined) process.env.SCOREBOARD_READER = prev; }
  });
});
