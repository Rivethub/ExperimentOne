import type { HTMLAttributes, ReactElement, ReactNode } from "react";
import { isDefined } from "../lib/nullish";
import { cx } from "../styles/cx";
import styles from "./Kv.module.css";

export function Kv({ className, ...rest }: HTMLAttributes<HTMLDivElement>): ReactElement {
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
}: KvRowProps): ReactElement {
  return (
    <div className={cx(styles.row, bare === true && styles.bare, className)} {...rest}>
      {isDefined(label) ? <span className={styles.k}>{label}</span> : null}
      {isDefined(value) ? <span className={styles.v}>{value}</span> : null}
      {children}
    </div>
  );
}
