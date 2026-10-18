import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRules } from "@/utils/ai/choose-rule/run-rules";
import { findMatchingRules } from "@/utils/ai/choose-rule/match-rules";
import { filterSpam } from "./gate";
import { createScopedLogger } from "@/utils/logger";
import { getMockMessage } from "@/__tests__/helpers";
import { getEmailForLLM } from "@/utils/get-email-from-message";
vi.mock("./gate", () => ({ filterSpam: vi.fn() }));
vi.mock("@/utils/ai/choose-rule/match-rules", () => ({
  findMatchingRules: vi.fn(),
}));

describe("pre-LLM spam gate", () => {
  beforeEach(() => vi.clearAllMocks());
  it("does not continue to the LLM when extraction fails", async () => {
    vi.mocked(findMatchingRules).mockClear();
    vi.mocked(filterSpam).mockRejectedValueOnce(new Error("extraction limit"));
    await expect(
      runRules({
        provider: {} as never,
        emailAccount: { id: "account" } as never,
        message: getMockMessage(),
        rules: [],
        isTest: false,
        modelType: "default",
        logger: createScopedLogger("spam-test"),
      }),
    ).rejects.toThrow("extraction limit");
    expect(findMatchingRules).not.toHaveBeenCalled();
  });
  it("stops before rule matching or drafting when spam is detected", async () => {
    vi.mocked(filterSpam).mockResolvedValue({
      spam: true,
      score: 0.99,
      corrected: false,
    });
    const result = await runRules({
      provider: {} as never,
      emailAccount: { id: "account" } as never,
      message: getMockMessage(),
      rules: [],
      isTest: false,
      modelType: "default",
      logger: createScopedLogger("spam-test"),
    });
    expect(findMatchingRules).not.toHaveBeenCalled();
    expect(result[0].reason).toContain("99.0%");
  });

  it("scores the original hidden content before exposing sanitized content to AI", async () => {
    const message = {
      ...getMockMessage(),
      textHtml: "<p>Ordinary message</p><span hidden>hidden payload</span>",
    };
    const original = structuredClone(message);
    const stages: string[] = [];
    vi.mocked(filterSpam).mockImplementationOnce(async ({ message }) => {
      stages.push("spam");
      expect(message).toEqual(original);
      return { spam: false, score: 0.1, corrected: false };
    });
    vi.mocked(findMatchingRules).mockImplementationOnce(async ({ message }) => {
      stages.push("ai");
      expect(getEmailForLLM(message).content).toBe("Ordinary message");
      return { matches: [], reasoning: "No matching rule" };
    });
    await runRules({
      provider: {} as never,
      emailAccount: { id: "account" } as never,
      message,
      rules: [],
      isTest: true,
      modelType: "default",
      logger: createScopedLogger("spam-test"),
    });
    expect(stages).toEqual(["spam", "ai"]);
    expect(message).toEqual(original);
  });
});
