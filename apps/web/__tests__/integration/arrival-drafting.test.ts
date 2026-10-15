import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { ActionType, DraftReplyConfidence } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import {
  createTestLogger,
  getAction,
  getEmailAccount,
  getRule,
} from "@/__tests__/helpers";
import { createGmailTestHarness, type GmailTestHarness } from "./helpers";
import prisma from "@/utils/__mocks__/prisma";
import { runRules } from "@/utils/ai/choose-rule/run-rules";
import { findMatchingRules } from "@/utils/ai/choose-rule/match-rules";
import { getActionItemsWithAiArgs } from "@/utils/ai/choose-rule/choose-args";
import {
  createDraftGuard,
  createFilingGuard,
} from "@/utils/mail-corrections/filing-eligibility";

vi.mock("@/utils/prisma");
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/utils/spam/gate", () => ({
  filterSpam: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/utils/redis/owned-lock", () => ({
  acquireOwnedLock: vi.fn().mockResolvedValue("lock"),
  clearOwnedLock: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/utils/ai/choose-rule/match-rules", () => ({
  findMatchingRules: vi.fn(),
}));
vi.mock("@/utils/ai/choose-rule/choose-args", () => ({
  getActionItemsWithAiArgs: vi.fn(),
}));
vi.mock("@/utils/rule/ai-sender-pattern-learning", () => ({
  shouldLearnAiSenderPatterns: vi.fn().mockReturnValue(false),
}));
vi.mock("@/utils/ai/choose-rule/draft-management", () => ({
  handlePreviousDraftDeletion: vi
    .fn()
    .mockResolvedValue({ shouldCreateDraft: true }),
  updateExecutedActionWithDraftId: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/utils/ai/action-attachments", () => ({
  resolveActionAttachments: vi.fn().mockResolvedValue([]),
}));
vi.mock("@inboxzero/tinybird", () => ({
  publishArchive: vi.fn().mockResolvedValue(undefined),
}));

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  "arrival drafting",
  { timeout: 30_000 },
  () => {
    let harness: GmailTestHarness;
    const email = "arrival-draft@example.com";
    const messageId = "unread-request";
    const logger = createTestLogger();
    const executions: Prisma.ExecutedRuleGetPayload<{
      include: { rule: true; actionItems: true };
    }>[] = [];
    const rule = {
      ...getRule("A request requiring a reply"),
      actions: [
        getAction({
          type: ActionType.DRAFT_EMAIL,
          content: "Thanks, I will review this today.",
        }),
        getAction({ type: ActionType.MARK_READ }),
        getAction({ type: ActionType.ARCHIVE }),
      ],
    };

    beforeAll(async () => {
      harness = await createGmailTestHarness({
        port: 4118,
        email,
        messages: [
          {
            id: messageId,
            user_email: email,
            from: "colleague@example.com",
            to: email,
            subject: "Please review",
            body_text: "Can you review the proposal today?",
            label_ids: ["INBOX", "UNREAD"],
            internal_date: "1711900000000",
          },
        ],
      });
    });

    beforeEach(() => {
      executions.length = 0;
      vi.mocked(findMatchingRules).mockResolvedValue({
        matches: [{ rule }],
        reasoning: "Needs reply",
      });
      vi.mocked(getActionItemsWithAiArgs).mockImplementation(
        async ({ selectedRule }) => selectedRule.actions,
      );
      prisma.executedRule.findMany.mockImplementation(async () => executions);
      prisma.executedRule.create.mockImplementation(async ({ data }) => {
        const id = `execution-${executions.length}`;
        const items = data.actionItems?.createMany?.data;
        const execution = {
          ...data,
          id,
          rule,
          ruleId: rule.id,
          emailAccountId: "account",
          createdAt: new Date(),
          updatedAt: new Date(),
          reason: data.reason ?? null,
          actionItems: (Array.isArray(items) ? items : []).map((item, i) => ({
            ...item,
            id: `${id}-action-${i}`,
            executedRuleId: id,
          })),
        } as (typeof executions)[number];
        executions.push(execution);
        return execution;
      });
      prisma.executedRule.update.mockImplementation(async ({ where, data }) => {
        const execution = executions.find((item) => item.id === where.id)!;
        Object.assign(execution, data);
        return execution;
      });
      prisma.executedAction.update.mockResolvedValue({} as never);
    });

    afterAll(async () => {
      await harness?.emulator.close();
    });

    test("creates one draft while unread, then files after reading without another draft", async () => {
      const provider = harness.provider;
      const message = await provider.getMessage(messageId);
      const options = {
        provider,
        message,
        rules: [rule],
        emailAccount: {
          ...getEmailAccount({ email }),
          draftReplyConfidence: DraftReplyConfidence.STANDARD,
        },
        logger,
        isTest: false,
        modelType: "default" as const,
      };
      const first = await runRules({
        ...options,
        draftOnly: true,
        beforeRuleExecution: createDraftGuard(provider, messageId),
      });
      expect(first[0].status).toBe("APPLIED");
      expect(first[0].actionItems?.map((action) => action.type)).toEqual([
        ActionType.DRAFT_EMAIL,
      ]);
      expect((await provider.getMessage(messageId)).labelIds).toEqual(
        expect.arrayContaining(["INBOX", "UNREAD"]),
      );
      const drafts = await harness.gmailClient.users.drafts.list({
        userId: "me",
      });
      expect(drafts.data.drafts).toHaveLength(1);

      await runRules({
        ...options,
        draftOnly: true,
        beforeRuleExecution: createDraftGuard(provider, messageId),
      });
      expect(
        (await harness.gmailClient.users.drafts.list({ userId: "me" })).data
          .drafts,
      ).toHaveLength(1);

      await provider.markRead(message.threadId);
      const filed = await runRules({
        ...options,
        message: await provider.getMessage(messageId),
        beforeRuleExecution: createFilingGuard(provider, messageId),
      });
      expect(filed[0].status).toBe("APPLIED");
      const after = await provider.getMessage(messageId);
      expect(after.labelIds).not.toContain("INBOX");
      expect(after.labelIds).not.toContain("UNREAD");
      expect(
        (await harness.gmailClient.users.drafts.list({ userId: "me" })).data
          .drafts,
      ).toHaveLength(1);
      expect(executions.map((execution) => execution.draftOnly)).toEqual([
        true,
        false,
      ]);
    });
  },
);
