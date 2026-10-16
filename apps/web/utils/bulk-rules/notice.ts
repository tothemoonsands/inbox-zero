import type { BulkRuleRun } from "@/generated/prisma/client";

export function isBulkRunTerminal(status: BulkRuleRun["status"]) {
  return status === "COMPLETED" || status === "STOPPED";
}

export function shouldShowBulkRunNotice(run: Pick<BulkRuleRun, "status">) {
  return !isBulkRunTerminal(run.status);
}
