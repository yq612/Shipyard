import { describe, expect, test } from "bun:test";
import { clientAddress, ipMatches, isHostAllowed, isOriginAllowed, normalizeIp } from "../src/http/access.ts";
import type { AccessConfig } from "../src/core/types.ts";

const ACCESS: AccessConfig = {
  allowIps: ["203.0.113.10", "10.8.0.0/16", "2001:db8::/32"],
  protectReads: false,
  trustProxy: false,
  proxyIps: ["127.0.0.1"],
  allowedOrigins: [],
};

describe("IP matching", () => {
  test("normalises IPv4-mapped IPv6 addresses", () => {
    expect(normalizeIp("::ffff:10.1.2.3")).toBe("10.1.2.3");
    expect(normalizeIp("[::1]")).toBe("::1");
  });

  test("matches exact IPs and CIDR ranges of both families", () => {
    expect(ipMatches("203.0.113.10", ACCESS.allowIps)).toBe(true);
    expect(ipMatches("::ffff:203.0.113.10", ACCESS.allowIps)).toBe(true);
    expect(ipMatches("10.8.200.1", ACCESS.allowIps)).toBe(true);
    expect(ipMatches("10.9.0.1", ACCESS.allowIps)).toBe(false);
    expect(ipMatches("2001:db8::1", ACCESS.allowIps)).toBe(true);
    expect(ipMatches("2001:db9::1", ACCESS.allowIps)).toBe(false);
    expect(ipMatches("not-an-ip", ACCESS.allowIps)).toBe(false);
    expect(ipMatches("1.2.3.4", ["garbage", "1.2.3.4"])).toBe(true);
  });
});

describe("client IP", () => {
  const clientIp = (peer: string, headers: Record<string, string>, access: AccessConfig) =>
    clientAddress(peer, (name) => headers[name], access);
  const xff = (value: string) => ({ "x-forwarded-for": value });

  test("a direct connection is identified by its socket address", () => {
    expect(clientIp("198.51.100.7", {}, ACCESS)).toEqual({ ip: "198.51.100.7" });
    expect(clientIp("::ffff:127.0.0.1", {}, ACCESS)).toEqual({ ip: "127.0.0.1" });
  });

  test("ignores X-Forwarded-For from a peer that is not a proxy", () => {
    expect(clientIp("198.51.100.7", xff("203.0.113.10"), ACCESS)).toEqual({ ip: "198.51.100.7" });
    expect(clientIp("198.51.100.7", xff("203.0.113.10"), { ...ACCESS, trustProxy: true })).toEqual({ ip: "198.51.100.7" });
  });

  test("behind a trusted proxy, the forwarded address wins", () => {
    expect(clientIp("127.0.0.1", xff("203.0.113.10"), { ...ACCESS, trustProxy: true })).toEqual({ ip: "203.0.113.10" });
  });

  test("reads X-Forwarded-For right to left, so a spoofed left-most value is ignored", () => {
    const behindProxy = { ...ACCESS, trustProxy: true, proxyIps: ["127.0.0.1", "10.0.0.0/8"] };
    // client claims to be 203.0.113.10, real client 198.51.100.7, then an internal hop
    expect(clientIp("127.0.0.1", xff("203.0.113.10, 198.51.100.7, 10.0.0.5"), behindProxy)).toEqual({ ip: "198.51.100.7" });
  });

  test("a proxy in front while trustProxy is off: the client is unknown, not the proxy", () => {
    const variants: Record<string, string>[] = [xff("198.51.100.7"), { "x-real-ip": "198.51.100.7" }, { forwarded: "for=198.51.100.7" }];
    for (const headers of variants) {
      const got = clientIp("127.0.0.1", headers, ACCESS);
      expect(got.ip).toBe("");
      expect(got.problem).toContain("access.trustProxy: true");
    }
  });

  test("loopback is treated as a proxy even when proxyIps leaves it out", () => {
    const got = clientIp("::1", xff("198.51.100.7"), { ...ACCESS, trustProxy: true, proxyIps: ["10.0.0.1"] });
    expect(got.ip).toBe("");
    expect(got.problem).toContain("access.proxyIps");
  });

  test("a trusted proxy that forwards no usable client address: unknown", () => {
    const behindProxy = { ...ACCESS, trustProxy: true };
    // A proxy that forgot X-Forwarded-For looks exactly like this, so it is not taken as local access.
    expect(clientIp("127.0.0.1", {}, behindProxy).ip).toBe("");
    expect(clientIp("127.0.0.1", { "x-real-ip": "198.51.100.7" }, behindProxy).ip).toBe("");
    expect(clientIp("127.0.0.1", xff("garbage"), behindProxy).ip).toBe("");
    expect(clientIp("127.0.0.1", xff(""), behindProxy).ip).toBe("");
  });

  test("a chain made only of our own proxies resolves to the left-most hop", () => {
    const behindProxy = { ...ACCESS, trustProxy: true, proxyIps: ["127.0.0.1", "10.0.0.0/8"] };
    expect(clientIp("127.0.0.1", xff("10.0.0.9, 10.0.0.5"), behindProxy)).toEqual({ ip: "10.0.0.9" });
  });
});

describe("Origin / Host", () => {
  test("without allowedOrigins: any Host, Origin must equal Host", () => {
    expect(isHostAllowed("whatever:8080", ACCESS)).toBe(true);
    expect(isOriginAllowed("http://localhost:8080", "localhost:8080", ACCESS)).toBe(true);
    expect(isOriginAllowed("http://evil.example", "localhost:8080", ACCESS)).toBe(false);
    expect(isOriginAllowed(undefined, "localhost:8080", ACCESS)).toBe(false);
    expect(isOriginAllowed("null", "localhost:8080", ACCESS)).toBe(false);
  });

  test("with allowedOrigins: both Host and Origin must be listed", () => {
    const strict = { ...ACCESS, allowedOrigins: ["https://deploy.example.internal"] };
    expect(isHostAllowed("deploy.example.internal", strict)).toBe(true);
    expect(isHostAllowed("rebind.attacker.example", strict)).toBe(false);
    expect(isHostAllowed(undefined, strict)).toBe(false);
    expect(isOriginAllowed("https://deploy.example.internal/", "deploy.example.internal", strict)).toBe(true);
    expect(isOriginAllowed("http://deploy.example.internal", "deploy.example.internal", strict)).toBe(false);
  });
});
