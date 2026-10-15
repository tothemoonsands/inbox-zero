"use client";

import useSWR from "swr";
import { useAction } from "next-safe-action/hooks";
import { useAccount } from "@/providers/EmailAccountProvider";
import { getAccountScopedKey } from "@/utils/swr";
import { SettingCard } from "@/components/SettingCard";
import { Toggle } from "@/components/Toggle";
import { LoadingContent } from "@/components/LoadingContent";
import { setAutomaticFilingAction } from "@/utils/actions/automatic-filing";
import { createSettingActionErrorHandler } from "@/utils/actions/error-handling";
import type { GetAutomaticFilingResponse } from "@/app/api/user/automatic-filing/route";

export function AutomaticFilingSetting() {
  const { emailAccountId } = useAccount();
  const { data, isLoading, error, mutate } = useSWR<GetAutomaticFilingResponse>(
    getAccountScopedKey("/api/user/automatic-filing", emailAccountId || null),
  );
  const { execute, isExecuting } = useAction(
    setAutomaticFilingAction.bind(null, emailAccountId ?? ""),
    {
      onSuccess: () => {
        mutate();
      },
      onError: createSettingActionErrorHandler({
        mutate,
        prefix: "Could not update automatic filing",
      }),
    },
  );
  return (
    <SettingCard
      title="File after reading"
      description="Keep incoming mail in Inbox until you read it. Flagged mail stays in Inbox until you remove the flag. Spam is filtered immediately; manual rule runs are unchanged."
      right={
        <LoadingContent loading={isLoading} error={error}>
          <Toggle
            name="file-after-reading"
            enabled={data?.enabled ?? false}
            disabled={!data || isExecuting}
            onChange={(enabled) => execute({ enabled })}
          />
        </LoadingContent>
      }
    />
  );
}
