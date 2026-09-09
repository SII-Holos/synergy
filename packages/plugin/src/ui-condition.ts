import { z } from "zod"
import { PLUGIN_PAGE_IDS } from "./ui-catalog.js"
import type { PluginPageId } from "./ui-catalog.js"

export const PluginUICondition = z
  .object({
    session: z.boolean().optional(),
    pages: z.array(z.enum(PLUGIN_PAGE_IDS)).min(1).optional(),
    platform: z.enum(["web", "desktop"]).optional(),
    visible: z.boolean().optional(),
  })
  .strict()
export type PluginUICondition = z.infer<typeof PluginUICondition>
export function matchesPluginUICondition(
  condition: PluginUICondition | undefined,
  context: { session?: boolean; page?: PluginPageId; platform?: "web" | "desktop"; visible?: boolean },
) {
  if (!condition) return true
  if (condition.session !== undefined && condition.session !== Boolean(context.session)) return false
  if (condition.pages && (!context.page || !condition.pages.includes(context.page))) return false
  if (condition.platform !== undefined && condition.platform !== context.platform) return false
  if (condition.visible !== undefined && condition.visible !== context.visible) return false
  return true
}
