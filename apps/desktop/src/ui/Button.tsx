import type { ButtonHTMLAttributes, HTMLAttributes, ReactElement } from "react";
import { cx } from "../styles/cx";
import styles from "./Button.module.css";

export type ButtonVariant = "default" | "primary" | "ghost" | "danger" | "link" | "provider";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
};

const variantClass: Record<ButtonVariant, string | undefined> = {
  default: undefined,
  primary: styles.primary,
  ghost: styles.ghost,
  danger: styles.danger,
  link: styles.link,
  provider: styles.provider,
};

export function Button({
  variant = "default",
  className,
  type = "button",
  children,
  ...rest
}: ButtonProps): ReactElement {
  return (
    <button type={type} className={cx(styles.btn, variantClass[variant], className)} {...rest}>
      {children}
    </button>
  );
}

/** Hint line under a provider login label. */
export function ButtonHint({ className, ...rest }: HTMLAttributes<HTMLSpanElement>): ReactElement {
  return <span className={cx(styles.providerHint, className)} {...rest} />;
}
