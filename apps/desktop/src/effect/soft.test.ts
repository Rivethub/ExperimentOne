import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { ApiError, IpcError } from "./errors";
import { RivetIpc, type IpcResponse } from "./ipc";
import { StatusSchema, TopicCardSchema, WorkersTickSchema } from "./schemas";
import { peekSoftFailure, softEffect } from "./soft";

const okJson = (body: unknown): IpcResponse => ({
  status: 200,
  body: JSON.stringify(body),
  content_type: "application/json",
});

const TestIpc = Layer.succeed(
  RivetIpc,
  RivetIpc.of({
    ensure: Effect.void,
    apiRequest: (method, path) => {
      if (path === "/v1/status") {
        return Effect.succeed(
          okJson({
            ok: true,
            proxy_running: true,
            proxy_base_url: "http://127.0.0.1:18317",
            mcp_url: "http://127.0.0.1:18319/mcp",
            access_key_hint: "****",
            account_count: 1,
            capabilities: { mcp: true, vector_search: true, wiki: true, teams: false },
            usage: { events: 0, tokens_in: 0, tokens_out: 0 },
            workers: {
              vector_search: true,
              wiki: true,
              embeddings: 2,
              wiki_pages: 1,
              role: "all",
              queue: { pending: 3, running: 1, done: 9, failed: 0, dead: 0 },
            },
          }),
        );
      }
      return Effect.fail(new ApiError({ method, path, status: 404, body: "missing" }));
    },
    invoke: (command) => Effect.fail(new IpcError({ command, cause: "test" })),
  }),
);

describe("softEffect", () => {
  it.effect("maps failures to null and records cause", () =>
    Effect.gen(function* () {
      const value = yield* softEffect(Effect.fail("boom"));
      expect(value).toBeNull();
      expect(peekSoftFailure()).toBe("boom");
    }),
  );

  it.effect("passes successes through", () =>
    Effect.gen(function* () {
      const value = yield* softEffect(Effect.succeed(42));
      expect(value).toBe(42);
    }),
  );
});

describe("schemas via Effect", () => {
  it.effect("decodes StatusSchema workers.queue", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeEffect(StatusSchema)({
        ok: true,
        proxy_running: false,
        proxy_base_url: "http://127.0.0.1:18317",
        mcp_url: "http://127.0.0.1:18319/mcp",
        access_key_hint: "****",
        account_count: 0,
        capabilities: { mcp: true, vector_search: false, wiki: false, teams: false },
        usage: { events: 0, tokens_in: 0, tokens_out: 0 },
        workers: {
          vector_search: false,
          wiki: false,
          embeddings: 0,
          wiki_pages: 0,
          role: "all",
          queue: { pending: 4, running: 0, done: 1, failed: 0, dead: 2 },
        },
      });
      expect(decoded.workers?.queue?.pending).toBe(4);
      expect(decoded.workers?.role).toBe("all");
    }),
  );

  it.effect("decodes TopicCardSchema", () =>
    Effect.gen(function* () {
      const topic = yield* Schema.decodeEffect(TopicCardSchema)({
        slug: "oauth",
        title: "OAuth",
        updated_at: "2026-01-01T00:00:00Z",
        placement_by: "you",
      });
      expect(topic.slug).toBe("oauth");
      expect(topic.placement_by).toBe("you");
    }),
  );

  it.effect("decodes WorkersTickSchema", () =>
    Effect.gen(function* () {
      const tick = yield* Schema.decodeEffect(WorkersTickSchema)({
        embeddings: 2,
        wiki_pages: 1,
      });
      expect(tick.embeddings).toBe(2);
    }),
  );
});

describe("RivetIpc test layer", () => {
  it.effect("serves status through the service", () =>
    Effect.gen(function* () {
      const ipc = yield* RivetIpc;
      const res = yield* ipc.apiRequest("GET", "/v1/status");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as { workers: { queue: { pending: number } } };
      expect(body.workers.queue.pending).toBe(3);
    }).pipe(Effect.provide(TestIpc)),
  );
});
