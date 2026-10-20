import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { offerReplay, replayText } from "./harness-replay";

test("replay invokes only a parser, binds its result and keeps inputs out of lifecycle metadata", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const events: Record<string, unknown>[] = [];
  let parsed = 0;
  await offerReplay(
    async (packet) => {
      events.push(packet);
      if (packet.type === "tool") return { replayAccepted: true };
      if (packet.result) {
        assert.deepEqual(packet.result, { id: "job", passed: false });
        return { active: false };
      }
      return {
        active: true,
        job: {
          id: "job",
          response: { choices: [{ message: { content: "bad JSON" } }] },
        },
      };
    },
    {
      model: "local",
      messages: [{ role: "user", content: "PRIVATE_REAL_SOURCE" }],
    },
    { version: 2, validator: "parser_v1", passed: false },
    (response) => {
      parsed++;
      return replayText(response) === "{}";
    },
  );
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(3000);
  }
  vi.useRealTimers();
  assert.equal(parsed, 1);
  assert.equal(events[0].request, undefined);
  assert.match(
    (events[0].replay as { requestHash: string }).requestHash,
    /^[a-f0-9]{64}$/,
  );
  assert.equal(JSON.stringify(events).includes("PRIVATE_REAL_SOURCE"), false);
});
test("tool action proposals and incomplete responses cannot masquerade as parsed text", () => {
  assert.equal(
    replayText({
      choices: [
        { message: { tool_calls: [{ function: { name: "send_message" } }] } },
      ],
    }),
    null,
  );
  assert.equal(
    replayText({
      choices: [{ finish_reason: "length", message: { content: "{}" } }],
    }),
    null,
  );
});
