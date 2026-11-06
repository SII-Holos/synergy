import type { Config } from "../config/config"
import { Provider } from "../provider/provider"

export namespace DelegationModel {
  export type Ref = { providerID: string; modelID: string }

  export const ROLES = ["parent", "default", "nano", "mini", "mid", "thinking", "long", "creative"] as const
  export type Role = (typeof ROLES)[number]
  export type ConfiguredRole = Exclude<Role, "parent">

  const CONFIGURED: Array<{
    id: ConfiguredRole
    role?: Provider.ModelRole
    summary: string
  }> = [
    { id: "default", summary: "Configured default model." },
    { id: "nano", role: "nano", summary: "Cheap quick tasks." },
    { id: "mini", role: "mini", summary: "Lightweight routing and extraction." },
    { id: "mid", role: "mid", summary: "Routine exploration and background work." },
    { id: "thinking", role: "thinking", summary: "Deep reasoning, architecture, and implementation." },
    { id: "long", role: "long", summary: "Very long inputs." },
    { id: "creative", role: "creative", summary: "Writing, design, and visual work." },
  ]

  export interface Choice {
    id: string
    model?: string
    summary: string
  }

  export interface ResolveInput {
    requested?: string
    parent: Ref
    categoryModel?: Ref
    subtaskModel?: Ref
    agentModel?: Ref
    roleModels: Partial<Record<ConfiguredRole, Ref>>
    available: ReadonlySet<string>
  }

  export function format(model: Ref): string {
    return `${model.providerID}/${model.modelID}`
  }

  export function formatMenu(choices: Choice[]): string {
    return [
      "Delegation models — pass `model`, or omit it to inherit this turn:",
      ...choices.map((choice) =>
        choice.model ? `- ${choice.id}: ${choice.model} — ${choice.summary}` : `- ${choice.id}: ${choice.summary}`,
      ),
      "Explicit provider/model is accepted only when that model is connected and selectable. An unavailable choice fails instead of falling back.",
    ].join("\n")
  }

  export function resolve(input: ResolveInput): Ref {
    const requested = input.requested?.trim()
    if (!requested) return inherited(input)
    if (isRole(requested)) return selectedRole(requested, input)
    const model = explicitRef(requested)
    if (!input.available.has(format(model))) {
      throw new Error(`Model ${JSON.stringify(format(model))} is not available for delegation.\n\n${menuText(input)}`)
    }
    return model
  }

  export function roleModelsFromConfig(cfg: Config.Info): Partial<Record<ConfiguredRole, Ref>> {
    const models: Partial<Record<ConfiguredRole, Ref>> = {}
    for (const role of CONFIGURED) {
      const ref = role.role ? Provider.resolveRoleModelSync(cfg, role.role) : parseConfigModel(cfg.model)
      if (ref) models[role.id] = ref
    }
    return models
  }

  export async function select(input: {
    requested?: string
    parent: Ref
    categoryModel?: Ref
    subtaskModel?: Ref
    agentModel?: Ref
  }): Promise<Ref> {
    const roleModels = await configuredRoleModels()
    const requested = input.requested?.trim()
    const candidates = [input.parent, ...Object.values(roleModels)].filter((model): model is Ref => Boolean(model))
    if (requested && !isRole(requested)) {
      const parsed = tryExplicitRef(requested)
      if (!parsed) {
        const available = await availableKeys(candidates)
        throw new Error(`${formatError(requested)}\n\n${menuText({ ...input, roleModels, available })}`)
      }
      candidates.push(parsed)
    }
    const available = await availableKeys(candidates)
    return resolve({ ...input, roleModels, available })
  }

  export async function descriptionMenu(parent?: Ref): Promise<string> {
    const roleModels = await configuredRoleModels()
    const candidates = [parent, ...Object.values(roleModels)].filter((model): model is Ref => Boolean(model))
    const available = await availableKeys(candidates)
    if (!parent) {
      return formatMenu([
        { id: "parent", summary: "this turn's model; used when model is omitted if it is still available" },
        ...menuChoices({ parent: { providerID: "", modelID: "" }, roleModels, available }).filter(
          (choice) => choice.id !== "parent",
        ),
      ])
    }
    return menuText({ parent, roleModels, available })
  }

  function inherited(input: ResolveInput): Ref {
    if (input.categoryModel) return input.categoryModel
    if (input.subtaskModel) return input.subtaskModel
    if (input.available.has(format(input.parent))) return input.parent
    if (input.agentModel) return input.agentModel
    return input.parent
  }

  function selectedRole(role: Role, input: ResolveInput): Ref {
    if (role === "parent") {
      if (!input.available.has(format(input.parent))) {
        throw new Error(`Role "parent" is not available for delegation.\n\n${menuText(input)}`)
      }
      return input.parent
    }
    const model = input.roleModels[role]
    if (!model || !input.available.has(format(model))) {
      throw new Error(`Role "${role}" has no available model.\n\n${menuText(input)}`)
    }
    return model
  }

  function menuText(input: ResolveInput): string {
    return formatMenu(menuChoices(input))
  }

  function menuChoices(input: Pick<ResolveInput, "parent" | "roleModels" | "available">): Choice[] {
    const choices: Choice[] = input.available.has(format(input.parent))
      ? [{ id: "parent", model: format(input.parent), summary: "this turn; used when model is omitted" }]
      : [{ id: "parent", summary: "this turn's model; used when model is omitted if it is still available" }]
    for (const role of CONFIGURED) {
      const model = input.roleModels[role.id]
      if (!model || !input.available.has(format(model))) continue
      choices.push({ id: role.id, model: format(model), summary: role.summary })
    }
    return choices
  }

  function isRole(value: string): value is Role {
    return (ROLES as readonly string[]).includes(value)
  }

  function explicitRef(value: string): Ref {
    const parsed = tryExplicitRef(value)
    if (!parsed) throw new Error(formatError(value))
    return parsed
  }

  function tryExplicitRef(value: string): Ref | undefined {
    const parsed = Provider.parseModel(value)
    if (!parsed.providerID.trim() || !parsed.modelID.trim()) return undefined
    return { providerID: parsed.providerID, modelID: parsed.modelID }
  }

  function formatError(value: string): string {
    return `Model must be a role (${ROLES.join(", ")}) or provider/model. Got ${JSON.stringify(value)}.`
  }

  function parseConfigModel(value: unknown): Ref | undefined {
    if (typeof value !== "string" || !value.trim()) return undefined
    return tryExplicitRef(value)
  }

  async function configuredRoleModels(): Promise<Partial<Record<ConfiguredRole, Ref>>> {
    const { Config } = await import("../config/config")
    return roleModelsFromConfig(await Config.current())
  }

  async function availableKeys(models: Ref[]): Promise<Set<string>> {
    const available = new Set<string>()
    await Promise.all(
      models.map(async (model) => {
        if (await Provider.isModelAvailable(model)) available.add(format(model))
      }),
    )
    return available
  }
}
