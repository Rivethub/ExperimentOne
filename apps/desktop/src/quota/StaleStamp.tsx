import type { JSX } from "solid-js";
import { formatCheckedAgo } from "../lib/provider-utils";
import { isDefined } from "../lib/nullish";
import styles from "../styles/app.module.css";

export function StaleStamp({
  observedAt,
}: {
  observedAt: string | null | undefined;
}): JSX.Element | null {
  if (!isDefined(observedAt) || observedAt === "") {
    return null;
  }
  return (
    <span class={styles.staleStamp} title={new Date(observedAt).toLocaleString()}>
      Checked {formatCheckedAgo(observedAt)}
    </span>
  );
}
