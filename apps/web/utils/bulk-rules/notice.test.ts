import { describe, expect, it } from "vitest";
import { shouldShowBulkRunNotice } from "./notice";

describe("bulk run notices", () => {
  it.each([
    "COMPLETED",
    "STOPPED",
  ] as const)("hides a %s run even without a saved dismissal", (status) => {
    const run = { id: "finished", status, total: 241 };
    expect(shouldShowBulkRunNotice(run)).toBe(false);
  });

  it.each([
    "QUEUED",
    "SCANNING",
    "RUNNING",
    "PAUSED",
  ] as const)("keeps %s work visible", (status) => {
    expect(shouldShowBulkRunNotice({ status })).toBe(true);
  });
});
