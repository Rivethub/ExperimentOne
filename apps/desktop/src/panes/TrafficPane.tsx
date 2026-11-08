import {
  providerChipLabel,
  providerColor,
  providerKey,
  type CatalogProvider,
} from "../providerUtils";
import { LimitRecoveryBanner, type LimitHitInfo } from "../quota";
import { splitTrafficBody, trafficTokenLabel, trunc } from "../trafficUtils";
import type { ProviderFilter, TrafficEvent } from "../types";
import { Button, Chip, Empty, FieldRow, Input, Panel, Pill, Snippet } from "../ui";
import { cx } from "../styles/cx";
import styles from "../styles/app.module.css";

export type TrafficPaneProps = {
  active: boolean;
  limitHit: LimitHitInfo | null;
  limitActions: {
    onRefreshCredentials: () => void;
    onSwitchAccount: () => void;
    onWait: () => void;
  };
  trafficProvider: ProviderFilter;
  onTrafficProviderChange: (provider: ProviderFilter) => void;
  providerIds: string[];
  catalog: CatalogProvider[];
  trafficStatus: "all" | "ok" | "error";
  onTrafficStatusChange: (status: "all" | "ok" | "error") => void;
  trafficQuery: string;
  onTrafficQueryChange: (query: string) => void;
  onSearch: () => void;
  busy: boolean;
  filteredTraffic: TrafficEvent[];
  trafficRows: TrafficEvent[];
  selectedEvent: TrafficEvent | null;
  onSelectEvent: (ev: TrafficEvent | null) => void;
};

export function TrafficPane({
  active,
  limitHit,
  limitActions,
  trafficProvider,
  onTrafficProviderChange,
  providerIds,
  catalog,
  trafficStatus,
  onTrafficStatusChange,
  trafficQuery,
  onTrafficQueryChange,
  onSearch,
  busy,
  filteredTraffic,
  trafficRows,
  selectedEvent,
  onSelectEvent,
}: TrafficPaneProps) {
  return (
    <div
      className={cx(styles.viewPane, active ? styles.isActive : "")}
      hidden={!active}
      aria-hidden={!active}
    >
      <LimitRecoveryBanner
        hit={limitHit}
        onRefreshCredentials={limitActions.onRefreshCredentials}
        onSwitchAccount={limitActions.onSwitchAccount}
        onWait={limitActions.onWait}
      />
      <Panel
        className={styles.trafficPage}
        title="Captured requests"
        lede="Search local traffic history. Bodies get best-effort secret redaction before store and export."
      >
        <div className={styles.filters} style={{ marginBottom: 10 }}>
          <Chip active={trafficProvider === "all"} onClick={() => onTrafficProviderChange("all")}>
            All
          </Chip>
          {providerIds.map((id) => (
            <Chip
              key={id}
              active={trafficProvider === id}
              dotColor={providerColor(id, catalog)}
              onClick={() => onTrafficProviderChange(id)}
            >
              {providerChipLabel(id, catalog)}
            </Chip>
          ))}
          <div className={styles.seg} style={{ marginLeft: 4 }}>
            {(
              [
                ["all", "Any status"],
                ["ok", "2xx"],
                ["error", "4xx/5xx"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                className={trafficStatus === id ? "active" : ""}
                onClick={() => onTrafficStatusChange(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <FieldRow flush>
          <Input
            placeholder="Search content, model, session…"
            value={trafficQuery}
            onChange={(e) => onTrafficQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSearch();
            }}
          />
          <Button variant="primary" disabled={busy} onClick={onSearch}>
            Search
          </Button>
        </FieldRow>
        <div className={cx(styles.trafficLayout, selectedEvent ? styles.hasDetail : "")}>
          <div className={styles.trafficTable}>
            <div className={styles.trafficHead}>
              <span>When</span>
              <span>Provider</span>
              <span>Model</span>
              <span className={styles.trafficTokens}>Tokens</span>
              <span>Preview</span>
            </div>
            {filteredTraffic.length === 0 ? (
              <Empty>
                {trafficRows.length === 0
                  ? "No events yet — start the proxy to capture traffic."
                  : "No events match these filters."}
              </Empty>
            ) : (
              filteredTraffic.map((ev) => (
                <button
                  key={ev.id}
                  className={cx(
                    styles.trafficRow,
                    selectedEvent?.id === ev.id ? styles.active : "",
                  )}
                  onClick={() => onSelectEvent(ev)}
                >
                  <span className={styles.mono}>
                    {new Date(ev.ts).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <span className={styles.trafficProvider}>
                    <Pill
                      style={{
                        background: `${providerColor(providerKey(ev.provider), catalog)}22`,
                        color: providerColor(providerKey(ev.provider), catalog),
                      }}
                    >
                      {providerChipLabel(providerKey(ev.provider), catalog)}
                    </Pill>
                    {ev.status_code != null && ev.status_code >= 400 && (
                      <Pill tone="bad">{ev.status_code}</Pill>
                    )}
                  </span>
                  <span className={styles.mono}>{ev.model ?? "—"}</span>
                  <span className={cx(styles.mono, styles.trafficTokens)}>
                    {trafficTokenLabel(ev)}
                  </span>
                  <span className={styles.preview}>{trunc(ev.content, 80)}</span>
                </button>
              ))
            )}
          </div>
          {selectedEvent &&
            (() => {
              const bodies = splitTrafficBody(selectedEvent.content);
              return (
                <div className={styles.eventDetail}>
                  <div className={styles.eventDetailHead}>
                    <div className={styles.eventDetailTitle}>
                      <strong>
                        {providerChipLabel(providerKey(selectedEvent.provider), catalog)}
                      </strong>
                      <span className={styles.mono}>{selectedEvent.model ?? "—"}</span>
                      <span className={styles.eventDetailWhen}>
                        {new Date(selectedEvent.ts).toLocaleString([], {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </span>
                    </div>
                    <Button variant="ghost" onClick={() => onSelectEvent(null)}>
                      Close
                    </Button>
                  </div>
                  <div className={styles.eventDetailMeta}>
                    <div className={styles.item}>
                      <span className={styles.k}>Status</span>
                      <span className={styles.v}>{selectedEvent.status_code ?? "—"}</span>
                    </div>
                    <div className={styles.item}>
                      <span className={styles.k}>Latency</span>
                      <span className={styles.v}>
                        {selectedEvent.latency_ms != null ? `${selectedEvent.latency_ms} ms` : "—"}
                      </span>
                    </div>
                    <div className={styles.item}>
                      <span className={styles.k}>Account</span>
                      <span className={styles.v}>{selectedEvent.account_label ?? "—"}</span>
                    </div>
                    <div className={styles.item}>
                      <span className={styles.k}>Role</span>
                      <span className={styles.v}>{selectedEvent.role ?? "—"}</span>
                    </div>
                  </div>
                  <div className={styles.eventDetailBodies}>
                    <div className={styles.eventBodyBlock}>
                      <div className={styles.eventBodyLabel}>Request</div>
                      <Snippet>{bodies.request}</Snippet>
                    </div>
                    {bodies.response != null && (
                      <div className={styles.eventBodyBlock}>
                        <div className={styles.eventBodyLabel}>Response</div>
                        <Snippet>{bodies.response}</Snippet>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}
        </div>
      </Panel>
    </div>
  );
}
