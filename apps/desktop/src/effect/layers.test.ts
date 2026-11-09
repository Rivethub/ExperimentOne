import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import { RivetIpc } from "./ipc";
import { AppLive } from "./layers";

describe("AppLive", () => {
  it.effect("provides RivetIpc, HttpClient, and KeyValueStore", () =>
    Effect.gen(function* () {
      const ipc = yield* RivetIpc;
      expect(typeof ipc.apiRequest).toBe("function");

      const http = yield* HttpClient.HttpClient;
      expect(typeof http.execute).toBe("function");

      // Node test env has no window.localStorage — only assert the service is wired.
      const kv = yield* KeyValueStore.KeyValueStore;
      expect(typeof kv.get).toBe("function");
      expect(typeof kv.set).toBe("function");
    }).pipe(Effect.provide(AppLive)),
  );
});
