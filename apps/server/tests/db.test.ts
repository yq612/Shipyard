import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, openDatabase } from "../src/store/db.ts";
import { Repository } from "../src/store/repo.ts";

test("databases from before projects keep their history, attributed to the recharge site", () => {
  const dir = mkdtempSync(join(tmpdir(), "shipyard-db-"));
  const path = join(dir, "shipyard.db");
  try {
    // The v1 schema, as it exists on servers today.
    const v1 = new Database(path);
    v1.exec(MIGRATIONS[0]!);
    v1.exec("PRAGMA user_version = 1");
    v1.exec(`INSERT INTO deployments (country_code, country_name, status, operator_ip, created_at) VALUES ('PK', '巴基斯坦', 'succeeded', '127.0.0.1', 1)`);
    v1.exec(`INSERT INTO deployment_envs (deployment_id, idx, env_name, branch, server, host, repo_key, repo_url, remote_path, install_cmd, build_cmd, dist, status)
             VALUES (1, 0, 'QuickBuy 环境', 'PK-QuickBuy', 'quickbuypk', '1.1.1.1', 'out', 'u', '/home/topup-web/quickbuypk/dist', 'bun install', 'bun run build', 'dist', 'done')`);
    v1.close();

    const repo = new Repository(openDatabase(path));
    expect(repo.summary(1)).toMatchObject({ projectKey: "topup", projectName: "充值网站", countryCode: "PK", countryName: "巴基斯坦" });
    expect(repo.envs(1)[0]!.node).toBeNull();
    expect(repo.list({ project: "topup" }).total).toBe(1);
    repo.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
