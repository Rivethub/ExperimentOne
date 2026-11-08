/** Join class names, skipping falsy values. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Look up a CSS-module local by kebab/camel key (for dynamic variants). */
export function styleOf(
  styles: Record<string, string>,
  key: string | null | undefined,
): string | undefined {
  if (!key) return undefined;
  if (key in styles) return styles[key];
  const camel = key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  return styles[camel];
}
