import type { HTMLAttributes } from "react";
import { cx } from "../styles/cx";
import styles from "./Pill.module.css";

export type PillTone = "default" | "ok" | "bad" | "warn" | "claude" | "codex";

export type PillProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: PillTone;
};

const toneClass: Record<PillTone, string | undefined> = {
  default: undefined,
  ok: styles.ok,
  bad: styles.bad,
  warn: styles.warn,
  claude: styles.claude,
  codex: styles.codex,
};

export function Pill({ tone = "default", className, ...rest }: PillProps) {
  return <span className={cx(styles.pill, toneClass[tone], className)} {...rest} />;
}
