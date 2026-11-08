/** Named typeof guards — anti-slop requires typeof only inside these helpers. */
export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasStringMessage(value: unknown): value is { message: string } {
  if (!isRecord(value)) {
    return false;
  }
  return isString(value["message"]);
}
