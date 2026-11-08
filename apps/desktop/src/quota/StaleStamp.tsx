import { formatCheckedAgo } from "../providerUtils";
import styles from "../styles/app.module.css";

export function StaleStamp({ observedAt }: { observedAt: string | null | undefined }) {
  if (!observedAt) return null;
  return (
    <span className={styles.staleStamp} title={new Date(observedAt).toLocaleString()}>
      Checked {formatCheckedAgo(observedAt)}
    </span>
  );
}
