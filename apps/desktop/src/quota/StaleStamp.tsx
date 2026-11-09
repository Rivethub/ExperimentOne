import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { formatCheckedAgo } from "../lib/provider-utils";
import { isDefined } from "../lib/nullish";
import { styles } from "#styles";

export function StaleStamp(props: { observedAt: string | null | undefined }): JSX.Element {
  return (
    <Show when={isDefined(props.observedAt) && props.observedAt !== ""}>
      <span class={styles.staleStamp} title={new Date(props.observedAt as string).toLocaleString()}>
        Checked {formatCheckedAgo(props.observedAt as string)}
      </span>
    </Show>
  );
}
