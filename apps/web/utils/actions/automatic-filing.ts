"use server";

import { actionClient } from "@/utils/actions/safe-action";
import { automaticFilingSetting } from "@/utils/actions/automatic-filing.validation";
import prisma from "@/utils/prisma";

export const setAutomaticFilingAction = actionClient
  .metadata({ name: "setAutomaticFiling" })
  .inputSchema(automaticFilingSetting)
  .action(
    async ({ ctx: { userId, emailAccountId }, parsedInput: { enabled } }) => {
      await prisma.emailAccount.update({
        where: { id: emailAccountId, userId },
        data: { autoFileAfterReading: enabled },
      });
      return { enabled };
    },
  );
