import { isDefined } from "../nullish";
import type { ProviderQuota } from "../types";
import type { MetricMode } from "./types";
import type { Series } from "../quotaSeries";

export function isKnownProviderQuota(pq: ProviderQuota | null): boolean {
  return pq !== null && pq.capacity_pct > 0 && Number.isFinite(pq.remaining_pct);
}

export function quotaCardHeadline(args: {
  metricMode: MetricMode;
  series: Series;
  knownQuota: boolean;
  capacity: number;
  remaining: number | null;
  costHeadline: number;
}): { headline: number; unit: string } {
  const { metricMode, series, knownQuota, capacity, remaining, costHeadline } = args;
  if (metricMode === "limits") {
    const headline = knownQuota && isDefined(remaining) ? Number(remaining.toFixed(0)) : series.headline;
    const unit = knownQuota ? `% / ${Math.round(capacity)}` : series.headlineUnit;
    return { headline, unit };
  }
  if (metricMode === "cost") {
    return { headline: costHeadline, unit: "est. USD" };
  }
  return { headline: series.headline, unit: series.headlineUnit };
}

export function quotaCapLabel(metricMode: MetricMode, pq: ProviderQuota | null): string {
  if (metricMode === "limits") {
    return "subscription windows";
  }
  if (metricMode === "cost") {
    return "labeled estimate";
  }
  if (pq !== null) {
    return "live + traffic burn";
  }
  return "from captured traffic";
}

export function quotaChartLegend(metricMode: MetricMode): string {
  if (metricMode === "limits") {
    return "Account remaining % (historical)";
  }
  if (metricMode === "cost") {
    return "Traffic volume (for cost context)";
  }
  return "Measured traffic burn";
}

export function quotaPoolEmpty(pq: ProviderQuota | null, seriesEmptyAt: string): string {
  const poolEmpty = pq?.pool_empty;
  if (isDefined(poolEmpty) && poolEmpty !== "" && poolEmpty !== "—") {
    return poolEmpty;
  }
  return seriesEmptyAt;
}
