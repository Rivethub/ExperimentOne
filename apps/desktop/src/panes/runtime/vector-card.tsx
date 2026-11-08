import { formatRelativeIso } from "../../lib/format-utils";
import { fmt } from "../../lib/provider-utils";
import { isDefined } from "../../lib/nullish";
import type { Status } from "../../lib/types";
import styles from "../../styles/app.module.css";
import { RuntimeKv, RuntimePaneCard } from "./pane-card";

export function RuntimeVectorCard({ status }: { status: Status | null }): React.ReactElement {
  const on = status?.workers?.vector_search === true || status?.capabilities.vector_search === true;
  const model =
    isDefined(status?.embedding_model) && status.embedding_model !== ""
      ? status.embedding_model
      : "lexical (v1)";
  const cursor = status?.workers?.vectorize_cursor ?? undefined;

  return (
    <RuntimePaneCard
      title="Vector worker"
      statusLabel={on ? "on" : "off"}
      statusClass={on ? (styles.ok ?? "") : ""}
    >
      <RuntimeKv label="Embeddings" value={fmt(status?.workers?.embeddings ?? 0)} />
      <RuntimeKv
        label="Queue"
        value={`${fmt(status?.workers?.queue?.pending ?? 0)} pending · ${fmt(status?.workers?.queue?.running ?? 0)} running`}
      />
      <RuntimeKv label="Last run" value={formatRelativeIso(cursor)} title={cursor} />
      <RuntimeKv label="Model" value={model} />
    </RuntimePaneCard>
  );
}
