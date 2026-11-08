import { cva, type VariantProps } from "class-variance-authority";
import type { InputHTMLAttributes, ReactElement } from "react";
import { Input as ShadcnInput } from "#components/ui/input";
import { cn } from "#lib/utils";

const inputTone = cva("min-w-[220px] flex-1", {
  variants: {
    tone: {
      mono: "font-mono text-xs",
      plain: "font-sans text-sm",
    },
  },
  defaultVariants: {
    tone: "mono",
  },
});

export type InputProps = InputHTMLAttributes<HTMLInputElement> & VariantProps<typeof inputTone>;

export function Input({ tone = "mono", className, ...rest }: InputProps): ReactElement {
  return <ShadcnInput className={cn(inputTone({ tone }), className)} {...rest} />;
}
