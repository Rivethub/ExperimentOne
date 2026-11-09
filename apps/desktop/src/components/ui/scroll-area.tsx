import type { JSX, ParentProps } from "solid-js";
import { splitProps } from "solid-js";
import { cn } from "#lib/utils";

/** Lightweight scroll region — Kobalte has no ScrollArea; keep the shadcn API surface. */
function ScrollArea(props: ParentProps<JSX.HTMLAttributes<HTMLDivElement>>) {
  const [local, rest] = splitProps(props, ["class", "children"]);
  return (
    <div data-slot="scroll-area" class={cn("relative overflow-hidden", local.class)} {...rest}>
      <div
        data-slot="scroll-area-viewport"
        class="size-full overflow-auto rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1"
      >
        {local.children}
      </div>
    </div>
  );
}

function ScrollBar(_props: { orientation?: "vertical" | "horizontal"; class?: string }) {
  return null;
}

export { ScrollArea, ScrollBar };
