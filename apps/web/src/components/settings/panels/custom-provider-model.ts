import { generateUUID } from "@ericsanchezok/synergy-util/uuid"

export type CustomProviderProtocol = "openai-completions" | "openai-responses" | "anthropic-messages"

export type CustomModelDraft = {
  key: string
  id: string
  name: string
  context: string
  output: string
  toolCall: boolean
  image: boolean
  reasoning: boolean
  expanded: boolean
}

export type CustomProviderFields = {
  providerID: string
  protocol: CustomProviderProtocol
  models: CustomModelDraft[]
}

export function newCustomModel(): CustomModelDraft {
  return {
    key: generateUUID(),
    id: "",
    name: "",
    context: "",
    output: "",
    toolCall: true,
    image: false,
    reasoning: false,
    expanded: false,
  }
}

export function customProviderSignature(fields: CustomProviderFields) {
  return JSON.stringify({ ...fields, models: fields.models.map(({ key, expanded, ...model }) => model) })
}

export function customProviderInput(draft: CustomProviderFields & { name: string; endpoint: string }) {
  type Issue = "id" | "endpoint" | "model" | "duplicate" | "capacity"
  const invalid = (issue: Issue, index?: number) => ({ issue, index, input: undefined })
  const id = draft.providerID.trim()
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)) return invalid("id")
  let endpoint: URL
  try {
    endpoint = new URL(draft.endpoint.trim())
  } catch {
    return invalid("endpoint")
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") return invalid("endpoint")
  if (!draft.models.length) return invalid("model")
  const ids = new Set<string>()
  const models = []
  for (const [index, model] of draft.models.entries()) {
    const modelID = model.id.trim()
    if (!modelID) return invalid("model", index)
    if (ids.has(modelID)) return invalid("duplicate", index)
    ids.add(modelID)
    const context = Number(model.context)
    const output = Number(model.output)
    if (!Number.isSafeInteger(context) || context <= 0 || !Number.isSafeInteger(output) || output <= 0)
      return invalid("capacity", index)
    models.push({
      id: modelID,
      ...(model.name.trim() ? { name: model.name.trim() } : {}),
      context,
      output,
      toolCall: model.toolCall,
      image: model.image,
      reasoning: model.reasoning,
    })
  }
  return {
    issue: undefined,
    index: undefined,
    input: { id, name: draft.name.trim() || id, endpoint: draft.endpoint.trim(), protocol: draft.protocol, models },
  }
}
