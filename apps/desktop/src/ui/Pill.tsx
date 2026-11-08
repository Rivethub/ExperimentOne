import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactElement } from "react";
import { Badge } from "#components/ui/badge";
import { cn } from "#lib/utils";

const pillTone = cva("", {
  variants: {
    tone: {
      default: "border-transparent bg-secondary text-muted-foreground",
      ok: "border-transparent bg-emerald-400/12 text-emerald-400",
      bad: "border-transparent bg-red-400/12 text-red-400",
      warn: "border-transparent bg-orange-400/12 text-orange-400",
      claude: "border-transparent bg-[var(--claude-dim)] text-[var(--claude)]",
      codex: "border-transparent bg-[var(--codex-dim)] text-[var(--codex)]",
    },
  },
  defaultVariants: {
    tone: "default",
  },
});

export type PillTone = NonNullable<VariantProps<typeof pillTone>["tone"]>;

export type PillProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof pillTone>;

export function Pill({ tone = "default", className, ...rest }: PillProps): ReactElement {
  return (
    <Badge
      variant="secondary"
      className={cn("gap-1.5 px-2 py-0.5 text-[11px] font-semibold", pillTone({ tone }), className)}
      {...rest}
    />
  );
}
