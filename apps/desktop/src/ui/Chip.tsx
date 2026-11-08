import type { ButtonHTMLAttributes, ReactNode } from "react";
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
}: ChipProps) {
  return (
    <button
      type={type}
      className={cx(styles.chip, active && styles.active, className)}
      {...rest}
    >
      {dotColor ? <span className={styles.dot} style={{ background: dotColor }} /> : null}
      {children}
      {count != null ? <span className={styles.count}>{count}</span> : null}
    </button>
  );
}
