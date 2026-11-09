import type { ComponentProps } from "solid-js";
import { splitProps } from "solid-js";
import { Separator as SeparatorPrimitive } from "@kobalte/core/separator";
import { cn } from "#lib/utils";

function Separator(
  props: ComponentProps<typeof SeparatorPrimitive> & {
    orientation?: "horizontal" | "vertical";
    decorative?: boolean;
  },
) {
  const [local, rest] = splitProps(props, ["class", "orientation", "decorative"]);
  return (
    <SeparatorPrimitive
      data-slot="separator"
      decorative={local.decorative ?? true}
      orientation={local.orientation ?? "horizontal"}
      class={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        local.class,
      )}
      {...rest}
    />
  );
}

export { Separator };
