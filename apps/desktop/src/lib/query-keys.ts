import type { SearchMode } from "./types";

export const queryKeys = {
  home: ["home"] as const,
  quota: (horizon: "1h" | "3h" | "6h") => ["quota", horizon] as const,
  loginStatus: ["loginStatus"] as const,
  conversations: (query: string, mode: SearchMode) =>
    ["conversations", query.trim(), mode] as const,
  conversationEvents: (id: string) => ["conversationEvents", id] as const,
  runtimeLogs: ["runtimeLogs"] as const,
};
