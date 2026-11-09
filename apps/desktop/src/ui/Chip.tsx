import { cva, type VariantProps } from "class-variance-authority";
import type { JSX } from "solid-js";
import { Show, splitProps } from "solid-js";
import { Button } from "#components/ui/button";
import { isDefined } from "#lib/nullish";
import { cn } from "#lib/utils";

const chipVariants = cva(
  "h-auto gap-2 rounded-lg px-2.5 py-1.5 text-[13px] font-normal text-muted-foreground hover:bg-accent hover:text-foreground",
  {
    variants: {
      active: {
        true: "border border-border bg-secondary text-foreground",
        false: "border border-transparent bg-transparent",
      },
    },
    defaultVariants: {
      active: false,
    },
  },
);

export type ChipProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof chipVariants> & {
    dotColor?: string;
    count?: JSX.Element;
  };

export function Chip(props: ChipProps): JSX.Element {
  const [local, rest] = splitProps(props, [
    "active",
    "dotColor",
    "count",
    "class",
    "type",
    "children",
  ]);
  const hasDot = () => local.dotColor !== undefined && local.dotColor !== "";
  return (
    <Button
      type={local.type ?? "button"}
      variant="ghost"
      class={cn(chipVariants({ active: local.active }), local.class)}
      {...rest}
    >
      <Show when={hasDot()}>
        <span class="size-2 shrink-0 rounded-full" style={{ background: local.dotColor }} />
      </Show>
      {local.children}
      <Show when={isDefined(local.count)}>
        <span class="tabular-nums text-muted-foreground/80">{local.count}</span>
      </Show>
    </Button>
  );
}
