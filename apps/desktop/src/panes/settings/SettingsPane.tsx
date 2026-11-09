import type { JSX } from "solid-js";
import { AccountsTab } from "./AccountsTab";
import { HarnessTab } from "./HarnessTab";
import { IntelligenceTab } from "./IntelligenceTab";
import type { SettingsPaneProps } from "./types";

export type {
  SettingsAccountsProps,
  SettingsHarnessProps,
  SettingsIntelligenceProps,
  SettingsPaneProps,
} from "./types";

export function SettingsPane({
  settingsTab,
  accounts,
  intelligence,
  harness,
}: SettingsPaneProps): JSX.Element {
  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <div class="flex-1 overflow-auto bg-background px-6 py-4 pb-9">
        {settingsTab === "accounts" && <AccountsTab {...accounts} />}
        {settingsTab === "intelligence" && <IntelligenceTab {...intelligence} />}
        {settingsTab === "harness" && <HarnessTab {...harness} />}
      </div>
    </div>
  );
}
