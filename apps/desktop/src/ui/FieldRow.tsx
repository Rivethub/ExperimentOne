import type { HTMLAttributes, ReactElement } from "react";
import { cx } from "../styles/cx";
import styles from "./FieldRow.module.css";

export type FieldRowProps = HTMLAttributes<HTMLDivElement> & {
  /** Remove the default top margin. */
  flush?: boolean;
};

export function FieldRow({ flush, className, ...rest }: FieldRowProps): ReactElement {
  return <div className={cx(styles.row, flush === true && styles.flush, className)} {...rest} />;
}
