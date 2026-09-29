// One-command release: the server pulls origin/main, so refuse unless local
// HEAD is exactly that (clean, pushed, not behind), then run
// deploy/upgrade.sh on the server over SSH.
//   bun run deploy [user@host]    default target: DEPLOY_SSH, e.g. in .env.local
import { $ } from "bun";

const target = process.argv[2] ?? process.env.DEPLOY_SSH;
const dir = process.env.DEPLOY_DIR ?? "/opt/shipyard";
if (!target) fail("用法：bun run deploy <user@host>，或在 .env.local 里设置 DEPLOY_SSH");

if ((await $`git status --porcelain --untracked-files=no`.text()).trim()) {
  fail("有未提交的改动：服务器只部署 origin/main");
}
await $`git fetch -q origin main`;
const [head, remote] = await Promise.all([$`git rev-parse HEAD`.text(), $`git rev-parse origin/main`.text()]);
if (head.trim() !== remote.trim()) fail("本地 HEAD 和 origin/main 不一致：先 push / pull，保证部署的就是你本地这一版");

console.log(`部署 ${(await $`git log --oneline -1`.text()).trim()} → ${target}:${dir}`);
const ssh = Bun.spawn(["ssh", ...(process.stdin.isTTY ? ["-t"] : []), target, `cd ${dir} && deploy/upgrade.sh`], {
  stdio: ["inherit", "inherit", "inherit"],
});
const code = await ssh.exited;
if (code === 255) {
  console.error(`SSH 出错或断开。升级如果已经开始，会在服务器上跑完：ssh ${target} tail -f ${dir}/data/upgrade.log`);
}
process.exit(code);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
