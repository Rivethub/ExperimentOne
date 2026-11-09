import type { JSX } from "solid-js";
import { Match, Switch } from "solid-js";
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

export function SettingsPane(props: SettingsPaneProps): JSX.Element {
  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <div class="bg-background flex-1 overflow-auto px-4 py-4 pb-9 md:px-6">
        <Switch>
          <Match when={props.settingsTab === "accounts"}>
            <AccountsTab {...props.accounts} />
          </Match>
          <Match when={props.settingsTab === "intelligence"}>
            <IntelligenceTab {...props.intelligence} />
          </Match>
          <Match when={props.settingsTab === "harness"}>
            <HarnessTab {...props.harness} />
          </Match>
        </Switch>
      </div>
    </div>
  );
}
