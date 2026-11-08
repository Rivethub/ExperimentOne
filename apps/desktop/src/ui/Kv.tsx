import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../styles/cx";
import styles from "./Kv.module.css";

export function Kv({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx(styles.kv, className)} {...rest} />;
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
}: KvRowProps) {
  return (
    <div className={cx(styles.row, bare && styles.bare, className)} {...rest}>
      {label != null ? <span className={styles.k}>{label}</span> : null}
      {value != null ? <span className={styles.v}>{value}</span> : null}
      {children}
    </div>
  );
}
