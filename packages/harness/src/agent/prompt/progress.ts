import type { Provider } from "../../provider/provider"

export const PROGRESS_UPDATES = `## Progress Updates

For substantial work, briefly state your initial direction and share meaningful progress. Between updates, continue with tools.

Send a brief update only when new information changes the user's expectations or requires their attention: a finding, a change of approach, a blocker, or a decision. Judge novelty against what you have already told the user; rewording the same issue is not an update. Do not narrate routine tool calls or steps.

Wait for results before conclusions. Use the user's language; finish with the result and relevant verification.`

const EXCLUDED_MODEL_FAMILIES = ["deepseek"]

type ModelIdentity = Partial<Pick<Provider.Model, "id" | "family">> & { api?: Pick<Provider.Model["api"], "id"> }

export function withProgressUpdates(prompt: string | undefined, model: ModelIdentity): string {
  const trimmed = prompt?.trim() ?? ""
  const excluded = [model.id, model.api?.id, model.family].some((identity) => {
    const name = identity
      ?.toLowerCase()
      .split("/")
      .at(-1)
      ?.replace(/^(?:us|eu|apac|global)\./, "")
    return EXCLUDED_MODEL_FAMILIES.some(
      (family) => name === family || name?.startsWith(`${family}-`) || name?.startsWith(`${family}.`),
    )
  })
  if (excluded || trimmed.includes("## Progress Updates") || trimmed.includes("## Preamble Messages")) return trimmed
  return [trimmed, PROGRESS_UPDATES].filter(Boolean).join("\n\n")
}
