import { beforeEach, describe, expect, it } from "vite-plus/test";
import { handleApiRequest } from "./handlers";
import { resetStore } from "./store";

describe("mock IPC handlers", () => {
  beforeEach(() => {
    resetStore("default");
  });

  it("serves status with clickhouse backend", async () => {
    const res = await handleApiRequest("GET", "/v1/status", null);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.traffic_backend).toBe("clickhouse");
    expect(body.onboarding.has_accounts).toBe(true);
  });

  it("lists accounts and quota windows", async () => {
    const accounts = JSON.parse((await handleApiRequest("GET", "/v1/accounts", null)).body);
    expect(accounts.length).toBeGreaterThan(0);
    const quota = JSON.parse((await handleApiRequest("GET", "/v1/quota", null)).body);
    expect(quota.accounts[0].windows.length).toBeGreaterThan(0);
    expect(quota.providers.length).toBeGreaterThan(0);
  });

  it("searches traffic and seeds demo events", async () => {
    const search = JSON.parse(
      (await handleApiRequest("GET", "/v1/traffic/search?limit=20&q=claude", null)).body,
    );
    expect(Array.isArray(search)).toBe(true);
    const seed = JSON.parse(
      (await handleApiRequest("POST", "/v1/demo/seed", JSON.stringify({ force: false }))).body,
    );
    expect(seed.inserted).toBe(1);
  });

  it("toggles proxy and writes harness", async () => {
    await handleApiRequest("POST", "/v1/proxy/stop", null);
    let status = JSON.parse((await handleApiRequest("GET", "/v1/status", null)).body);
    expect(status.proxy_running).toBe(false);
    await handleApiRequest("POST", "/v1/proxy/start", null);
    status = JSON.parse((await handleApiRequest("GET", "/v1/status", null)).body);
    expect(status.proxy_running).toBe(true);

    const harness = JSON.parse(
      (
        await handleApiRequest(
          "POST",
          "/v1/harness/write",
          JSON.stringify({ target: "claude", mode: "user" }),
        )
      ).body,
    );
    expect(harness.target).toBe("claude");
    expect(harness.path).toContain(".claude");
  });

  it("starts login and eventually adds an account", async () => {
    resetStore("empty");
    await handleApiRequest(
      "POST",
      "/v1/accounts/login",
      JSON.stringify({ provider: "claude", method: "browser" }),
    );
    let login = JSON.parse((await handleApiRequest("GET", "/v1/accounts/login/status", null)).body);
    expect(login.active).toBe(true);
    expect(login.done).toBe(false);

    await new Promise((r) => setTimeout(r, 2000));
    login = JSON.parse((await handleApiRequest("GET", "/v1/accounts/login/status", null)).body);
    expect(login.done).toBe(true);
    expect(login.success).toBe(true);
    const accounts = JSON.parse((await handleApiRequest("GET", "/v1/accounts", null)).body);
    expect(accounts.some((a: { provider: string }) => a.provider === "claude")).toBe(true);
  });

  it("seeds empty scenario with no credentials", async () => {
    resetStore("empty");
    const accounts = JSON.parse((await handleApiRequest("GET", "/v1/accounts", null)).body);
    expect(accounts).toEqual([]);
    const status = JSON.parse((await handleApiRequest("GET", "/v1/status", null)).body);
    expect(status.onboarding.has_accounts).toBe(false);
  });
});
