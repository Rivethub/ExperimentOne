import { formatCheckedAgo } from "../providerUtils";
import { isDefined } from "../nullish";
import styles from "../styles/app.module.css";

export function StaleStamp({
  observedAt,
}: {
  observedAt: string | null | undefined;
}): React.ReactElement | null {
  if (!isDefined(observedAt) || observedAt === "") {
    return null;
  }
  return (
    <span className={styles.staleStamp} title={new Date(observedAt).toLocaleString()}>
      Checked {formatCheckedAgo(observedAt)}
    </span>
  );
}
