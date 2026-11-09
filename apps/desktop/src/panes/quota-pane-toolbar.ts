import type { MetricMode } from "../quota";

export function quotaMetricModeTitle(id: MetricMode): string {
  if (id === "limits") {
    return "Subscription windows + remaining history";
  }
  if (id === "tokens") {
    return "Token burn from captures";
  }
  return "Estimated API-equivalent cost (labeled rates)";
}
