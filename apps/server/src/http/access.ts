import ipaddr from "ipaddr.js";
import type { AccessConfig } from "../core/types.ts";

type Addr = ipaddr.IPv4 | ipaddr.IPv6;

// "::ffff:10.1.2.3" → IPv4 10.1.2.3, so v4 allowlist entries match dual-stack sockets.
export function parseIp(raw: string): Addr | null {
  const s = raw.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (!ipaddr.isValid(s)) return null;
  const addr = ipaddr.parse(s);
  if (addr.kind() === "ipv6" && (addr as ipaddr.IPv6).isIPv4MappedAddress()) {
    return (addr as ipaddr.IPv6).toIPv4Address();
  }
  return addr;
}

export function normalizeIp(raw: string): string {
  return parseIp(raw)?.toString() ?? raw;
}

type Rule = [Addr, number];

function parseRule(rule: string): Rule | null {
  try {
    if (rule.includes("/")) {
      const [addr, bits] = ipaddr.parseCIDR(rule);
      if (addr.kind() === "ipv6" && (addr as ipaddr.IPv6).isIPv4MappedAddress()) {
        return [(addr as ipaddr.IPv6).toIPv4Address(), Math.max(0, bits - 96)];
      }
      return [addr, bits];
    }
    const addr = parseIp(rule);
    return addr ? [addr, addr.kind() === "ipv4" ? 32 : 128] : null;
  } catch {
    return null;
  }
}

const ruleCache = new Map<string, Rule | null>();

export function ipMatches(ip: string, rules: string[]): boolean {
  const addr = parseIp(ip);
  if (!addr) return false;
  for (const raw of rules) {
    let rule = ruleCache.get(raw);
    if (rule === undefined) {
      rule = parseRule(raw);
      ruleCache.set(raw, rule);
      if (!rule) console.warn(`[access] 无法解析的 IP 规则：${raw}`);
    }
    if (rule && rule[0].kind() === addr.kind() && addr.match(rule)) return true;
  }
  return false;
}

// The address we trust as "the client". Behind a proxy, X-Forwarded-For is read
// right-to-left and the first hop that is not one of our proxies wins; the
// left-most value is client-controlled and never trusted on its own.
export function clientIp(socketIp: string, xff: string | undefined, access: AccessConfig): string {
  const peer = normalizeIp(socketIp);
  if (!access.trustProxy || !xff || !ipMatches(peer, access.proxyIps)) return peer;
  const hops = xff.split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = normalizeIp(hops[i]!);
    if (!parseIp(hop)) break;
    if (!ipMatches(hop, access.proxyIps)) return hop;
  }
  return peer;
}

export function isIpAllowed(ip: string, access: AccessConfig): boolean {
  return ipMatches(ip, access.allowIps);
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

// DNS-rebinding guard: the Host header must be one we serve. With no
// allowedOrigins configured, anything goes (development / plain IP access).
export function isHostAllowed(host: string | undefined, access: AccessConfig): boolean {
  if (access.allowedOrigins.length === 0) return true;
  if (!host) return false;
  const h = host.toLowerCase();
  return access.allowedOrigins.some((o) => hostOf(o) === h);
}

// CSRF guard for writes: require an Origin, and it must be ours — either listed
// in allowedOrigins or (when none are configured) identical to the Host header.
export function isOriginAllowed(origin: string | undefined, host: string | undefined, access: AccessConfig): boolean {
  if (!origin || origin === "null") return false;
  const o = origin.replace(/\/+$/, "").toLowerCase();
  if (access.allowedOrigins.length > 0) return access.allowedOrigins.some((a) => a.toLowerCase() === o);
  return !!host && hostOf(o) === host.toLowerCase();
}
