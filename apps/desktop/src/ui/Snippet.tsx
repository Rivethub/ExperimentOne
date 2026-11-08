import type { HTMLAttributes } from "react";
import { cx } from "../styles/cx";
import styles from "./Snippet.module.css";

export function Snippet({ className, ...rest }: HTMLAttributes<HTMLPreElement>) {
  return <pre className={cx(styles.snippet, className)} {...rest} />;
}
