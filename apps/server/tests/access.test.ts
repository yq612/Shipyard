import { describe, expect, test } from "bun:test";
import { clientIp, ipMatches, isHostAllowed, isOriginAllowed, normalizeIp } from "../src/http/access.ts";
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
  test("ignores X-Forwarded-For unless trustProxy is on and the peer is a proxy", () => {
    expect(clientIp("198.51.100.7", "203.0.113.10", ACCESS)).toBe("198.51.100.7");
    const behindProxy = { ...ACCESS, trustProxy: true };
    expect(clientIp("198.51.100.7", "203.0.113.10", behindProxy)).toBe("198.51.100.7"); // peer is not a proxy
    expect(clientIp("127.0.0.1", "203.0.113.10", behindProxy)).toBe("203.0.113.10");
  });

  test("reads X-Forwarded-For right to left, so a spoofed left-most value is ignored", () => {
    const behindProxy = { ...ACCESS, trustProxy: true, proxyIps: ["127.0.0.1", "10.0.0.0/8"] };
    // client claims to be 203.0.113.10, real client 198.51.100.7, then an internal hop
    expect(clientIp("127.0.0.1", "203.0.113.10, 198.51.100.7, 10.0.0.5", behindProxy)).toBe("198.51.100.7");
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
