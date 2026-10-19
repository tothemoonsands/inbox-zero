import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { StreamTextTransform, ToolSet } from "ai";

type Outcome = "completed" | "error" | "interrupted";
type Task = {
  client: string;
  model: string;
  taskId: string;
  sessionId: string;
  runtimeTaskId: string;
  endpoint: string;
  fetcher: typeof fetch;
  useCase?: string;
  failed?: boolean;
};
type Scope = {
  sessionId: string;
  tasks: Map<string, Promise<Task | null>>;
  closed: boolean;
  useCase?: string;
};

const scopes = new AsyncLocalStorage<Scope>();
const MAX_EVENT_BYTES = 128 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function withInferenceLearningTask<T>(
  operation: () => Promise<T>,
  outcomeOf: (result: T) => Outcome | undefined = () => "completed",
): Promise<T> {
  if (scopes.getStore()) return operation();
  const task = createInferenceLearningTask();
  return task.run(async () => {
    let outcome: Outcome | undefined = "error";
    try {
      const result = await operation();
      outcome = outcomeOf(result);
      return result;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        outcome = "interrupted";
      }
      throw error;
    } finally {
      await task.end(outcome);
    }
  });
}

export function createInferenceLearningStream(
  useCase: string,
  abortSignal?: AbortSignal,
) {
  const task = createInferenceLearningTask(useCase);
  let streamOutcome: Outcome | undefined;
  const interrupt = () => {
    end("interrupted").catch(() => {});
  };
  const end = async (outcome: Outcome | undefined) => {
    abortSignal?.removeEventListener("abort", interrupt);
    await task.end(outcome);
  };
  if (abortSignal?.aborted) interrupt();
  else abortSignal?.addEventListener("abort", interrupt, { once: true });
  const transform: StreamTextTransform<ToolSet> = () =>
    new TransformStream({
      async transform(chunk, controller) {
        controller.enqueue(chunk);
        await task.run(async () => {
          if (chunk.type === "tool-result" || chunk.type === "tool-error") {
            await recordInferenceLearningTool({
              tool: chunk.toolName,
              output:
                chunk.type === "tool-result"
                  ? chunk.output
                  : { status: "failed" },
              isError: chunk.type === "tool-error",
            });
          } else if (chunk.type === "error") {
            streamOutcome = "error";
          } else if (chunk.type === "abort") {
            streamOutcome = "interrupted";
          } else if (chunk.type === "finish" && !streamOutcome) {
            streamOutcome =
              chunk.finishReason === "stop" ? "completed" : undefined;
          }
        });
      },
      async flush() {
        await end(streamOutcome);
      },
    });
  return { run: task.run, end, transform };
}

export function createInferenceLearningFetch(
  baseURL: string,
  model: string,
  fetcher: typeof fetch = fetch,
): typeof fetch | undefined {
  let base: URL;
  try {
    base = new URL(baseURL);
    if (
      base.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
      base.port !== "12345" ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      !/^\/(?:[a-z][a-z0-9_-]*\/)?v1\/?$/.test(base.pathname)
    ) {
      return;
    }
  } catch {
    return;
  }
  return async (input, init) => {
    const scope = scopes.getStore();
    if (!scope || scope.closed) return fetcher(input, init);
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    if (
      url.origin !== base.origin ||
      !["chat/completions", "responses"].some(
        (route) =>
          url.pathname === `${base.pathname.replace(/\/$/, "")}/${route}`,
      )
    ) {
      return fetcher(input, init);
    }
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const client = headers.get("x-inference-client");
    if (!client || client.length > 100) return fetcher(input, init);
    const key = JSON.stringify([client, model, base.origin]);
    let pending = scope.tasks.get(key);
    if (!pending) {
      if (scope.tasks.size >= 8) return fetcher(input, init);
      pending = startTask({
        client,
        model,
        taskId: randomUUID(),
        sessionId: scope.sessionId,
        endpoint: `${base.origin}/interactive/v1/harness/task`,
        fetcher,
        useCase: scope.useCase,
      });
      scope.tasks.set(key, pending);
    }
    const task = await pending;
    if (!task || scope.closed) return fetcher(input, init);
    headers.set("x-switchboard-harness-task", task.runtimeTaskId);
    headers.set("x-switchboard-harness-session", task.sessionId);
    // The provider owns serialization, retries, streaming and all tool schemas.
    try {
      const response = await fetcher(input, { ...init, headers });
      task.failed = !response.ok;
      return response;
    } catch (error) {
      task.failed = true;
      throw error;
    }
  };
}

export async function recordInferenceLearningModelFailure(
  model: string | undefined,
): Promise<void> {
  const scope = scopes.getStore();
  if (!scope || scope.closed) return;
  await Promise.all(
    [...scope.tasks.values()].map(async (pending) => {
      const task = await pending;
      if (task && task.model === model) task.failed = true;
    }),
  );
}

export async function recordInferenceLearningTool(receipt: {
  tool: string;
  output: unknown;
  isError: boolean;
}): Promise<void> {
  const scope = scopes.getStore();
  if (!scope || scope.closed) return;
  await Promise.all(
    [...scope.tasks.values()].map(async (pending) => {
      const task = await pending;
      if (task && !task.failed)
        await sendEvent(task, { type: "tool", ...receipt });
    }),
  );
}

function createInferenceLearningTask(useCase?: string) {
  const scope: Scope = {
    sessionId: randomUUID(),
    tasks: new Map(),
    closed: false,
    useCase,
  };
  let ending: Promise<void> | undefined;
  return {
    run: <T>(operation: () => T): T => scopes.run(scope, operation),
    end(outcome: Outcome | undefined): Promise<void> {
      if (ending) return ending;
      scope.closed = true;
      ending = Promise.all(
        [...scope.tasks.values()].map(async (pending) => {
          const task = await pending;
          if (task)
            await sendEvent(task, {
              type: outcome === "interrupted" ? "interrupt" : "end",
              outcome:
                task.failed && outcome === "completed" ? "error" : outcome,
            });
        }),
      ).then(() => {
        scope.tasks.clear();
      });
      return ending;
    },
  };
}

async function startTask(
  task: Omit<Task, "runtimeTaskId">,
): Promise<Task | null> {
  const response = await sendEvent(task, { type: "start" });
  if (
    response?.active !== true ||
    response.taskId !== task.taskId ||
    typeof response.runtimeTaskId !== "string" ||
    !UUID.test(response.runtimeTaskId)
  ) {
    return null;
  }
  return { ...task, runtimeTaskId: response.runtimeTaskId };
}

async function sendEvent(
  task: Omit<Task, "runtimeTaskId">,
  event: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  try {
    const body = JSON.stringify({
      client: task.client,
      model: task.model,
      adapterVersion: 1,
      ...(task.useCase ? { useCase: task.useCase } : {}),
      event: { ...event, taskId: task.taskId, sessionId: task.sessionId },
    });
    if (Buffer.byteLength(body) > MAX_EVENT_BYTES) return null;
    const response = await task.fetcher(task.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_EVENT_BYTES) return null;
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    // Optional learning has no authority to retry, block or alter mail actions.
    return null;
  }
}
