import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { KvRow, Panel, Pill, type PillTone } from "../../ui";

export function RuntimePaneCard(props: {
  title: string;
  statusLabel: string;
  statusTone?: PillTone;
  children: JSX.Element;
  foot?: JSX.Element;
}): JSX.Element {
  return (
    <Panel
      class="bg-card mb-0 min-h-[168px] py-4 shadow-none"
      title={props.title}
      actions={<Pill tone={props.statusTone ?? "default"}>{props.statusLabel}</Pill>}
    >
      <div class="flex flex-1 flex-col gap-0">{props.children}</div>
      <Show when={props.foot !== undefined}>
        <div class="mt-auto flex flex-wrap gap-2 pt-2">{props.foot}</div>
      </Show>
    </Panel>
  );
}

export function RuntimeKv(props: { label: string; value: string; title?: string }): JSX.Element {
  return <KvRow label={props.label} value={props.value} title={props.title} />;
}
