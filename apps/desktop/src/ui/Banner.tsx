import { cva, type VariantProps } from "class-variance-authority";
import type { JSX } from "solid-js";
import { splitProps } from "solid-js";
import { Alert } from "#components/ui/alert";
import { cn } from "#lib/utils";

const bannerTone = cva("rounded-lg text-[13px] leading-snug", {
  variants: {
    tone: {
      error: "border-destructive/35 bg-red-400/8 px-3 py-2.5 text-red-200 [&>svg]:text-current",
      warn: "border-amber-800 bg-[#1c1410] px-3 py-2.5 text-amber-200 [&_p]:mb-2.5 [&_p]:text-[13px] [&_p]:leading-snug [&_p]:text-amber-300 [&_strong]:mb-1.5 [&_strong]:block [&_strong]:text-amber-200",
      note: "mt-2.5 border-0 bg-transparent p-0 text-[12.5px] text-muted-foreground shadow-none",
    },
  },
  defaultVariants: {
    tone: "note",
  },
});

export type BannerTone = NonNullable<VariantProps<typeof bannerTone>["tone"]>;

export type BannerProps = JSX.HTMLAttributes<HTMLDivElement> & VariantProps<typeof bannerTone>;

export function Banner(props: BannerProps): JSX.Element {
  const [local, rest] = splitProps(props, ["tone", "class"]);
  const tone = () => local.tone ?? "note";
  return (
    <Alert
      variant={tone() === "error" ? "destructive" : "default"}
      class={cn(bannerTone({ tone: tone() }), local.class)}
      {...rest}
    />
  );
}
