import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/http/app.ts";
import { CONFIG_YAML, setupService, until, type TestEnv } from "./helpers.ts";

let env: TestEnv;
afterEach(() => env?.cleanup());

const HOST = "deploy.test";
const ORIGIN = `http://${HOST}`;

function setup(opts: { ip?: string; yaml?: string } = {}) {
  env = setupService({ yaml: opts.yaml });
  let ip = opts.ip ?? "127.0.0.1";
  const app = createApp({ service: env.service, logs: env.logs, config: env.config, socketIp: () => ip });
  const call = (method: string, path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) =>
    app.request(`http://${HOST}${path}`, {
      method,
      headers: {
        host: HOST,
        ...(init.body !== undefined ? { "content-type": "application/json", origin: ORIGIN } : {}),
        ...init.headers,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  return { app, call, setIp: (v: string) => (ip = v) };
}

// Test code reads loosely-typed JSON bodies.
const json = (res: Response): Promise<any> => res.json();

// Reads an SSE response until `stopAt` shows up; returns the event names + data.
async function readSse(res: Response, stopAt: string, timeoutMs = 2000) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: { event: string; data: any }[] = [];
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      Bun.sleep(deadline - Date.now()).then(() => ({ value: undefined, done: true })),
    ]);
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
      if (event) events.push({ event, data: data ? JSON.parse(data) : null });
      if (event === stopAt) {
        await reader.cancel();
        return events;
      }
    }
  }
  await reader.cancel().catch(() => {});
  return events;
}

describe("read endpoints", () => {
  test("health, whoami and config (without secrets)", async () => {
    const { call } = setup({ ip: "::ffff:10.8.3.4" });
    expect((await call("GET", "/api/health")).status).toBe(200);
    expect(await json(await call("GET", "/api/whoami"))).toEqual({ ip: "10.8.3.4", allowed: true, protectReads: false });

    const res = await call("GET", "/api/config");
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("secret");
    expect(text).not.toContain("privateKey");
    expect(text).not.toContain("allowIps");
    const cfg = JSON.parse(text);
    expect(cfg.countries.map((c: any) => c.code)).toEqual(["PK", "MX"]);
    expect(cfg.repos.out).toBe("https://***@codeup.example.com/out.git");
  });

  test("protectReads locks read endpoints to the allowlist", async () => {
    const { call, setIp } = setup({ ip: "198.51.100.1", yaml: CONFIG_YAML.replace("allowIps:", "protectReads: true\n  allowIps:") });
    expect((await call("GET", "/api/config")).status).toBe(403);
    expect((await call("GET", "/api/whoami")).status).toBe(200); // always available
    setIp("127.0.0.1");
    expect((await call("GET", "/api/config")).status).toBe(200);
  });

  test("plan is available to readers", async () => {
    const { call } = setup({ ip: "198.51.100.1" });
    const res = await call("POST", "/api/deployments/plan", { body: { countryCode: "PK", envNames: ["QuickBuy 环境"] } });
    expect(res.status).toBe(200);
    expect((await json(res)).envs).toHaveLength(1);
  });

  test("unknown API routes and deployments are 404 JSON", async () => {
    const { call } = setup();
    expect(await json(await call("GET", "/api/nope"))).toMatchObject({ code: "NOT_FOUND" });
    expect((await call("GET", "/api/deployments/999")).status).toBe(404);
    expect((await call("GET", "/api/deployments/abc")).status).toBe(404);
  });
});

describe("write protection", () => {
  const BODY = { countryCode: "PK", envNames: ["QuickBuy 环境"], operatorName: "  张三  " };

  test("allowlisted IP with same-origin JSON can start a deployment", async () => {
    const { call } = setup();
    const res = await call("POST", "/api/deployments", { body: BODY });
    expect(res.status).toBe(201);
    const { id } = await json(res);
    const detail = await json(await call("GET", `/api/deployments/${id}`));
    expect(detail.deployment).toMatchObject({ id, operatorName: "张三", operatorIp: "127.0.0.1" });
    expect(detail.state.tasks).toHaveLength(1);
  });

  test("IP outside the allowlist → 403 IP_NOT_ALLOWED", async () => {
    const { call } = setup({ ip: "198.51.100.1" });
    const res = await call("POST", "/api/deployments", { body: BODY });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ code: "IP_NOT_ALLOWED" });
  });

  test("cross-site or origin-less writes are rejected even from an allowlisted IP", async () => {
    const { call } = setup();
    const evil = await call("POST", "/api/deployments", { body: BODY, headers: { origin: "https://evil.example" } });
    expect(evil.status).toBe(403);
    expect(await json(evil)).toMatchObject({ code: "ORIGIN_REJECTED" });

    const noOrigin = await call("POST", "/api/deployments", { body: BODY, headers: { origin: "" } });
    expect(noOrigin.status).toBe(403);
  });

  test("non-JSON writes are rejected (no simple-request CSRF)", async () => {
    const { app } = setup();
    const res = await app.request(`http://${HOST}/api/deployments`, {
      method: "POST",
      headers: { host: HOST, origin: ORIGIN, "content-type": "text/plain" },
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(415);
  });

  test("Host outside allowedOrigins is rejected (DNS rebinding)", async () => {
    const { call } = setup({ yaml: CONFIG_YAML.replace("allowIps:", "allowedOrigins: [https://deploy.example.internal]\n  allowIps:") });
    const res = await call("GET", "/api/config");
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ code: "ORIGIN_REJECTED" });
  });

  test("busy environment → 409 ENV_BUSY with details", async () => {
    const { call } = setup();
    const first = await json(await call("POST", "/api/deployments", { body: BODY }));
    const res = await call("POST", "/api/deployments", { body: BODY });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: "ENV_BUSY", details: [{ deploymentId: first.id }] });
  });

  test("no CORS headers are ever sent", async () => {
    const { call } = setup();
    const res = await call("OPTIONS", "/api/deployments", { headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("cancel and retry go through the same guard", async () => {
    const { call, setIp } = setup();
    const { id } = await json(await call("POST", "/api/deployments", { body: BODY }));
    await until(() => env.pipeline.calls.length === 1);

    setIp("198.51.100.1");
    expect((await call("POST", `/api/deployments/${id}/cancel`, { body: {} })).status).toBe(403);
    setIp("127.0.0.1");
    const res = await call("POST", `/api/deployments/${id}/cancel?env=0`, { body: {} });
    expect(await json(res)).toEqual({ cancelled: 1 });
    await until(() => !env.service.isActive(id));

    const retry = await call("POST", `/api/deployments/${id}/retry`, { body: { operatorName: "李四" } });
    expect(retry.status).toBe(201);
    const { id: retryId } = await json(retry);
    const detail = await json(await call("GET", `/api/deployments/${retryId}`));
    expect(detail.deployment).toMatchObject({ retryOf: id, operatorName: "李四" });
  });
});

describe("SSE", () => {
  test("progress stream: snapshot first, then progress, then end", async () => {
    const { call } = setup();
    const { id } = await json(await call("POST", "/api/deployments", { body: { countryCode: "PK", envNames: ["QuickBuy 环境"] } }));
    const res = await call("GET", `/api/deployments/${id}/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    setTimeout(() => env.pipeline.pass("PK-QuickBuy"), 20);
    const events = await readSse(res, "end");
    expect(events[0]!.event).toBe("snapshot");
    expect(events[0]!.data.deployment.id).toBe(id);
    const progress = events.filter((e) => e.event === "progress");
    expect(progress.length).toBeGreaterThan(5);
    // seq strictly increases and continues after the snapshot
    const seqs = progress.map((e) => e.data.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs[0]).toBe(events[0]!.data.lastSeq + 1);
    expect(events.at(-1)!.event).toBe("end");
  });

  test("a finished deployment sends its final snapshot and ends", async () => {
    const { call } = setup();
    const { id } = await json(await call("POST", "/api/deployments", { body: { countryCode: "PK", envNames: ["QuickBuy 环境"] } }));
    env.pipeline.pass("PK-QuickBuy");
    await until(() => !env.service.isActive(id));
    await env.service.idle();
    const events = await readSse(await call("GET", `/api/deployments/${id}/events`), "end");
    expect(events.map((e) => e.event)).toEqual(["snapshot", "end"]);
    expect(events[0]!.data.state.tasks[0].status).toBe("done");
  });

  test("connecting while the notification is still being sent waits for the real end", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    env = setupService({ yaml: CONFIG_YAML + `\nnotify:\n  feishu:\n    webhook: https://hook/x\n` });
    // slow Feishu webhook
    (env.service as any).notify = async () => {
      await gate;
      return { ok: true };
    };
    const app = createApp({ service: env.service, logs: env.logs, config: env.config, socketIp: () => "127.0.0.1" });
    const { id } = env.service.create("PK", ["QuickBuy 环境"], { ip: "127.0.0.1", name: null, userAgent: null });
    env.pipeline.pass("PK-QuickBuy");
    await until(() => !env.service.isActive(id));
    expect(env.service.hasPendingEnd(id)).toBe(true);

    const res = await app.request(`http://${HOST}/api/deployments/${id}/events`, { headers: { host: HOST } });
    setTimeout(release, 50);
    const events = await readSse(res, "end");
    expect(events.map((e) => e.event)).toEqual(["snapshot", "deployment", "end"]);
    expect(events[1]!.data.notifyStatus).toBe("sent");
  });

  test("log stream: tail, live lines, end; plain and download modes", async () => {
    const { call } = setup();
    const { id } = await json(await call("POST", "/api/deployments", { body: { countryCode: "PK", envNames: ["QuickBuy 环境"] } }));
    await until(() => env.pipeline.calls.length === 1);
    const res = await call("GET", `/api/deployments/${id}/envs/0/logs?follow=1`);
    setTimeout(() => env.pipeline.pass("PK-QuickBuy"), 20);
    const events = await readSse(res, "end");
    expect(events[0]!.event).toBe("tail");
    expect(events[0]!.data.lines.some((l: any) => l.text.startsWith("开始发布"))).toBe(true);
    const live = events.filter((e) => e.event === "lines").flatMap((e) => e.data.map((l: any) => l.text));
    expect(live).toContain("build output for PK-QuickBuy");
    expect(events.at(-1)!.event).toBe("end");

    const chunk = await json(await call("GET", `/api/deployments/${id}/envs/0/logs?offset=1&limit=2`));
    expect(chunk).toMatchObject({ offset: 1, nextOffset: 3, done: true });
    expect(chunk.lines).toHaveLength(2);

    const dl = await call("GET", `/api/deployments/${id}/envs/0/logs?download=1`);
    expect(dl.headers.get("content-disposition")).toContain("attachment");
    expect(await dl.text()).toContain("[stdout] [install] install output for PK-QuickBuy");

    expect((await call("GET", `/api/deployments/${id}/envs/9/logs`)).status).toBe(404);
  });
});
