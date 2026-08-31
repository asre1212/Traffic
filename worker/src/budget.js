// Keeps the app inside the traffic provider's free tier.
//
// TomTom Freemium allows 2,500 non-tile requests per day (resetting at 00:00
// UTC) and 5 requests per second; going over returns "403 - Over the limit".
// Every provider call goes through a budget: it refuses work once the daily
// allowance is spent, and paces calls so a burst never trips the rate limit.

const DEFAULT_DAILY_LIMIT = 2000;   // margin under the 2,500/day free allowance
const MIN_CALL_SPACING_MS = 250;    // 4 req/s, under the 5 req/s ceiling

export const utcDay = (now = new Date()) => now.toISOString().slice(0, 10);

export class BudgetExhausted extends Error {}

export function createBudget(env, { now = new Date(), reserve = 0 } = {}) {
  const limit = Math.max(1, Number(env.DAILY_API_BUDGET) || DEFAULT_DAILY_LIMIT);
  const day = utcDay(now);
  let spentAtStart = 0;
  let spent = 0;
  let lastCallAt = 0;
  let queue = Promise.resolve();   // serializes claims so parallel checks still pace

  return {
    limit,
    day,
    get used() { return spentAtStart + spent; },
    get remaining() { return Math.max(0, limit - spentAtStart - spent); },

    /** Read today's tally. Cheap: one indexed row. */
    async load() {
      const row = await env.DB.prepare('SELECT calls FROM usage WHERE day = ?').bind(day).first();
      spentAtStart = Number(row?.calls || 0);
      return this;
    },

    /** True if `count` more calls fit inside today's allowance. */
    canAfford(count = 1) {
      return spentAtStart + spent + count <= limit;
    },

    /**
     * Claim one call and wait long enough to stay under the per-second limit.
     * Throws BudgetExhausted rather than making a call that would be rejected.
     */
    claim(label = 'traffic API') {
      const turn = queue.then(async () => {
        if (!this.canAfford(1)) {
          throw new BudgetExhausted(
            `daily ${label} budget used up (${limit} calls); it resets at 00:00 UTC`);
        }
        spent += 1;
        const wait = lastCallAt + MIN_CALL_SPACING_MS - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        lastCallAt = Date.now();
      });
      queue = turn.catch(() => {});   // one refusal must not poison the queue
      return turn;
    },

    /** Persist the tick's calls in a single upsert instead of one write per call. */
    async flush() {
      if (!spent) return;
      await env.DB.prepare(
        'INSERT INTO usage (day, calls) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET calls = calls + ?',
      ).bind(day, spent, spent).run();
      spentAtStart += spent;
      spent = 0;
    },
  };
}

/** Reserve is the worst case for a check: one routing + one incident call per route. */
export const callsForRoutes = (routeCount) => routeCount * 2;
