import type { InputHTMLAttributes } from "react";
import { cx } from "../styles/cx";
import styles from "./Input.module.css";

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  /** Monospace path-style input (default) vs plain body text. */
  tone?: "mono" | "plain";
};

export function Input({ tone = "mono", className, ...rest }: InputProps) {
  return (
    <input
      className={cx(styles.input, tone === "plain" && styles.plain, className)}
      {...rest}
    />
  );
}
