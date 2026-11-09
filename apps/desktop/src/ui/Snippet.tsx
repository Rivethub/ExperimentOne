import type { JSX } from "solid-js";
import { splitProps } from "solid-js";
import { cn } from "#lib/utils";

export function Snippet(props: JSX.HTMLAttributes<HTMLPreElement>): JSX.Element {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <pre
      class={cn(
        "mt-2.5 max-h-60 overflow-auto rounded-lg border border-border/60 bg-background p-3 font-mono text-xs break-words whitespace-pre-wrap text-zinc-300",
        local.class,
      )}
      {...rest}
    />
  );
}
