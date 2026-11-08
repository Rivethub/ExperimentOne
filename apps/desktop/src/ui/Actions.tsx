import type { HTMLAttributes } from "react";
import { cx } from "../styles/cx";
import styles from "./Actions.module.css";

export type ActionsProps = HTMLAttributes<HTMLDivElement> & {
  /** Add the default top margin used under panel content. */
  spaced?: boolean;
  align?: "start" | "end";
};

export function Actions({ spaced = true, align = "start", className, ...rest }: ActionsProps) {
  return (
    <div
      className={cx(
        styles.actions,
        spaced && styles.stack,
        align === "end" && styles.end,
        className,
      )}
      {...rest}
    />
  );
}
