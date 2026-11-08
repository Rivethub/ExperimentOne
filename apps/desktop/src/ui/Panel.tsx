import type { HTMLAttributes, ReactElement, ReactNode } from "react";
import { isDefined } from "../nullish";
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
}: PanelProps): ReactElement {
  const hasHead = isDefined(title) || isDefined(actions);
  let ledeBlock: ReactElement | null = null;
  if (hasHead) {
    ledeBlock = null;
  } else if (isDefined(lede)) {
    ledeBlock = <p className={styles.lede}>{lede}</p>;
  }

  return (
    <Tag className={cx(styles.panel, className)} {...rest}>
      {hasHead ? (
        <div className={styles.head}>
          <div>
            {isDefined(title) ? <h2>{title}</h2> : null}
            {isDefined(lede) ? <p className={styles.lede}>{lede}</p> : null}
          </div>
          {actions}
        </div>
      ) : (
        ledeBlock
      )}
      {children}
    </Tag>
  );
}

export function Lede({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>): ReactElement {
  return <p className={cx(styles.lede, className)} {...rest} />;
}
