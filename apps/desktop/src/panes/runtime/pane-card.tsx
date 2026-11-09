import type { JSX } from "solid-js";
import { KvRow, Panel, Pill, type PillTone } from "../../ui";

export function RuntimePaneCard({
  title,
  statusLabel,
  statusTone = "default",
  children,
  foot,
}: {
  title: string;
  statusLabel: string;
  statusTone?: PillTone;
  children: JSX.Element;
  foot?: JSX.Element;
}): JSX.Element {
  return (
    <Panel
      class="mb-0 min-h-[168px] rounded-[14px] bg-gradient-to-b from-[#121216] to-[#0e0e12] py-4 shadow-none"
      title={title}
      actions={<Pill tone={statusTone}>{statusLabel}</Pill>}
    >
      <div class="flex flex-1 flex-col gap-0">{children}</div>
      {foot !== undefined ? <div class="mt-auto flex flex-wrap gap-2 pt-2">{foot}</div> : null}
    </Panel>
  );
}

export function RuntimeKv({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}): JSX.Element {
  return <KvRow label={label} value={value} title={title} />;
}
