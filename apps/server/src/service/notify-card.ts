import type { DeploymentEnvView, DeploymentSummary } from "@ease-deploy/shared";
import type { CardInput } from "../core/notify.ts";

export function buildCardInput(summary: DeploymentSummary, envs: DeploymentEnvView[], publicUrl?: string): CardInput {
  return {
    deploymentId: summary.id,
    status: summary.status,
    countryName: summary.countryName,
    operatorName: summary.operatorName,
    operatorIp: summary.operatorIp,
    totalMs: summary.startedAt && summary.finishedAt ? summary.finishedAt - summary.startedAt : null,
    envs: envs.map((e) => ({
      name: e.envName,
      status: e.status,
      failedStage: e.failedStage,
      error: e.errorSummary,
      commitSha: e.commitSha,
      totalMs: e.totalMs,
    })),
    ...(publicUrl ? { detailUrl: `${publicUrl}/deployments/${summary.id}` } : {}),
  };
}
