# Search Queue

Navigator keeps 12 engines across two flavors — browser engines and API engines. Requests go through a queue — matching is not random, it is a scored,
stateful scheduler with backoff and sequential failover, so you still get results even when most routes are down.

## The Big Picture

1. **Score** every route from recent history (success, stability, latency, recovery).
2. **Filter** out routes on backoff or on circuit-breaker cooldown.
3. **Order** the eligible routes by score, pick the least-recently-used among the top.
4. **Try** them one by one. First success wins; every failure is recorded and the next route is tried.
5. **Persist** the learned state to disk so restarts don't forget.

```
queries → scheduler.score() → eligible? → ordered list → try route 1 → fail? → try route 2 → ... → results
                                       ↘ skipped (circuit / backoff) → reported but not tried
```

## Scoring (Optimization)

The scheduler keeps a profile per route (`attempts`, `ok`/`fail`, `results`, `latencySamples`, `recentOutcomes`,
`failureGapsMs`, `errorTypes`, `lastSelectedAt`). The score at time `now` is:

```
score = wSuccess * successRate
      + wResults * resultsPerAttempt
      + wStability * (1 - recentFailureRate)
      - wRecency * recencyPenalty
      + wRecovery * recoveryBonus
      + wLatency * latencyScore
```

| Weight | Env Variable | Default | What It Rewards |
|--------|--------------|---------|-----------------|
| `wSuccess` | `SEARCH_QUEUE_W_SUCCESS` | `0.45` | Higher `ok / attempts` |
| `wResults` | `SEARCH_QUEUE_W_RESULTS` | `0.15` | More results per attempt (capped at 10) |
| `wStability` | `SEARCH_QUEUE_W_STABILITY` | `0.25` | Low recent failure rate |
| `wRecency` | `SEARCH_QUEUE_W_RECENCY` | `0.1` | Penalizes a failure that just happened (`exp(-age / 5m)`) |
| `wRecovery` | `SEARCH_QUEUE_W_RECOVERY` | `0.05` | Bonus when `successesInRow` grows after a failure |
| `wLatency` | `SEARCH_QUEUE_W_LATENCY` | `0.2` | Faster median latency (`1 / (1 + medianMs/1000)`) |

Recent outcomes are weighted by age (≤5m ×4, ≤15m ×3, ≤1h ×2, ≤24h ×1), so a flaky last 5 minutes hurts more than a
failure yesterday.

| Backoff Setting | Env Variable | Default |
|-----------------|--------------|---------|
| Minimum backoff | `SEARCH_QUEUE_MIN_INTERVAL_MS` | `30000` (30s) |
| Maximum backoff | `SEARCH_QUEUE_MAX_INTERVAL_MS` | `1800000` (30m) |
| Escalation factor | `SEARCH_QUEUE_ESCALATION_FACTOR` | `2` |
| Error-gap percentile | `SEARCH_QUEUE_ERROR_GAP_PERCENTILE` | `0.75` |
| Error-gap safety | `SEARCH_QUEUE_ERROR_GAP_SAFETY` | `1.25` |
| Decay per success | `SEARCH_QUEUE_DECAY_PER_SUCCESS` | `0.75` |
| Circuit cooldown | `SEARCH_ROUTE_CIRCUIT_OPEN_MS` | `300000` (5m) |
| Profile persistence | `SEARCH_QUEUE_PROFILE_PATH` | `.cache/search-engine-profiles.json` |

## Eligibility & Backoff

A route is eligible only if it is not on backoff:

> `isEligible = failuresInRow == 0 || now >= lastCalledAt + minIntervalMs`

`minIntervalMs` adapts per route:

- Starts at `SEARCH_QUEUE_MIN_INTERVAL_MS` (`30000` / 30s), capped at `SEARCH_QUEUE_MAX_INTERVAL_MS` (`1800000` / 30m).
- On failure: `minIntervalMs = min(max, max(minIntervalMs * escalationFactor * severity, learnedGap, min))` — `escalationFactor` `2`, `severity` `1.5` for `captcha`/`blocked` else `1`, `learnedGap` is the `SEARCH_QUEUE_ERROR_GAP_PERCENTILE` (`0.75`) of `failureGapsMs` × `SEARCH_QUEUE_ERROR_GAP_SAFETY` (`1.25`).
- On success: `minIntervalMs = max(min, minIntervalMs * decayPerSuccess)` — `decayPerSuccess` `0.75`, so a success quickly forgives.

This is why a single timeout backs off for 30s, while repeated captchas push the same route to minutes and then recover in steps.

## Selection (Finding the Best)

`select(engines, canUse)` does:

1. Split into `skipped` (circuit-open or backoff) and `eligible`.
2. Rank `eligible` by `scoreEngine()` (desc, tie-break alphabetically).
3. Pick `primary` as the least-recently-selected among the ranked set (fairness — avoids hammering the same winner).
4. Return `{ ordered: [primary, ...rest], skipped }`. The caller tries `ordered` sequentially.

## Circuit Breakers & Sequential Fallback

Separately from the scheduler, each route has a circuit at `SEARCH_ROUTE_CIRCUIT_OPEN_MS` (`300000` / 5m).
When a route fails hard (navigation or block), `recordRouteFailure` opens the circuit until `openUntil`. While open,
`canUse()` returns false → the scheduler marks it `skipped` with reason `route open`. After the cooldown the circuit
moves to `half_open` and one probe is allowed; if it succeeds the route rejoins.

Execution in `src/search.js`:

- The `ordered` list is tried in order. Each attempt has a page slot and `BROWSER_OP_TIMEOUT_MS`.
- On failure the error is `recordFailure`'d (scheduler) and `recordRouteFailure`'d (circuit), then the next route is tried.
- `fallbackAttempted` and `skipped` are returned alongside results so callers can see what was tried.
- Profiles and circuits are persisted to `.cache/search-engine-profiles.json` and `.cache/search-circuit-breakers.json` — a restart keeps the learning.

## Resilience

The system returns results reliably because:

- **No single point of failure** — there are 12 independent engines; `select_best` expands to the full fallback set.
- **Failures don't abort** — the loop continues to the next eligible route instead of throwing on first error.
- **Unhealthy routes are excluded early** — backoff and circuit breakers keep the tried set small and fresh, so a request isn't stuck retrying a dead engine.
- **One success is enough** — the first route that returns results resolves the query; the remaining routes are not tried.

In practice a query like `who is Albert Einstein` will be served by whichever of `duckduckgo_api`, `brave`, `bing`, etc. is healthy right now — often the first in `ordered`, sometimes the second or third after a timeout, but rarely all 12.

## Observability

- `/console` — per-engine health, scores, median latency, cooldowns, last errors.
- `/health` — circuit state (`open`, `half_open` probe, remaining ms).
- `GET /stats` — persisted profiles (`rank`, `state: healthy | cooling_down | probe | unknown`).

Tune only if you have a reason: most deployments work best with the defaults.
