import type { JSX } from "solid-js";
import { splitProps } from "solid-js";
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

export type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
};

export function Button(props: ButtonProps): JSX.Element {
  const [local, rest] = splitProps(props, ["variant", "class", "type", "children"]);
  const variant = () => local.variant ?? "default";
  return (
    <ShadcnButton
      type={local.type ?? "button"}
      variant={variantMap[variant()]}
      class={cn(
        variant() === "provider" && "h-auto w-full justify-start gap-3 px-3 py-2.5 text-left",
        variant() === "provider" && "[&_strong]:block [&_strong]:font-semibold",
        local.class,
      )}
      {...rest}
    >
      {local.children}
    </ShadcnButton>
  );
}

/** Hint line under a provider login label. */
export function ButtonHint(props: JSX.HTMLAttributes<HTMLSpanElement>): JSX.Element {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <span
      class={cn("mt-0.5 block text-xs font-normal text-muted-foreground", local.class)}
      {...rest}
    />
  );
}
