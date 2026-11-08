import type { ButtonHTMLAttributes, ReactElement, ReactNode } from "react";
import { isDefined } from "../lib/nullish";
import { cx } from "../styles/cx";
import styles from "./Chip.module.css";

export type ChipProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  dotColor?: string;
  count?: ReactNode;
};

export function Chip({
  active,
  dotColor,
  count,
  className,
  type = "button",
  children,
  ...rest
}: ChipProps): ReactElement {
  const hasDot = dotColor !== undefined && dotColor !== "";
  return (
    <button
      type={type}
      className={cx(styles.chip, active === true && styles.active, className)}
      {...rest}
    >
      {hasDot ? <span className={styles.dot} style={{ background: dotColor }} /> : null}
      {children}
      {isDefined(count) ? <span className={styles.count}>{count}</span> : null}
    </button>
  );
}
