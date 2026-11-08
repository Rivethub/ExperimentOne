import type { ButtonHTMLAttributes, HTMLAttributes, ReactElement } from "react";
import { Button as ShadcnButton } from "#components/ui/button";
import { cn } from "#lib/utils";

const variantMap = {
  default: "outline",
  primary: "default",
  ghost: "ghost",
  danger: "destructive",
  link: "link",
  provider: "outline",
} as const;

export type ButtonVariant = keyof typeof variantMap;

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
};

export function Button({
  variant = "default",
  className,
  type = "button",
  children,
  ...rest
}: ButtonProps): ReactElement {
  return (
    <ShadcnButton
      type={type}
      variant={variantMap[variant]}
      className={cn(
        variant === "provider" && "h-auto w-full justify-start gap-3 px-3 py-2.5 text-left",
        variant === "provider" && "[&_strong]:block [&_strong]:font-semibold",
        className,
      )}
      {...rest}
    >
      {children}
    </ShadcnButton>
  );
}

/** Hint line under a provider login label. */
export function ButtonHint({ className, ...rest }: HTMLAttributes<HTMLSpanElement>): ReactElement {
  return (
    <span
      className={cn("mt-0.5 block text-xs font-normal text-muted-foreground", className)}
      {...rest}
    />
  );
}
