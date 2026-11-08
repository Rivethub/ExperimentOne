import type React from "react";
import type { HTMLAttributes } from "react";
import { cx } from "../styles/cx";
import styles from "./Banner.module.css";

export type BannerTone = "error" | "warn" | "note";

export type BannerProps = HTMLAttributes<HTMLDivElement> & {
  tone?: BannerTone;
};

const toneClass: Record<BannerTone, string> = {
  error: styles.error ?? "",
  warn: styles.warn ?? "",
  note: styles.note ?? "",
};

export function Banner({ tone = "note", className, ...rest }: BannerProps): React.ReactElement {
  return <div className={cx(styles.banner, toneClass[tone], className)} {...rest} />;
}
