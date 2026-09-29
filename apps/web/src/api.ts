import type {
  ApiErrorBody,
  CancelResult,
  ConfigView,
  CreateDeploymentRequest,
  CreatedDeployment,
  DeploymentDetail,
  DeploymentList,
  DeploymentListQuery,
  PlanRequest,
  PlanResponse,
  ServerStatus,
  WhoAmI,
} from "@shipyard/shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message);
    this.name = "ApiError";
  }
  get code() {
    return this.body.code;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      // Writes are JSON-only on the server (CSRF protection); the browser adds Origin itself.
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(0, { code: "INTERNAL", message: "无法连接到服务，请检查网络或服务是否在运行" });
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON (proxy error page etc.)
  }
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.code
      ? (data as ApiErrorBody)
      : { code: "INTERNAL" as const, message: `请求失败（HTTP ${res.status}）` };
    throw new ApiError(res.status, err);
  }
  return data as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
  return entries.length ? "?" + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString() : "";
}

export const api = {
  whoami: () => request<WhoAmI>("GET", "/api/whoami"),
  status: () => request<ServerStatus>("GET", "/api/status"),
  config: () => request<ConfigView>("GET", "/api/config"),
  plan: (body: PlanRequest) => request<PlanResponse>("POST", "/api/deployments/plan", body),
  create: (body: CreateDeploymentRequest) => request<CreatedDeployment>("POST", "/api/deployments", body),
  list: (q: DeploymentListQuery) =>
    request<DeploymentList>("GET", `/api/deployments${qs(q as Record<string, string | number | undefined>)}`),
  detail: (id: number) => request<DeploymentDetail>("GET", `/api/deployments/${id}`),
  cancel: (id: number, envIdx?: number) =>
    request<CancelResult>("POST", `/api/deployments/${id}/cancel${envIdx === undefined ? "" : `?env=${envIdx}`}`, {}),
  retry: (id: number, operatorName?: string) =>
    request<CreatedDeployment>("POST", `/api/deployments/${id}/retry`, { operatorName }),
  eventsUrl: (id: number) => `/api/deployments/${id}/events`,
  logsUrl: (id: number, idx: number) => `/api/deployments/${id}/envs/${idx}/logs?follow=1`,
  downloadLogUrl: (id: number, idx: number) => `/api/deployments/${id}/envs/${idx}/logs?download=1`,
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}
