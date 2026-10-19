import { randomUUID } from "node:crypto";
import { simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LlmUseCase } from "@/utils/llms/use-cases";
import { toolCallAgentStream } from "./index";
import { createInferenceLearningFetch } from "./inference-learning";

const { mockGetModelForUseCase } = vi.hoisted(() => ({
  mockGetModelForUseCase: vi.fn(),
}));

vi.mock("@/utils/llms/use-cases", async (importActual) => ({
  ...(await importActual<typeof import("@/utils/llms/use-cases")>()),
  getModelForUseCase: mockGetModelForUseCase,
}));

vi.mock("@/utils/llms/model-usage-guard", () => ({
  assertTrialAiUsageAllowed: vi.fn(),
  shouldForceNanoModel: vi.fn().mockResolvedValue({ shouldForce: false }),
}));

vi.mock("@/utils/usage", () => ({ saveAiUsage: vi.fn() }));

vi.mock("@/utils/posthog", () => ({
  getPosthogLlmClient: vi.fn(() => undefined),
  isPosthogLlmEvalApproved: vi.fn(() => false),
}));

describe("toolCallAgentStream abort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not start further tool calls once the run is stopped", async () => {
    const controller = new AbortController();
    // The stop lands while the first tool call is running.
    const archive = vi.fn(async () => {
      controller.abort();
      return "archived";
    });
    mockGetModelForUseCase.mockReturnValue({
      provider: "openai",
      modelName: "test-model",
      model: createToolCallingModel(),
      fallbackModels: [],
      hasUserApiKey: true,
    });

    const result = await toolCallAgentStream({
      userAi: { aiProvider: null, aiModel: null, aiApiKey: null },
      userEmail: "user@test.com",
      emailAccountId: "email-account-id",
      useCase: LlmUseCase.AssistantChat,
      usageLabel: "test",
      promptHardening: { trust: "untrusted", level: "full" },
      messages: [{ role: "user", content: "Archive everything" }],
      tools: {
        archive: tool({ inputSchema: z.object({}), execute: archive }),
      },
      abortSignal: controller.signal,
    });

    const chunkTypes: string[] = [];
    for await (const chunk of result.toUIMessageStream()) {
      chunkTypes.push(chunk.type);
    }

    expect(chunkTypes).toContain("abort");
    expect(archive).toHaveBeenCalledTimes(1);
  });
  it.each([
    false,
    true,
  ])("observes actual streamed actions and keeps callbacks intact (abort=%s)", async (abort) => {
    const events: {
      adapterVersion: number;
      useCase: string;
      event: { type: string; outcome?: string; tool?: string };
    }[] = [];
    const requests: RequestInit[] = [];
    const providerFetch = createInferenceLearningFetch(
      "http://127.0.0.1:12345/mail/v1",
      "local-model",
      async (input, init) => {
        if (String(input).endsWith("/harness/task")) {
          const packet = JSON.parse(String(init?.body));
          events.push(packet);
          return Response.json({
            active: true,
            taskId: packet.event.taskId,
            runtimeTaskId: randomUUID(),
          });
        }
        requests.push(init!);
        return Response.json({});
      },
    )!;
    const controller = new AbortController();
    const archive = vi.fn(async () => {
      if (abort) controller.abort();
      return { archived: true };
    });
    const onStepEnd = vi.fn();
    const onEnd = vi.fn();
    mockGetModelForUseCase.mockReturnValue({
      provider: "openai-compatible",
      modelName: "local-model",
      model: createToolCallingModel(
        () =>
          providerFetch("http://127.0.0.1:12345/mail/v1/chat/completions", {
            headers: { "x-inference-client": "inbox-zero" },
          }),
        true,
      ),
      fallbackModels: [],
      hasUserApiKey: true,
    });
    const result = await toolCallAgentStream({
      userAi: { aiProvider: null, aiModel: null, aiApiKey: null },
      userEmail: "user@test.com",
      emailAccountId: "email-account-id",
      useCase: LlmUseCase.AssistantChat,
      usageLabel: "test",
      promptHardening: { trust: "untrusted", level: "full" },
      messages: [{ role: "user", content: "Archive synthetic message" }],
      tools: { archive: tool({ inputSchema: z.object({}), execute: archive }) },
      abortSignal: controller.signal,
      onStepEnd,
      onEnd,
    });
    const chunks = [];
    for await (const chunk of result.toUIMessageStream()) chunks.push(chunk);
    expect(archive).toHaveBeenCalledTimes(1);
    expect(events[0]).toMatchObject({
      adapterVersion: 1,
      useCase: "assistant-chat",
      event: { type: "start" },
    });
    expect(
      requests.every((request) =>
        new Headers(request.headers).has("x-switchboard-harness-task"),
      ),
    ).toBe(true);
    const terminal = events.filter((row) =>
      ["end", "interrupt"].includes(row.event.type),
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0].event.outcome).toBe(abort ? "interrupted" : "completed");
    if (abort)
      expect(chunks.some((chunk) => chunk.type === "abort")).toBe(true);
    else {
      expect(
        events.some(
          (row) => row.event.type === "tool" && row.event.tool === "archive",
        ),
      ).toBe(true);
      expect(onStepEnd).toHaveBeenCalledTimes(2);
      expect(onEnd).toHaveBeenCalledTimes(1);
      expect(
        chunks.some(
          (chunk) => chunk.type === "text-delta" && chunk.delta === "Done.",
        ),
      ).toBe(true);
    }
  });
});

function createToolCallingModel(
  onCall?: () => Promise<unknown>,
  singleTool = false,
) {
  let callCount = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      await onCall?.();
      callCount++;
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            ...(callCount > 1 && singleTool
              ? [
                  { type: "text-start" as const, id: "text-1" },
                  { type: "text-delta" as const, id: "text-1", delta: "Done." },
                  { type: "text-end" as const, id: "text-1" },
                ]
              : (singleTool ? ["call-1"] : ["call-1", "call-2"]).map(
                  (toolCallId) => ({
                    type: "tool-call" as const,
                    toolCallId,
                    toolName: "archive",
                    input: "{}",
                  }),
                )),
            {
              type: "finish",
              finishReason: {
                unified: callCount > 1 && singleTool ? "stop" : "tool-calls",
                raw: undefined,
              },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
              },
            },
          ],
        }),
      };
    },
  });
}
