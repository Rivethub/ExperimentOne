import type { JSX } from "solid-js";
import { Show, splitProps } from "solid-js";
import { isDefined } from "#lib/nullish";
import { cn } from "#lib/utils";

export function Kv(props: JSX.HTMLAttributes<HTMLDivElement>): JSX.Element {
  const [local, rest] = splitProps(props, ["class"]);
  return <div class={cn("grid gap-0", local.class)} {...rest} />;
}

export type KvRowProps = JSX.HTMLAttributes<HTMLDivElement> & {
  label?: JSX.Element;
  value?: JSX.Element;
  /** Drop the bottom rule / padding (status headers, etc.). */
  bare?: boolean;
};

export function KvRow(props: KvRowProps): JSX.Element {
  const [local, rest] = splitProps(props, ["label", "value", "bare", "class", "children"]);
  return (
    <div
      class={cn(
        "flex justify-between gap-4 text-[13px]",
        local.bare === true ? "border-0 p-0" : "border-b border-border/60 py-2.5 last:border-b-0",
        local.class,
      )}
      {...rest}
    >
      <Show when={isDefined(local.label)}>
        <span class="text-muted-foreground">{local.label}</span>
      </Show>
      <Show when={isDefined(local.value)}>
        <span class="text-right font-mono text-xs break-all text-foreground">{local.value}</span>
      </Show>
      {local.children}
    </div>
  );
}
