import { ContextCategoryKeys } from "../../src/session/context-usage-schema"
import type { ContextUsage } from "../../src/session/context-usage"

export function contextDraft(tokens = 80): ContextUsage.Draft {
  return {
    modelID: "test",
    providerID: "test",
    contextLimit: 1000,
    usableInputLimit: 900,
    categories: Object.fromEntries(
      ContextCategoryKeys.map((category) => [
        category,
        { estimatedTokens: category === "userMessages" ? tokens : 0, items: category === "userMessages" ? 1 : 0 },
      ]),
    ) as ContextUsage.Draft["categories"],
    estimator: { kind: "bounded-utf8", sampledCharacters: tokens * 4, truncated: false },
  }
}
