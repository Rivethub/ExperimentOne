import type { JsonObject } from "../lib/json-types";
import { isDefined } from "../lib/nullish";

export type MockHttpResult = {
  status: number;
  body: string;
  content_type: string;
};

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
  );
}

export function ok(data: unknown, status = 200): MockHttpResult {
  return {
    status,
    body: isString(data) ? data : JSON.stringify(data),
    content_type: isString(data) ? "text/plain" : "application/json",
  };
}

export function err(message: string, status = 400): MockHttpResult {
  return ok({ error: message }, status);
}

export function parseBody(raw: string | null | undefined): unknown {
  if (!isDefined(raw) || raw === "") {
    return undefined;
  }
  try {
    // JUSTIFICATION: JSON.parse yields unknown JSON; callers narrow via isJsonObject/read*Field.
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export function pathOnly(path: string): string {
  return path.split("?")[0] ?? path;
}

export function query(path: string): URLSearchParams {
  const i = path.indexOf("?");
  return new URLSearchParams(i !== -1 ? path.slice(i + 1) : "");
}

export function readStringField(payload: unknown, key: string): string | undefined {
  if (!isJsonObject(payload)) {
    return undefined;
  }
  const value = payload[key];
  return isString(value) ? value : undefined;
}

export function readOptionalBooleanField(
  payload: unknown,
  parentKey: string,
  fieldKey: string,
): boolean | undefined {
  if (!isJsonObject(payload)) {
    return undefined;
  }
  const parent = payload[parentKey];
  if (!isJsonObject(parent)) {
    return undefined;
  }
  const value = parent[fieldKey];
  return isBoolean(value) ? value : undefined;
}

export function readNullableStringField(payload: unknown, key: string): string | null | undefined {
  if (!isJsonObject(payload)) {
    return undefined;
  }
  const value = payload[key];
  if (value === null) {
    return null;
  }
  return isString(value) ? value : undefined;
}

export type MockRequestContext = {
  m: string;
  base: string;
  q: URLSearchParams;
  payload: unknown;
};
