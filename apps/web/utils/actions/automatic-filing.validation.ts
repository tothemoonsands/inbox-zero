import { z } from "zod";

export const automaticFilingSetting = z.object({ enabled: z.boolean() });
