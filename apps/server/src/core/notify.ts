import { createHmac } from "node:crypto";
import type { DeploymentStatus } from "@shipyard/shared";
import { DEPLOYMENT_STATUS_NAMES, STAGE_NAMES, formatDuration, sanitizeText, shortSha } from "@shipyard/shared";
import type { Stage, TaskStatus } from "@shipyard/shared";

// Feishu (Lark) custom-bot notification. After a deployment finishes we POST an
// interactive card to the bot's webhook. The card title carries the literal
// "Shipyard" so a bot configured with the 自定义关键词 "Shipyard" accepts
// it without signature verification.

export interface FeishuCard {
  msg_type: "interactive";
  card: {
    header: { title: { tag: "plain_text"; content: string }; template: string };
    elements: unknown[];
  };
}

export interface CardEnv {
  name: string;
  status: TaskStatus;
  failedStage?: Stage | null;
  error?: string | null;
  commitSha?: string | null;
  totalMs?: number | null;
}

export interface CardInput {
  deploymentId: number;
  status: DeploymentStatus;
  countryName: string;
  operatorName?: string | null;
  operatorIp: string;
  totalMs?: number | null;
  envs: CardEnv[];
  detailUrl?: string;
}

const HEADER_COLORS: Record<DeploymentStatus, string> = {
  queued: "blue",
  running: "blue",
  succeeded: "green",
  partial: "orange",
  failed: "red",
  cancelled: "grey",
  interrupted: "red",
};

const ENV_ICONS: Record<TaskStatus, string> = {
  queued: "◷",
  running: "…",
  done: "✅",
  error: "❌",
  cancelled: "⏹",
  interrupted: "⚠️",
};

// Pure: deployment → Feishu card.
export function buildFeishuCard(input: CardInput): FeishuCard {
  const ok = input.envs.filter((e) => e.status === "done").length;
  const total = input.envs.length;
  const title = `Shipyard #${input.deploymentId} · ${input.countryName} · ${DEPLOYMENT_STATUS_NAMES[input.status]}`;
  const operator = input.operatorName ? `${input.operatorName}（${input.operatorIp}）` : input.operatorIp;

  const lines: string[] = [
    `**成功 ${ok}/${total}**${input.totalMs ? ` · 总耗时 ${formatDuration(input.totalMs)}` : ""}`,
    `操作人：${operator}`,
    "",
  ];
  for (const e of input.envs) {
    const parts = [`${ENV_ICONS[e.status]} ${e.name}`];
    if (e.commitSha) parts.push(shortSha(e.commitSha));
    if (e.totalMs) parts.push(formatDuration(e.totalMs));
    if (e.status === "error" || e.status === "interrupted") {
      const stage = e.failedStage ? STAGE_NAMES[e.failedStage] : "";
      const err = sanitizeText(e.error ?? "").slice(0, 160);
      parts.push(`失败于「${stage}」${err ? `：${err}` : ""}`);
    } else if (e.status === "cancelled") {
      parts.push("已取消");
    }
    lines.push(parts.join(" · "));
  }

  const elements: unknown[] = [{ tag: "div", text: { tag: "lark_md", content: lines.join("\n") } }];
  if (input.detailUrl) {
    elements.push({
      tag: "action",
      actions: [{ tag: "button", text: { tag: "plain_text", content: "查看详情" }, type: "primary", url: input.detailUrl }],
    });
  }

  return {
    msg_type: "interactive",
    card: {
      header: { title: { tag: "plain_text", content: title }, template: HEADER_COLORS[input.status] },
      elements,
    },
  };
}

// Feishu signing: HMAC-SHA256 over an EMPTY body, using `${timestamp}\n${secret}`
// as the key, then base64. Only needed when the bot enables 签名校验.
export function genSign(secret: string, timestamp: number): string {
  return createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
}

export interface SendDeps {
  fetch: typeof fetch;
  now: () => number; // unix seconds
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

export async function sendFeishu(
  webhook: string,
  card: FeishuCard,
  opts: { secret?: string; deps?: Partial<SendDeps> } = {},
): Promise<SendResult> {
  const doFetch = opts.deps?.fetch ?? fetch;
  const now = opts.deps?.now ?? (() => Math.floor(Date.now() / 1000));

  let body: Record<string, unknown> = { ...card };
  if (opts.secret) {
    const ts = now();
    body = { timestamp: String(ts), sign: genSign(opts.secret, ts), ...card };
  }

  try {
    const res = await doFetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    // Feishu returns { code: 0, msg: "success" } on success; nonzero code = error.
    const data = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
    if (data.code && data.code !== 0) return { ok: false, error: data.msg ?? `code ${data.code}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
