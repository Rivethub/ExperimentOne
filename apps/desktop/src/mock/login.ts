import type { QuotaAccountUx } from "../quota";
import { getStore, rebuildDerivedQuota } from "./store";

function mockPlanForProvider(provider: string): string {
  if (provider === "claude") {
    return "Claude Pro";
  }
  if (provider === "codex") {
    return "ChatGPT Plus";
  }
  return "Mock";
}

export function delayLoginComplete(provider: string): void {
  const store = getStore();
  if (store.loginTimer) {
    clearTimeout(store.loginTimer);
  }
  store.loginTimer = setTimeout(() => {
    const active = getStore();
    if (active.login?.active !== true) {
      return;
    }
    const id = `${provider}-mock-${Date.now().toString(36)}`;
    const account: QuotaAccountUx = {
      id,
      provider,
      label: `${provider}@mock.local`,
      email: `${provider}@mock.local`,
      plan: mockPlanForProvider(provider),
      remaining_pct: 100,
      reset_at: new Date(Date.now() + 5 * 3_600_000).toISOString(),
      cooldown_seconds: null,
      supports_quota: true,
      loaded: true,
      status: "loaded",
      windows: [
        {
          id: "primary",
          label: "Primary",
          remaining_pct: 100,
          reset_at: new Date(Date.now() + 5 * 3_600_000).toISOString(),
        },
      ],
    };
    active.quotaAccounts.push(account);
    rebuildDerivedQuota();
    active.login = {
      active: true,
      provider,
      output: `${active.login.output}\n\nLogin complete — credential ${id} stored (mock).`,
      done: true,
      success: true,
    };
    active.loginTimer = null;
  }, 1800);
}
