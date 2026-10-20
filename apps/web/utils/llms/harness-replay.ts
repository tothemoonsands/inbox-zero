import { randomUUID, createHash } from "node:crypto";

type Verdict = boolean | null;
type Send = (event: Record<string, unknown>) => Promise<unknown>;
let active = 0;

export function replayText(response: unknown): string | null {
  const value = response as {
    choices?: {
      finish_reason?: string;
      message?: {
        content?: unknown;
        reasoning_content?: unknown;
        tool_calls?: unknown[];
        refusal?: unknown;
      };
    }[];
  };
  if (!Array.isArray(value?.choices) || value.choices.length !== 1) return null;
  const choice = value.choices[0];
  if (
    ["length", "content_filter"].includes(choice.finish_reason ?? "") ||
    choice.message?.refusal ||
    choice.message?.tool_calls?.length
  )
    return null;
  const text = choice.message?.content;
  return typeof text === "string" ? text : null;
}

/** Only app-owned pure parsers belong here. No operation, SDK agent, cache,
 * delivery or pipeline callback may be passed to this function. */
export async function offerReplay(
  send: Send,
  request: unknown,
  validation: Record<string, unknown>,
  check: (response: unknown) => Verdict | Promise<Verdict>,
): Promise<void> {
  if (
    active >= 8 ||
    !request ||
    Buffer.byteLength(JSON.stringify(request)) > 1024 * 1024
  ) {
    await send({ type: "tool", stage: "validation", validation });
    return;
  }
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [
                key,
                canonical((value as Record<string, unknown>)[key]),
              ]),
          )
        : value;
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify(
        canonical(
          Object.fromEntries(
            Object.entries(request).filter(
              ([key]) =>
                ![
                  "model",
                  "_switchboard_harness_task",
                  "_switchboard_harness_source",
                ].includes(key),
            ),
          ),
        ),
      ),
    )
    .digest("hex");
  const token = randomUUID();
  const registered = (await send({
    type: "tool",
    stage: "validation",
    validation,
    replay: { token, requestHash },
  })) as { replayAccepted?: boolean } | null;
  if (!registered?.replayAccepted) return;
  active++;
  // Parser closures and frozen inputs are memory-only, expire, and disappear on
  // restart. Missing validators cannot be replaced with a permissive verdict.
  (async () => {
    const deadline = Date.now() + 15 * 60_000;
    let result: { id: string; passed: Verdict } | undefined;
    try {
      while (Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 3000);
          timer.unref();
        });
        const reply = (await send({
          type: "replay_poll",
          token,
          ...(result ? { result } : {}),
        })) as {
          active?: boolean;
          job?: { id: string; response: unknown };
        } | null;
        result = undefined;
        if (!reply?.active) return;
        if (reply.job) {
          let passed: Verdict = null;
          try {
            passed = await check(reply.job.response);
          } catch {
            /* Unavailable is unknown. */
          }
          result = {
            id: reply.job.id,
            passed: typeof passed === "boolean" ? passed : null,
          };
        }
      }
    } finally {
      active--;
    }
  })().catch(() => {});
}
