import type { HTMLAttributes } from "react";
import { cx } from "../styles/cx";
import styles from "./Empty.module.css";

export function Empty({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cx(styles.empty, className)} {...rest} />;
}
