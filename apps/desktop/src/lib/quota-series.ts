import { fmt, providerKey } from "./provider-utils";
import { isDefined } from "./nullish";
import type { QuotaHistory, QuotaHistoryPoint, TrafficEvent } from "./types";

export type Series = {
  recorded: number[];
  projected: number[];
  headline: number;
  headlineUnit: string;
  emptyAt: string;
  burnLabel: string;
  eventsInWindow: number;
};

export function horizonMs(h: "1h" | "3h" | "6h"): number {
  return { "1h": 1, "3h": 3, "6h": 6 }[h] * 60 * 60 * 1000;
}

export function inHorizon(ev: TrafficEvent, horizon: "1h" | "3h" | "6h"): boolean {
  const ts = Date.parse(ev.ts);
  if (Number.isNaN(ts)) {
    return true;
  }
  return Date.now() - ts <= horizonMs(horizon);
}

export function historyPointsForProvider(
  history: QuotaHistory | null | undefined,
  provider: string,
): QuotaHistoryPoint[] {
  return history?.providers.find((p) => providerKey(p.provider) === provider)?.points ?? [];
}

function headlineUnitForRemaining(endRemaining: number | null, capacity: number): string {
  if (!isDefined(endRemaining)) {
    return "no samples yet";
  }
  if (capacity > 0) {
    return `% / ${Math.round(capacity)}`;
  }
  return "%";
}

/** Remaining-% chart from persisted live quota samples (not invented). */
export function seriesFromRemainingHistory(
  historyPoints: QuotaHistoryPoint[],
  horizon: "1h" | "3h" | "6h",
  points = 24,
  liveRemainingPct?: number | null,
  liveCapacityPct?: number | null,
): Series {
  const bucketMs = horizonMs(horizon) / points || 1;
  const now = Date.now();
  const start = now - horizonMs(horizon);
  const buckets: (number | null)[] = Array.from({ length: points }, () => null);

  for (const p of historyPoints) {
    const ts = Date.parse(p.ts);
    if (Number.isNaN(ts) || ts < start) {
      /* skip out-of-window */
    } else {
      const idx = Math.min(points - 1, Math.max(0, Math.floor((ts - start) / bucketMs)));
      buckets[idx] = p.remaining_pct;
    }
  }

  let last: number | null = null;
  const recorded = buckets.map((v) => {
    if (isDefined(v) && Number.isFinite(v)) {
      last = Math.max(0, v);
      return Number(last.toFixed(1));
    }
    return isDefined(last) ? Number(last.toFixed(1)) : 0;
  });
  const hasSamples = buckets.some((v) => isDefined(v));
  if (!hasSamples && isDefined(liveRemainingPct) && Number.isFinite(liveRemainingPct)) {
    const tail = recorded.length - 1;
    if (tail >= 0) {
      recorded[tail] = Number(Math.max(0, liveRemainingPct).toFixed(1));
    }
  }

  const capacity = Math.max(0, liveCapacityPct ?? 0);
  let endRemaining: number | null = null;
  if (isDefined(liveRemainingPct) && Number.isFinite(liveRemainingPct)) {
    endRemaining = Math.max(0, liveRemainingPct);
  } else if (hasSamples) {
    const tail = recorded.at(-1);
    endRemaining = isDefined(tail) ? tail : null;
  }

  return {
    recorded,
    projected: recorded.slice(),
    headline: isDefined(endRemaining) ? Number(endRemaining.toFixed(0)) : 0,
    headlineUnit: headlineUnitForRemaining(endRemaining, capacity),
    emptyAt: hasSamples || isDefined(endRemaining) ? "Steady" : "Waiting for live samples",
    burnLabel: "—",
    eventsInWindow: historyPoints.filter((p) => {
      const ts = Date.parse(p.ts);
      return !Number.isNaN(ts) && ts >= start;
    }).length,
  };
}

function estimateEmptyAt(
  filteredCount: number,
  endRemaining: number | null,
  remainingTokens: number | null,
  burnPerHour: number,
): string {
  if (isDefined(remainingTokens) && burnPerHour > 1) {
    const hoursLeft = remainingTokens / burnPerHour;
    return hoursLeft < 1
      ? `est. ~${Math.round(hoursLeft * 60)}m @ 80k/acct`
      : `est. ~${hoursLeft.toFixed(1)}h @ 80k/acct`;
  }
  if (filteredCount === 0 && !isDefined(endRemaining)) {
    return "Sign in to track";
  }
  return "Steady";
}

/** Build chart series from measured traffic burn. */
export function seriesFromEvents(
  events: TrafficEvent[],
  provider: string,
  horizon: "1h" | "3h" | "6h",
  points = 24,
  liveRemainingPct?: number | null,
): Series {
  const filtered = events
    .filter((e) => providerKey(e.provider) === provider && inHorizon(e, horizon))
    .toSorted((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  const hours = { "1h": 1, "3h": 3, "6h": 6 }[horizon];
  const bucketMs = horizonMs(horizon) / points || 1;
  const now = Date.now();
  const tokensPerBucket: number[] = Array.from({ length: points }, () => 0);

  for (const e of filtered) {
    const ts = Date.parse(e.ts);
    if (Number.isNaN(ts)) {
      /* skip */
    } else {
      const idx = Math.min(
        points - 1,
        Math.max(0, Math.floor((ts - (now - horizonMs(horizon))) / bucketMs)),
      );
      const prev = tokensPerBucket[idx] ?? 0;
      tokensPerBucket[idx] = prev + e.tokens_in + e.tokens_out;
    }
  }

  const totalTokens = tokensPerBucket.reduce((a, b) => a + b, 0);
  const sampleTs = filtered.map((e) => Date.parse(e.ts)).filter((t) => !Number.isNaN(t));
  const sampleSpanH =
    sampleTs.length >= 2
      ? Math.max(0.05, (Math.max(...sampleTs) - Math.min(...sampleTs)) / 3_600_000)
      : hours;
  const burnPerHour = sampleSpanH > 0 ? totalTokens / sampleSpanH : totalTokens;
  const endRemaining =
    isDefined(liveRemainingPct) && Number.isFinite(liveRemainingPct)
      ? Math.max(0, liveRemainingPct)
      : null;

  const burnSeries = tokensPerBucket.slice();
  const maxBurn = Math.max(1, ...burnSeries);
  const recorded = burnSeries.map((v) => Number(((v / maxBurn) * 100).toFixed(1)));

  const remainingTokens = isDefined(endRemaining) ? (endRemaining / 100) * 80_000 : null;
  const emptyAt = estimateEmptyAt(filtered.length, endRemaining, remainingTokens, burnPerHour);

  return {
    recorded,
    projected: recorded.slice(),
    headline: Math.round(burnPerHour),
    headlineUnit: "tok/h",
    emptyAt,
    burnLabel: `${fmt(Math.round(burnPerHour))} tok/h`,
    eventsInWindow: filtered.length,
  };
}
