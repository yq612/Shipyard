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

// Headers a reverse proxy adds. Seeing any of them from a proxy-looking peer
// means that peer is forwarding for someone else.
const FORWARDING_HEADERS = ["x-forwarded-for", "x-real-ip", "forwarded", "x-forwarded-host", "x-forwarded-proto"];

export interface ClientAddress {
  ip: string; // "" when it cannot be determined; never matches the allowlist
  problem?: string; // why, for the operator's log
}

// The address we trust as "the client". A forwarded request is never
// identified as the proxy itself: the proxy is usually on loopback, which is
// allowlisted, so that would let everyone through. Loopback counts as a proxy
// here even when it is missing from proxyIps.
// Behind a trusted proxy, X-Forwarded-For is read right-to-left and the first
// hop that is not one of our proxies wins; the left-most value is
// client-controlled and never trusted on its own.
export function clientAddress(
  socketIp: string,
  header: (name: string) => string | undefined,
  access: AccessConfig,
): ClientAddress {
  const peer = normalizeIp(socketIp);
  const isProxy = ipMatches(peer, access.proxyIps);
  if (!(access.trustProxy && isProxy)) {
    const forwarded = FORWARDING_HEADERS.some((name) => header(name) !== undefined);
    if (!forwarded || !(isProxy || parseIp(peer)?.range() === "loopback")) return { ip: peer };
    const fix = access.trustProxy ? `把 ${peer} 加入 access.proxyIps` : "设置 access.trustProxy: true";
    return {
      ip: "",
      problem: `收到经反向代理 ${peer} 转发的请求，无法确定真实来源 IP，已按未知 IP 处理。请在 config.yaml 中${fix}`,
    };
  }
  const hops = (header("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = parseIp(hops[i]!);
    if (!hop) break;
    const ip = hop.toString();
    // Every hop so far is ours, so the left-most one was written by a proxy too.
    if (!ipMatches(ip, access.proxyIps) || i === 0) return { ip };
  }
  return {
    ip: "",
    problem: `来自代理 ${peer} 的请求没有可用的 X-Forwarded-For，无法确定真实来源 IP，已按未知 IP 处理。请检查反向代理是否设置了 proxy_set_header X-Forwarded-For $remote_addr`,
  };
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
