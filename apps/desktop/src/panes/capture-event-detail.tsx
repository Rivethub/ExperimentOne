import type { JSX } from "solid-js";
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
import { cx, styles } from "#styles";

export function CaptureEventDetail({
  event,
  catalog,
  onClose,
}: {
  event: CaptureEvent;
  catalog: CatalogProvider[];
  onClose: () => void;
}): JSX.Element {
  const bodies = splitCaptureBody(event.content);
  const providerId = providerKey(event.provider);

  return (
    <div class={styles.eventDetail}>
      <div class={styles.eventDetailHead}>
        <div class={styles.eventDetailTitle}>
          <strong>{providerChipLabel(providerId, catalog)}</strong>
          <span class={styles.mono}>{event.model ?? "—"}</span>
          <span class={styles.eventDetailWhen}>
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
      <div class={styles.eventDetailMeta}>
        <div class={styles.item}>
          <span class={styles.k}>Status</span>
          <span class={styles.v}>{event.status_code ?? "—"}</span>
        </div>
        <div class={styles.item}>
          <span class={styles.k}>Latency</span>
          <span class={styles.v}>
            {isDefined(event.latency_ms) ? `${event.latency_ms} ms` : "—"}
          </span>
        </div>
        <div class={styles.item}>
          <span class={styles.k}>Account</span>
          <span class={styles.v}>{event.account_label ?? "—"}</span>
        </div>
        <div class={styles.item}>
          <span class={styles.k}>Role</span>
          <span class={styles.v}>{event.role ?? "—"}</span>
        </div>
      </div>
      <div class={styles.eventDetailBodies}>
        <div class={styles.eventBodyBlock}>
          <div class={styles.eventBodyLabel}>Request</div>
          <Snippet>{bodies.request}</Snippet>
        </div>
        {isDefined(bodies.response) && (
          <div class={styles.eventBodyBlock}>
            <div class={styles.eventBodyLabel}>Response</div>
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
}): JSX.Element {
  const providerId = providerKey(ev.provider);
  const color = providerColor(providerId, catalog);
  const statusCode = ev.status_code;
  const showBadStatus = isDefined(statusCode) && statusCode >= 400;

  return (
    <button
      class={cx(styles.captureRow, selected ? styles.active : "")}
      onClick={() => {
        onSelect(ev);
      }}
    >
      <span class={styles.mono}>
        {new Date(ev.ts).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </span>
      <span class={styles.captureProvider}>
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
      <span class={styles.mono}>{ev.model ?? "—"}</span>
      <span class={cx(styles.mono, styles.captureTokens)}>{captureTokenLabel(ev)}</span>
      <span class={styles.preview}>{trunc(ev.content, 80)}</span>
    </button>
  );
}
