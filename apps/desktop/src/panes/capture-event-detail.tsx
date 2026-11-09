import {
  providerChipLabel,
  providerColor,
  providerKey,
  type CatalogProvider,
} from "../lib/provider-utils";
import { isDefined } from "../lib/nullish";
import { splitCaptureBody, captureTokenLabel, trunc } from "../lib/capture-utils";
import type { CaptureEvent } from "../lib/types";
import { Button, Pill, Snippet } from "../ui";
import { cx } from "../styles/cx";
import styles from "../styles/app.module.css";

export function CaptureEventDetail({
  event,
  catalog,
  onClose,
}: {
  event: CaptureEvent;
  catalog: CatalogProvider[];
  onClose: () => void;
}): React.ReactElement {
  const bodies = splitCaptureBody(event.content);
  const providerId = providerKey(event.provider);

  return (
    <div className={styles.eventDetail}>
      <div className={styles.eventDetailHead}>
        <div className={styles.eventDetailTitle}>
          <strong>{providerChipLabel(providerId, catalog)}</strong>
          <span className={styles.mono}>{event.model ?? "—"}</span>
          <span className={styles.eventDetailWhen}>
            {new Date(event.ts).toLocaleString([], {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
        </div>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className={styles.eventDetailMeta}>
        <div className={styles.item}>
          <span className={styles.k}>Status</span>
          <span className={styles.v}>{event.status_code ?? "—"}</span>
        </div>
        <div className={styles.item}>
          <span className={styles.k}>Latency</span>
          <span className={styles.v}>
            {isDefined(event.latency_ms) ? `${event.latency_ms} ms` : "—"}
          </span>
        </div>
        <div className={styles.item}>
          <span className={styles.k}>Account</span>
          <span className={styles.v}>{event.account_label ?? "—"}</span>
        </div>
        <div className={styles.item}>
          <span className={styles.k}>Role</span>
          <span className={styles.v}>{event.role ?? "—"}</span>
        </div>
      </div>
      <div className={styles.eventDetailBodies}>
        <div className={styles.eventBodyBlock}>
          <div className={styles.eventBodyLabel}>Request</div>
          <Snippet>{bodies.request}</Snippet>
        </div>
        {isDefined(bodies.response) && (
          <div className={styles.eventBodyBlock}>
            <div className={styles.eventBodyLabel}>Response</div>
            <Snippet>{bodies.response}</Snippet>
          </div>
        )}
      </div>
    </div>
  );
}

export function CaptureEventRow({
  ev,
  catalog,
  selected,
  onSelect,
}: {
  ev: CaptureEvent;
  catalog: CatalogProvider[];
  selected: boolean;
  onSelect: (ev: CaptureEvent) => void;
}): React.ReactElement {
  const providerId = providerKey(ev.provider);
  const color = providerColor(providerId, catalog);
  const statusCode = ev.status_code;
  const showBadStatus = isDefined(statusCode) && statusCode >= 400;

  return (
    <button
      className={cx(styles.captureRow, selected ? styles.active : "")}
      onClick={() => {
        onSelect(ev);
      }}
    >
      <span className={styles.mono}>
        {new Date(ev.ts).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </span>
      <span className={styles.captureProvider}>
        <Pill
          style={{
            background: `${color}22`,
            color,
          }}
        >
          {providerChipLabel(providerId, catalog)}
        </Pill>
        {showBadStatus && <Pill tone="bad">{statusCode}</Pill>}
      </span>
      <span className={styles.mono}>{ev.model ?? "—"}</span>
      <span className={cx(styles.mono, styles.captureTokens)}>{captureTokenLabel(ev)}</span>
      <span className={styles.preview}>{trunc(ev.content, 80)}</span>
    </button>
  );
}
