import { createContext, useContext, type JSX, type ParentProps, type Setter } from "solid-js";
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
  busy: () => boolean;
  horizon: () => "1h" | "3h" | "6h";
  setHorizon: Setter<"1h" | "3h" | "6h">;
  limitBannerHidden: () => boolean;
  hideLimitBanner: () => void;
  detailAccount: () => QuotaAccountUx | null;
  setDetailAccount: Setter<QuotaAccountUx | null>;
  onboardingDismissed: () => boolean;
  dismissOnboardingUi: () => void;
  openSettings: (tab?: SettingsTab) => void;
};

const AppContext = createContext<AppContextValue>();

export function AppProvider(props: ParentProps<{ value: AppContextValue }>): JSX.Element {
  return <AppContext.Provider value={props.value}>{props.children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (value === undefined) {
    throw new Error("useApp must be used within AppProvider");
  }
  return value;
}
