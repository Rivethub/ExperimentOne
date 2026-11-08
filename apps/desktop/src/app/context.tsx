import { createContext, useContext } from "react";
import type { useAccounts } from "#hooks/use-accounts";
import type { useAppOperations } from "#hooks/use-app-operations";
import type { useQuotaDerived } from "#hooks/use-quota-derived";
import type { useRivetData } from "#hooks/use-rivet-data";
import type { SettingsTab } from "#lib/types";
import type { QuotaAccountUx } from "#quota";

export type AppContextValue = {
  rivet: ReturnType<typeof useRivetData>;
  ops: ReturnType<typeof useAppOperations>;
  accounts: ReturnType<typeof useAccounts>;
  /** Shared derived helpers (limit hit, status counts). Page-specific filters stay in routes. */
  derived: ReturnType<typeof useQuotaDerived>;
  busy: boolean;
  horizon: "1h" | "3h" | "6h";
  setHorizon: (horizon: "1h" | "3h" | "6h") => void;
  limitBannerHidden: boolean;
  hideLimitBanner: () => void;
  detailAccount: QuotaAccountUx | null;
  setDetailAccount: (account: QuotaAccountUx | null) => void;
  onboardingDismissed: boolean;
  dismissOnboardingUi: () => void;
  openSettings: (tab?: SettingsTab) => void;
};

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({
  value,
  children,
}: {
  value: AppContextValue;
  children: React.ReactNode;
}): React.ReactElement {
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (value === null) {
    throw new Error("useApp must be used within AppProvider");
  }
  return value;
}
