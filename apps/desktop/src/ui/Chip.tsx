import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes, ReactElement, ReactNode } from "react";
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

export type ChipProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof chipVariants> & {
    dotColor?: string;
    count?: ReactNode;
  };

export function Chip({
  active = false,
  dotColor,
  count,
  className,
  type = "button",
  children,
  ...rest
}: ChipProps): ReactElement {
  const hasDot = dotColor !== undefined && dotColor !== "";
  return (
    <Button
      type={type}
      variant="ghost"
      className={cn(chipVariants({ active }), className)}
      {...rest}
    >
      {hasDot ? (
        <span className="size-2 shrink-0 rounded-full" style={{ background: dotColor }} />
      ) : null}
      {children}
      {isDefined(count) ? (
        <span className="tabular-nums text-muted-foreground/80">{count}</span>
      ) : null}
    </Button>
  );
}
