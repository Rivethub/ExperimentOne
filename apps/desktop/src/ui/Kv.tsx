import type { HTMLAttributes, ReactElement, ReactNode } from "react";
import { isDefined } from "#lib/nullish";
import { cn } from "#lib/utils";

export function Kv({ className, ...rest }: HTMLAttributes<HTMLDivElement>): ReactElement {
  return <div className={cn("grid gap-0", className)} {...rest} />;
}

export type KvRowProps = HTMLAttributes<HTMLDivElement> & {
  label?: ReactNode;
  value?: ReactNode;
  /** Drop the bottom rule / padding (status headers, etc.). */
  bare?: boolean;
};

export function KvRow({
  label,
  value,
  bare,
  className,
  children,
  ...rest
}: KvRowProps): ReactElement {
  return (
    <div
      className={cn(
        "flex justify-between gap-4 text-[13px]",
        bare === true ? "border-0 p-0" : "border-b border-border/60 py-2.5 last:border-b-0",
        className,
      )}
      {...rest}
    >
      {isDefined(label) ? <span className="text-muted-foreground">{label}</span> : null}
      {isDefined(value) ? (
        <span className="text-right font-mono text-xs break-all text-foreground">{value}</span>
      ) : null}
      {children}
    </div>
  );
}
