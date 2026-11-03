import { spawn } from "node:child_process";
import Redis from "ioredis";
import { createRedisHttpServer } from "./local-dev/redis-http";

const commands: Record<string, string[]> = {
  web: ["/app/apps/web/.next/standalone/apps/web/server.js"],
  bulk: ["--import", "tsx", "scripts/run-bulk-rules-worker.ts"],
  corrections: [
    "--import",
    "tsx",
    "scripts/watch-mail-corrections.ts",
    "--config",
    "/run/config/correction-config.json",
    "--state-dir",
    "/var/lib/inbox-zero/correction-state",
  ],
};
const command = commands[process.argv[2]];
if (!command || !process.env.REDIS_URL || !process.env.REDIS_HTTP_TOKEN)
  throw new Error(
    "A supported container role and Redis credentials are required",
  );
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
const bridge = await createRedisHttpServer({
  redis,
  token: process.env.REDIS_HTTP_TOKEN,
  port: 8081,
});
const child = spawn(process.execPath, command, { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => child.kill(signal));
child.once("error", () => {
  console.error("Container process could not start");
  process.exitCode = 1;
  bridge
    .close()
    .catch(() => {
      process.exitCode = 1;
    })
    .finally(() => redis.disconnect());
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
  bridge
    .close()
    .catch(() => {
      process.exitCode = 1;
    })
    .finally(() => redis.disconnect());
});
