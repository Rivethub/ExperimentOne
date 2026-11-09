import { cva, type VariantProps } from "class-variance-authority";
import type { JSX } from "solid-js";
import { splitProps } from "solid-js";
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

export type InputProps = JSX.InputHTMLAttributes<HTMLInputElement> & VariantProps<typeof inputTone>;

export function Input(props: InputProps): JSX.Element {
  const [local, rest] = splitProps(props, ["tone", "class"]);
  return <ShadcnInput class={cn(inputTone({ tone: local.tone }), local.class)} {...rest} />;
}
