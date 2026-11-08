import { AccountsTab } from "./AccountsTab";
import { HarnessTab } from "./HarnessTab";
import { IntelligenceTab } from "./IntelligenceTab";
import type { SettingsPaneProps } from "./types";
import { cx } from "../../styles/cx";
import styles from "../../styles/app.module.css";

export type {
  SettingsAccountsProps,
  SettingsHarnessProps,
  SettingsIntelligenceProps,
  SettingsPaneProps,
} from "./types";

export function SettingsPane({
  active,
  settingsTab,
  accounts,
  intelligence,
  harness,
}: SettingsPaneProps): React.ReactElement {
  return (
    <div
      className={cx(styles.viewPane, active ? styles.isActive : "")}
      hidden={!active}
      aria-hidden={!active}
    >
      <div className={styles.settings}>
        <AccountsTab {...accounts} hidden={settingsTab !== "accounts"} />
        <IntelligenceTab {...intelligence} hidden={settingsTab !== "intelligence"} />
        <HarnessTab {...harness} hidden={settingsTab !== "harness"} />
      </div>
    </div>
  );
}
