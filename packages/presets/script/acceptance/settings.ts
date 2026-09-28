import { z } from "zod"
import { RemoteLab } from "./remote-protocol"
import {
  ModelsDevCatalog,
  missingRequiredModelsDevProviders,
} from "@ericsanchezok/synergy-harness/provider/models-schemas"

export const Settings = z
  .object({
    providerID: z.string().min(1),
    modelID: z.string().min(1),
    upstream: z.url(),
    apiKeyFile: z.string().min(1),
    modelCatalog: z.string().min(1),
    config: z.record(z.string(), z.json()),
    deadlineMs: z.number().int().positive().default(600_000),
    remote: RemoteLab.optional(),
    postgres: z
      .object({ urlFile: z.string().min(1) })
      .strict()
      .optional(),
    chromium: z.string().optional(),
  })
  .strict()
export type Settings = z.infer<typeof Settings>

export async function validateCatalog(settings: Settings) {
  const parsed = ModelsDevCatalog.safeParse(await Bun.file(settings.modelCatalog).json())
  if (!parsed.success || missingRequiredModelsDevProviders(parsed.data).length)
    throw new Error("Frozen model catalog is invalid or incomplete; bundled fallback is not acceptance evidence")
}
