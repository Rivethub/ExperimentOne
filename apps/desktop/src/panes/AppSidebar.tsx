import { NAV, SETTINGS_TABS } from "../constants";
import type { Page, SettingsTab } from "../types";
import { cx } from "../styles/cx";
import styles from "../styles/app.module.css";

export type AppSidebarProps = {
  page: Page;
  settingsTab: SettingsTab;
  accountCount: number;
  trafficEventCount: number;
  onNavigate: (page: Page) => void;
  onOpenSettings: (tab: SettingsTab) => void;
};

export function AppSidebar({
  page,
  settingsTab,
  accountCount,
  trafficEventCount,
  onNavigate,
  onOpenSettings,
}: AppSidebarProps) {
  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}>
        <div className={styles.brandMark}>R</div>
        <div className={styles.brandCopy}>
          <strong>Rivet</strong>
          <span>local traffic hub</span>
        </div>
      </div>
      {NAV.map((item) => (
        <div key={item.id} className={styles.navGroup}>
          <button
            type="button"
            className={cx(styles.navBtn, page === item.id ? styles.active : "")}
            onClick={() => {
              if (item.id === "settings") {
                onOpenSettings(settingsTab);
              } else {
                onNavigate(item.id);
              }
            }}
          >
            <span className={styles.ico}>{item.icon}</span>
            {item.label}
            {item.id === "settings" && accountCount > 0 && (
              <span className={styles.badge}>{accountCount}</span>
            )}
            {item.id === "traffic" && trafficEventCount > 0 && (
              <span className={styles.badge}>
                {trafficEventCount > 99 ? "99+" : trafficEventCount}
              </span>
            )}
          </button>
          {item.id === "settings" && page === "settings" && (
            <div className={styles.navSub} role="navigation" aria-label="Settings sections">
              {SETTINGS_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={cx(styles.navSubBtn, settingsTab === tab.id ? styles.active : "")}
                  onClick={() => onOpenSettings(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </aside>
  );
}
