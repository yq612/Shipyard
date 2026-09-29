// Starts the API (with --watch) and the Vite dev server together.
// Open http://localhost:5173 — Vite proxies /api to the API on :8080.
const procs = [
  Bun.spawn(["bun", "--watch", "apps/server/src/main.ts"], { stdio: ["inherit", "inherit", "inherit"] }),
  Bun.spawn(["bun", "run", "dev"], { cwd: "apps/web", stdio: ["inherit", "inherit", "inherit"] }),
];

const stop = () => {
  for (const p of procs) p.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const code = await Promise.race(procs.map((p) => p.exited));
stop();
process.exit(code);
