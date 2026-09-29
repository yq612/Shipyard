import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigError, envSpecOf, lockKey, parseConfig, renderRemotePath, validateConfig } from "../src/core/config.ts";
import { CONFIG_YAML, setupService, type TestEnv } from "./helpers.ts";

const MIN = {
  ssh: { user: "root", port: 22, privateKeyPath: "k.pem", remotePathTemplate: "/x/{server}/dist" },
  build: { install: "i", build: "b", dist: "dist" },
  repos: { out: "u" },
  countries: [] as any[],
};

describe("validateConfig", () => {
  test("substitutes {server}", () => {
    expect(renderRemotePath("/home/topup-web/{server}/dist", "foo")).toBe("/home/topup-web/foo/dist");
  });

  test("fills server / access defaults and resolves the key path", () => {
    const cfg = validateConfig(MIN, "/data");
    expect(cfg.server).toEqual({ port: 8080, maxConcurrent: 3, logRetentionDays: 30 });
    expect(cfg.access).toMatchObject({ allowIps: [], protectReads: false, trustProxy: false, allowedOrigins: [] });
    expect(cfg.ssh.privateKeyPath).toBe("/data/k.pem");
    expect(cfg.ssh.keepPrevious).toBe(true);
    expect(validateConfig({ ...MIN, ssh: { ...MIN.ssh, privateKeyPath: "/abs/k.pem" } }).ssh.privateKeyPath).toBe("/abs/k.pem");
  });

  test("rejects bad input with a readable message", () => {
    expect(() => validateConfig({ ...MIN, ssh: { ...MIN.ssh, remotePathTemplate: "/no/placeholder" } })).toThrow(/\{server\}/);
    expect(() => validateConfig({ ...MIN, ssh: { ...MIN.ssh, privateKeyPath: "" } })).toThrow(/privateKeyPath/);
    expect(() => validateConfig({ ...MIN, server: { maxConcurrent: 0 } })).toThrow(/maxConcurrent/);
    const env = (e: any) => ({ ...MIN, countries: [{ name: "PK", code: "PK", environments: [e] }] });
    expect(() => validateConfig(env({ name: "e", branch: "b", server: "s", host: "h", repo: "MISSING" }))).toThrow(/repo/);
    expect(() => validateConfig(env({ name: "e", branch: "b", server: "s", repo: "out" }))).toThrow(/host/);
    expect(() => validateConfig(env({ name: "e", branch: "b", server: "s; rm -rf /", host: "h", repo: "out" }))).toThrow(/server/);
    expect(() => parseConfig("a: [")).toThrow(ConfigError);
  });

  test("rejects duplicate countries and environment names", () => {
    const e = { name: "e", branch: "b", server: "s", host: "h", repo: "out" };
    expect(() => validateConfig({ ...MIN, countries: [{ name: "A", code: "PK", environments: [e] }, { name: "B", code: "PK", environments: [] }] })).toThrow(/重复/);
    expect(() => validateConfig({ ...MIN, countries: [{ name: "A", code: "PK", environments: [e, e] }] })).toThrow(/重复/);
  });

  test("FEISHU_WEBHOOK overrides the file", () => {
    process.env.FEISHU_WEBHOOK = "https://hook/env";
    try {
      expect(validateConfig(MIN).notify?.feishu?.webhook).toBe("https://hook/env");
    } finally {
      delete process.env.FEISHU_WEBHOOK;
    }
    expect(validateConfig(MIN).notify).toBeUndefined();
  });

  test("envSpecOf snapshots everything a pipeline needs", () => {
    const cfg = parseConfig(CONFIG_YAML, "/cfg");
    const env = cfg.countries[0]!.environments[0]!;
    expect(envSpecOf(cfg, env)).toEqual({
      name: "QuickBuy 环境",
      branch: "PK-QuickBuy",
      server: "quickbuypk",
      host: "1.1.1.1",
      repoKey: "out",
      repoUrl: "https://oauth2:secret@codeup.example.com/out.git",
      remotePath: "/home/topup-web/quickbuypk/dist",
      installCmd: "bun install",
      buildCmd: "bun run build",
      dist: "dist",
    });
    expect(lockKey("1.1.1.1", "/a")).toBe("1.1.1.1:/a");
  });
});

test("config.example.yaml is valid and keeps the 23 environments across 10 countries", () => {
  const path = resolve(import.meta.dir, "../../../config.example.yaml");
  const cfg = parseConfig(readFileSync(path, "utf8"), "/data");
  const envCount = cfg.countries.reduce((n, c) => n + c.environments.length, 0);
  expect(cfg.countries.length).toBe(10);
  expect(envCount).toBe(23);
  const indonesia = cfg.countries.find((c) => c.code === "ID");
  expect(indonesia?.environments.some((e) => e.name === "SumberTech 环境")).toBe(false);
  expect(indonesia?.environments).toContainEqual({
    name: "Solusi Transaksi 环境",
    branch: "id/Solusi",
    server: "soltransnusantara",
    host: "8.219.130.109",
    repo: "pro",
  });
  expect(cfg.notify).toBeUndefined(); // the example must not ship a webhook
});

describe("ConfigStore", () => {
  let env: TestEnv;
  afterEach(() => env?.cleanup());

  test("keeps the last good config when an edit breaks validation", () => {
    env = setupService();
    expect(env.config.get().countries).toHaveLength(2);
    env.writeConfig(CONFIG_YAML.replace("remotePathTemplate: \"/home/topup-web/{server}/dist\"", "remotePathTemplate: /broken"));
    expect(() => env.config.reload()).toThrow(/\{server\}/);
    expect(env.config.error).toContain("{server}");
    expect(env.config.get().countries).toHaveLength(2);

    env.writeConfig(CONFIG_YAML.replace("maxConcurrent: 2", "maxConcurrent: 5"));
    expect(env.config.refresh().server.maxConcurrent).toBe(5);
    expect(env.config.error).toBeNull();
  });
});
