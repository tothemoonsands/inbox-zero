import { InvalidToolInputError } from "ai";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createInferenceLearningFetch,
  createInferenceLearningStream,
  recordInferenceLearningTool,
  recordInferenceLearningValidation,
  recordInferenceLearningModelFailure,
  withInferenceLearningTask,
  recordInferenceLearningWorkflow,
  workflowObservation,
} from "./inference-learning";

const baseURL = "http://127.0.0.1:12345/mail/v1";
const model = "future-local-model";
const privateText = "Synthetic private email text";

describe("local inference learning lifecycle", () => {
  it("keeps verified, pending, skipped and unknown outcomes distinct", () => {
    expect(workflowObservation("passed")).toEqual({
      stage: "outcome",
      status: "passed",
      reason: "ok",
    });
    for (const state of ["pending", "skipped", "unknown"] as const) {
      expect(workflowObservation(state).status).toBe("not_applicable");
    }
    expect(workflowObservation("failed").reason).toBe("outcome_incomplete");
  });

  it("does not promote partial success after an owner reports a missing result", async () => {
    const events: { event: { type: string; observation?: unknown } }[] = [];
    const providerFetch = createInferenceLearningFetch(
      baseURL,
      model,
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
        return Response.json({});
      },
    )!;
    await withInferenceLearningTask(async () => {
      await providerFetch(`${baseURL}/responses`, {
        headers: { "x-inference-client": "inbox-zero" },
      });
      await recordInferenceLearningWorkflow("passed");
      await recordInferenceLearningWorkflow("failed");
      await recordInferenceLearningWorkflow("passed");
    });
    expect(events.at(-1)?.event.observation).toEqual(
      workflowObservation("failed"),
    );
  });
  it("preserves model bodies, schemas, streaming and credentials across a multi-step task", async () => {
    const events: Record<string, unknown>[] = [];
    const requests: RequestInit[] = [];
    const stream = new Response("streamed-response");
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/harness/task")) {
          const packet = JSON.parse(String(init?.body));
          events.push(packet);
          expect(new Headers(init?.headers).get("authorization")).toBeNull();
          return Response.json({
            active: true,
            taskId: packet.event.taskId,
            runtimeTaskId: randomUUID(),
            hint: "Untrusted service prose must not become an app action",
          });
        }
        requests.push(init ?? {});
        return stream;
      },
    );
    const providerFetch = createInferenceLearningFetch(
      baseURL,
      model,
      fetcher,
    )!;
    const body = JSON.stringify({
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: privateText }],
      tools: [
        {
          type: "function",
          function: { name: "mail_action", parameters: { type: "object" } },
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "result", schema: { type: "object" } },
      },
    });
    const signal = new AbortController().signal;
    await withInferenceLearningTask(async () => {
      const response = await providerFetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "x-inference-client": "inbox-zero",
          authorization: "Bearer synthetic-token",
          "x-existing": "kept",
        },
        body,
        signal,
      });
      expect(response).toBe(stream);
      await recordInferenceLearningTool({
        tool: "read",
        output: privateText,
        isError: false,
      });
      await withInferenceLearningTask(() =>
        providerFetch(`${baseURL}/chat/completions`, {
          method: "POST",
          headers: { "x-inference-client": "inbox-zero" },
          body,
        }),
      );
    });
    expect(events.map((row) => (row.event as { type: string }).type)).toEqual([
      "start",
      "tool",
      "end",
    ]);
    expect(JSON.stringify(events[0])).not.toContain(privateText);
    expect(events[0]).toMatchObject({
      client: "inbox-zero",
      model,
      adapterVersion: 1,
    });
    expect(events[2]).toMatchObject({ event: { outcome: "completed" } });
    expect(requests.every((request) => request.body === body)).toBe(true);
    expect(requests[0].signal).toBe(signal);
    const first = new Headers(requests[0].headers);
    const second = new Headers(requests[1].headers);
    expect(first.get("authorization")).toBe("Bearer synthetic-token");
    expect(first.get("x-existing")).toBe("kept");
    expect(first.get("x-inference-client")).toBe("inbox-zero");
    expect(first.get("x-switchboard-harness-task")).toBe(
      second.get("x-switchboard-harness-task"),
    );
    expect(first.get("x-switchboard-harness-session")).toBe(
      second.get("x-switchboard-harness-session"),
    );
  });

  it("keeps concurrent mail tasks isolated and distinguishes actual errors and interruption", async () => {
    const events: {
      event: { type: string; sessionId: string; outcome?: string };
    }[] = [];
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/harness/task")) {
          const packet = JSON.parse(String(init?.body));
          events.push(packet);
          return Response.json({
            active: true,
            taskId: packet.event.taskId,
            runtimeTaskId: randomUUID(),
          });
        }
        return Response.json({});
      },
    );
    const providerFetch = createInferenceLearningFetch(
      baseURL,
      model,
      fetcher,
    )!;
    const call = () =>
      providerFetch(`${baseURL}/chat/completions`, {
        headers: { "x-inference-client": "inbox-zero" },
      });
    const error = new Error("Synthetic provider error");
    const aborted = new DOMException("Interrupted", "AbortError");
    const outcomes = await Promise.allSettled([
      withInferenceLearningTask(async () => {
        await call();
        throw error;
      }),
      withInferenceLearningTask(async () => {
        await call();
        throw aborted;
      }),
    ]);
    expect(outcomes).toEqual([
      { status: "rejected", reason: error },
      { status: "rejected", reason: aborted },
    ]);
    expect(new Set(events.map((row) => row.event.sessionId)).size).toBe(2);
    expect(
      events
        .map((row) => row.event.outcome)
        .filter(Boolean)
        .sort(),
    ).toEqual(["error", "interrupted"]);
  });

  it("does not enroll cloud providers, other local services, or unregistered clients", async () => {
    for (const url of [
      "https://cloud.example/v1",
      "http://localhost:1234/v1",
      "http://user@127.0.0.1:12345/mail/v1",
    ]) {
      expect(createInferenceLearningFetch(url, model)).toBeUndefined();
    }
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ active: false }),
    );
    const providerFetch = createInferenceLearningFetch(
      baseURL,
      model,
      fetcher,
    )!;
    await withInferenceLearningTask(() =>
      providerFetch(`${baseURL}/chat/completions`, {
        headers: { "x-inference-client": "unregistered-mail-client" },
        body: privateText,
      }),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      new Headers(fetcher.mock.calls[1]?.[1]?.headers).get(
        "x-switchboard-harness-task",
      ),
    ).toBeNull();
  });

  it("fails open without retrying a mail action when lifecycle service fails or rejects large receipts", async () => {
    let starts = 0;
    const events: string[] = [];
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/harness/task")) {
          const packet = JSON.parse(String(init?.body));
          events.push(packet.event.type);
          if (packet.event.type === "start") {
            starts++;
            return Response.json({
              active: true,
              taskId: packet.event.taskId,
              runtimeTaskId: randomUUID(),
            });
          }
          throw new Error("Learning service unavailable");
        }
        return Response.json({});
      },
    );
    const sendMail = vi.fn(async () => ({
      sentMessageIds: ["synthetic-send"],
    }));
    const providerFetch = createInferenceLearningFetch(
      baseURL,
      model,
      fetcher,
    )!;
    const result = await withInferenceLearningTask(async () => {
      await providerFetch(`${baseURL}/chat/completions`, {
        headers: { "x-inference-client": "inbox-zero" },
      });
      const receipt = await sendMail();
      await recordInferenceLearningTool({
        tool: "REPLY",
        output: "x".repeat(128 * 1024),
        isError: false,
      });
      await recordInferenceLearningTool({
        tool: "REPLY",
        output: receipt,
        isError: false,
      });
      return receipt;
    });
    expect(result).toEqual({ sentMessageIds: ["synthetic-send"] });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(starts).toBe(1);
    expect(events).toEqual(["start", "tool", "end"]);
  });
  it("does not mark failed local requests successful when the caller recovers elsewhere", async () => {
    const events: { event: { type: string; outcome?: string } }[] = [];
    const providerFetch = createInferenceLearningFetch(
      baseURL,
      model,
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
        return new Response("Unavailable", { status: 503 });
      },
    )!;
    await withInferenceLearningTask(async () => {
      await providerFetch(`${baseURL}/chat/completions`, {
        headers: { "x-inference-client": "inbox-zero" },
      });
      await recordInferenceLearningTool({
        tool: "REPLY",
        output: { success: true },
        isError: false,
      });
      return "fallback result";
    });
    expect(events.map(({ event }) => event.type)).toEqual(["start", "end"]);
    expect(events[1].event.outcome).toBe("error");
  });

  it("leaves pending outcomes unasserted", async () => {
    const events: { event: { type: string; outcome?: string } }[] = [];
    const providerFetch = createInferenceLearningFetch(
      baseURL,
      model,
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
        return Response.json({});
      },
    )!;
    await withInferenceLearningTask(
      () =>
        providerFetch(`${baseURL}/responses`, {
          headers: { "x-inference-client": "inbox-zero" },
        }),
      () => undefined,
    );
    expect(events[1].event).not.toHaveProperty("outcome");
  });
  it("preserves Request header replacement and marks rejected model output before fallback", async () => {
    const events: { event: { type: string; outcome?: string } }[] = [];
    const requests: RequestInit[] = [];
    const providerFetch = createInferenceLearningFetch(
      baseURL,
      model,
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
    await withInferenceLearningTask(async () => {
      await providerFetch(
        new Request(`${baseURL}/chat/completions`, {
          headers: {
            authorization: "Bearer replaced",
            "x-inference-client": "replaced-client",
          },
        }),
        {
          headers: {
            "x-inference-client": "inbox-zero",
            authorization: "Bearer original",
          },
        },
      );
      await recordInferenceLearningModelFailure(model);
      await recordInferenceLearningTool({
        tool: "REPLY",
        output: { success: true },
        isError: false,
      });
    });
    expect(new Headers(requests[0].headers).get("authorization")).toBe(
      "Bearer original",
    );
    expect(events.map((row) => row.event.type)).toEqual(["start", "end"]);
    expect(events[1].event.outcome).toBe("error");
  });
});

it("named validators report failed checks without promoting network success or other models", async () => {
  const packets: Array<{ event: Record<string, unknown> }> = [];
  const fetcher = vi.fn(async (input, init) => {
    if (String(input).endsWith("/harness/task")) {
      const body = JSON.parse(String(init?.body));
      packets.push(body);
      return Response.json({
        active: true,
        taskId: body.event.taskId,
        runtimeTaskId: "10000000-0000-4000-8000-000000000001",
      });
    }
    return Response.json({});
  }) as unknown as typeof fetch;
  const learning = createInferenceLearningFetch(
    "http://127.0.0.1:12345/mail/v1",
    "fixture",
    fetcher,
  )!;
  await withInferenceLearningTask(async () => {
    await learning("http://127.0.0.1:12345/mail/v1/chat/completions", {
      headers: { "x-inference-client": "inbox-zero" },
    });
    await recordInferenceLearningValidation(
      "output_schema",
      "inbox_object_v1",
      true,
      "other-model",
    );
    await recordInferenceLearningValidation(
      "output_schema",
      "inbox_object_v1",
      false,
      "fixture",
    );
  });
  const checks = packets.filter((p) => p.event.validation);
  expect(checks).toHaveLength(1);
  expect(checks[0].event.validation).toEqual({
    version: 2,
    kind: "output_schema",
    validator: "inbox_object_v1",
    passed: false,
  });
});

it("grades SDK argument rejection but not unchecked dynamic tools", async () => {
  const packets: Array<{ event: { validation?: { passed: boolean } } }> = [];
  const transport: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/harness/task")) {
      const body = JSON.parse(String(init?.body));
      packets.push(body);
      return Response.json({
        active: true,
        taskId: body.event.taskId,
        runtimeTaskId: randomUUID(),
      });
    }
    return Response.json({});
  };
  const stream = createInferenceLearningStream("fixture");
  const providerFetch = createInferenceLearningFetch(
    baseURL,
    model,
    transport,
  )!;
  await stream.run(() =>
    providerFetch(`${baseURL}/chat/completions`, {
      headers: { "x-inference-client": "inbox-zero" },
    }),
  );
  const transform = stream.transform({ tools: {}, stopStream: () => {} });
  const chunks = [
    {
      type: "tool-call" as const,
      toolCallId: "invalid",
      toolName: "read",
      input: { path: 7 },
      dynamic: true as const,
      invalid: true as const,
      error: new InvalidToolInputError({
        toolName: "read",
        toolInput: '{"path":7}',
        cause: new Error("schema"),
      }),
    },
    {
      type: "tool-call" as const,
      toolCallId: "unchecked",
      toolName: "remote",
      input: {},
      dynamic: true as const,
    },
    {
      type: "tool-call" as const,
      toolCallId: "valid",
      toolName: "read",
      input: { path: "fixture" },
    },
  ];
  const input = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const received = [];
  for await (const chunk of input.pipeThrough(transform)) received.push(chunk);
  expect(received).toEqual(chunks);
  expect(
    packets
      .filter((p) => p.event.validation)
      .map((p) => p.event.validation?.passed),
  ).toEqual([false, true]);
});
