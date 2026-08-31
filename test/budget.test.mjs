// The free-tier guard: TomTom Freemium allows 2,500 non-tile requests/day and
// 5 requests/second, and answers "403 - Over the limit" past either.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BudgetExhausted, callsForRoutes, createBudget, utcDay } from '../worker/src/budget.js';

/** Minimal D1 stand-in for the two statements the budget uses. */
function fakeDb(startingCalls = {}) {
  const rows = { ...startingCalls };
  const writes = [];
  return {
    rows,
    writes,
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() { return sql.includes('SELECT calls') ? (rows[args[0]] != null ? { calls: rows[args[0]] } : null) : null; },
        async run() {
          rows[args[0]] = (rows[args[0]] || 0) + args[1];
          writes.push(args[1]);
          return { meta: { changes: 1 } };
        },
      };
    },
  };
}

test('a fresh day starts from zero and counts up', async () => {
  const DB = fakeDb();
  const budget = await createBudget({ DB, DAILY_API_BUDGET: 2000 }).load();
  assert.deepEqual({ used: budget.used, remaining: budget.remaining, limit: budget.limit },
    { used: 0, remaining: 2000, limit: 2000 });
  await budget.claim();
  await budget.claim();
  assert.equal(budget.used, 2);
});

test('the day already spent is carried over from the database', async () => {
  const DB = fakeDb({ [utcDay()]: 1990 });
  const budget = await createBudget({ DB, DAILY_API_BUDGET: 2000 }).load();
  assert.equal(budget.remaining, 10);
  assert.equal(budget.canAfford(10), true);
  assert.equal(budget.canAfford(11), false);
});

test('claiming past the daily allowance throws instead of calling the provider', async () => {
  const DB = fakeDb({ [utcDay()]: 1999 });
  const budget = await createBudget({ DB, DAILY_API_BUDGET: 2000 }).load();
  await budget.claim();
  await assert.rejects(() => budget.claim(), BudgetExhausted);
  await assert.rejects(() => budget.claim(), /resets at 00:00 UTC/);   // queue survives a refusal
});

test('spend is persisted in one write per tick, not one per call', async () => {
  const DB = fakeDb();
  const budget = await createBudget({ DB, DAILY_API_BUDGET: 2000 }).load();
  for (let i = 0; i < 6; i++) await budget.claim();
  await budget.flush();
  assert.deepEqual(DB.writes, [6]);
  assert.equal(DB.rows[utcDay()], 6);
  await budget.flush();                      // nothing new to write
  assert.deepEqual(DB.writes, [6]);
});

test('parallel route checks are paced under the provider rate limit', async () => {
  const DB = fakeDb();
  const budget = await createBudget({ DB, DAILY_API_BUDGET: 2000 }).load();
  const started = Date.now();
  await Promise.all(Array.from({ length: 5 }, () => budget.claim()));
  const elapsed = Date.now() - started;
  // 5 calls at >=250 ms apart cannot finish in under a second.
  assert.ok(elapsed >= 900, `5 claims took ${elapsed}ms, expected pacing to slow them`);
  assert.equal(budget.used, 5);
});

test('the default budget leaves headroom under the 2,500/day free tier', async () => {
  const budget = await createBudget({ DB: fakeDb() }).load();
  assert.ok(budget.limit < 2500, 'default must stay under the free allowance');
  assert.equal(budget.limit, 2000);
});

test('a morning of alerts costs a small fraction of the day', () => {
  // One route, refreshed every 20 min across a 50-minute window = 3 checks.
  assert.equal(callsForRoutes(1) * 3, 6);
  // Three routes on the same cadence.
  assert.equal(callsForRoutes(3) * 3, 18);
});
