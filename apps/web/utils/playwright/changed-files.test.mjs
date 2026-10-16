import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

const script = path.resolve(
  import.meta.dirname,
  "../../../../scripts/playwright-changed-files.sh",
);

describe("browser workflow changed files", () => {
  test.each([
    "push",
    "pull_request",
  ])("includes every commit in a %s and identifies changed browser specs", (event) => {
    withRepository(({ directory, base, head, run }) => {
      expect(run(event, base, head).status).toBe(0);
      expect(
        readFileSync(path.join(directory, "changed-files.txt"), "utf8"),
      ).toBe(
        [
          "apps/web/__tests__/playwright/emulated/automation/bulk-processing.spec.ts",
          "apps/web/app/banner.tsx",
          "",
        ].join("\n"),
      );
      expect(
        readFileSync(
          path.join(directory, "changed-playwright-files.txt"),
          "utf8",
        ),
      ).toBe(
        "__tests__/playwright/emulated/automation/bulk-processing.spec.ts\n",
      );
      expect(readFileSync(path.join(directory, "github-env"), "utf8")).toBe(
        readFileSync(path.join(directory, "github-output"), "utf8"),
      );
    });
  });

  test.each([
    "schedule",
    "workflow_dispatch",
  ])("leaves the change list empty for a full %s run", (event) => {
    withRepository(({ directory, base, head, run }) => {
      expect(run(event, base, head).status).toBe(0);
      expect(
        readFileSync(path.join(directory, "changed-files.txt"), "utf8"),
      ).toBe("");
    });
  });

  test.each([
    "",
    "0000000000000000000000000000000000000000",
  ])("keeps full coverage when the push has no usable baseline: %s", (base) => {
    withRepository(({ directory, head, run }) => {
      expect(run("push", base, head).status).toBe(0);
      expect(
        readFileSync(path.join(directory, "changed-files.txt"), "utf8"),
      ).toBe("");
    });
  });

  test("fails the workflow when a nonempty baseline cannot be fetched", () => {
    withRepository(({ head, run }) => {
      expect(run("push", "missing-commit", head).status).not.toBe(0);
    });
  });
});

function withRepository(callback) {
  const directory = mkdtempSync(path.join(tmpdir(), "browser-changes-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    RUNNER_TEMP: directory,
    GITHUB_ENV: path.join(directory, "github-env"),
    GITHUB_OUTPUT: path.join(directory, "github-output"),
  };
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: directory,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git("init", "--quiet");
    git("remote", "add", "origin", directory);
    git("commit", "--allow-empty", "-m", "Base");
    const base = git("rev-parse", "HEAD");
    for (const file of [
      "apps/web/app/banner.tsx",
      "apps/web/__tests__/playwright/emulated/automation/bulk-processing.spec.ts",
    ]) {
      git(
        "update-index",
        "--add",
        "--cacheinfo",
        "100644",
        git("hash-object", "-w", "--stdin"),
        file,
      );
      git("commit", "-m", "Change file");
    }
    const head = git("rev-parse", "HEAD");
    callback({
      directory,
      base,
      head,
      run: (event, from, to) =>
        spawnSync("bash", [script], {
          cwd: directory,
          env: {
            ...env,
            GITHUB_EVENT_NAME: event,
            BASE_SHA: from,
            GITHUB_SHA: to,
          },
          encoding: "utf8",
        }),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
