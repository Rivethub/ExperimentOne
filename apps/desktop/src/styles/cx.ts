import { cn } from "#lib/utils";

/** Join class names, skipping falsy values. Prefer `cn` for new Tailwind UI. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return cn(...parts);
}

export { cn };

/** Look up a CSS-module local by kebab/camel key (for dynamic variants). */
export function styleOf(
  styles: Record<string, string>,
  key: string | null | undefined,
): string | undefined {
  if (key === null || key === undefined || key === "") {
    return undefined;
  }
  if (key in styles) {
    return styles[key];
  }
  const camel = key.replaceAll(/-(?<char>[a-z])/gu, (match) => match.slice(1).toUpperCase());
  return styles[camel];
}
