import type { ReactElement, ReactNode } from "react";
import { cx } from "../styles/cx";
import styles from "../styles/app.module.css";

export function RuntimePaneCard({
  title,
  statusLabel,
  statusClass,
  children,
  foot,
}: {
  title: string;
  statusLabel: string;
  statusClass: string;
  children: ReactNode;
  foot?: ReactNode;
}): ReactElement {
  return (
    <div className={styles.runtimeCard}>
      <div className={styles.runtimeCardHead}>
        <span>{title}</span>
        <span className={cx(styles.pill, statusClass)}>{statusLabel}</span>
      </div>
      <div className={styles.runtimeCardBody}>{children}</div>
      {foot !== undefined ? <div className={styles.runtimeCardFoot}>{foot}</div> : null}
    </div>
  );
}

export function RuntimeKv({ label, value, title }: { label: string; value: string; title?: string }): ReactElement {
  return (
    <div className={styles.kvRow}>
      <span className={styles.k}>{label}</span>
      <span className={styles.v} title={title}>
        {value}
      </span>
    </div>
  );
}
