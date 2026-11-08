import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../styles/cx";
import styles from "./Panel.module.css";

export type PanelProps = HTMLAttributes<HTMLElement> & {
  title?: ReactNode;
  lede?: ReactNode;
  /** Optional controls aligned opposite the title. */
  actions?: ReactNode;
  as?: "section" | "div" | "article";
};

export function Panel({
  title,
  lede,
  actions,
  as: Tag = "section",
  className,
  children,
  ...rest
}: PanelProps) {
  const hasHead = title != null || actions != null;
  return (
    <Tag className={cx(styles.panel, className)} {...rest}>
      {hasHead ? (
        <div className={styles.head}>
          <div>
            {title != null ? <h2>{title}</h2> : null}
            {lede != null ? <p className={styles.lede}>{lede}</p> : null}
          </div>
          {actions}
        </div>
      ) : lede != null ? (
        <p className={styles.lede}>{lede}</p>
      ) : null}
      {children}
    </Tag>
  );
}

export function Lede({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cx(styles.lede, className)} {...rest} />;
}
