import { NextResponse } from "next/server";
import { withEmailAccount } from "@/utils/middleware";
import { env } from "@/env";
import prisma from "@/utils/prisma";

export type GetAutomaticFilingResponse = Awaited<ReturnType<typeof getStatus>>;

export const GET = withEmailAccount("user/automatic-filing", async (request) =>
  NextResponse.json(await getStatus(request.auth.emailAccountId)),
);

async function getStatus(emailAccountId: string) {
  const account = await prisma.emailAccount.findUniqueOrThrow({
    where: { id: emailAccountId },
    select: { autoFileAfterReading: true },
  });
  return {
    enabled: account.autoFileAfterReading ?? env.AUTO_FILE_AFTER_READING,
  };
}
