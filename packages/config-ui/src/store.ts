import { createStore } from "solid-js/store"
import type {
  ConfigProvider,
  ConnectedProviderSource,
  CustomProviderDraft,
  FinalizeSetupInput,
  StagedAuthChange,
} from "./api"

export type SetupPhase =
  | "welcome"
  | "import"
  | "connect-provider"
  | "choose-models"
  | "recall-setup"
  | "validate-core"
  | "optional-roles"
  | "finish"
export type SetupIntent = "manual" | "import" | null

export interface ProviderInfo {
  id: string
  name: string
  env: string[]
}

export interface ModelInfo {
  id: string
  name: string
  context: number
  reasoning: boolean
  multimodal: boolean
}

export interface ConnectedProvider {
  id: string
  name: string
  source: "builtin" | "override" | "custom"
  sources: ConnectedProviderSource[]
  models: ModelInfo[]
  catalogModelCount: number
  accountModelCount?: number
  modelCountStatus: "catalog" | "verified"
}

export interface IdentityModelConfig {
  baseURL: string
  apiKey: string
  model: string
}

export type ValidationStatus = "idle" | "running" | "passed" | "failed"
export type RequiredCoreField = "model" | "vision_model"
export type RecommendedCoreField = "embedding" | "rerank"
export type CoreField = RequiredCoreField | RecommendedCoreField

export interface CoreFieldValidation {
  valid: boolean
  message: string
  failedRecommended?: boolean
  [key: string]: unknown
}

export interface CoreValidationResult {
  valid: boolean
  fields: Record<CoreField, CoreFieldValidation>
  [key: string]: unknown
}

export interface ValidationRun<Result> {
  status: ValidationStatus
  error: string
  result: Result | null
}

export type CoreValidationState = ValidationRun<CoreValidationResult>

export interface ImportStaticValidationResult {
  valid: boolean
  config: Record<string, unknown> | null
  providers: string[]
  roles: Record<string, string>
  warnings: string[]
}

export interface ImportValidationState {
  static: ValidationRun<ImportStaticValidationResult>
  live: ValidationRun<CoreValidationResult>
}

export interface ImportDraft {
  raw: string
  validation: ImportValidationState
}

export type RoleKey =
  | "nano_model"
  | "mini_model"
  | "mid_model"
  | "thinking_model"
  | "long_context_model"
  | "creative_model"
  | "holos_friend_reply_model"

export type RoleAssignments = Record<RoleKey, string | undefined>

export interface ConfigState {
  phase: SetupPhase
  intent: SetupIntent

  availableProviders: ProviderInfo[]
  connectedProviders: ConnectedProvider[]
  customProviderDraft: CustomProviderDraft
  providerDrafts: Record<string, ConfigProvider>
  stagedAuth: Record<string, StagedAuthChange>

  selectedModel: string
  selectedVisionModel: string

  embeddingConfig: IdentityModelConfig
  rerankConfig: IdentityModelConfig
  coreValidation: CoreValidationState

  roles: RoleAssignments

  importDraft: ImportDraft
  importedConfig: Record<string, unknown> | null
  importedProviders: string[]
  importedRoles: Record<string, string>

  saving: boolean
  saved: boolean
  configPath: string
}

export interface PhaseState {
  complete: boolean
  ready: boolean
}

const MANUAL_FLOW: SetupPhase[] = [
  "welcome",
  "connect-provider",
  "choose-models",
  "recall-setup",
  "validate-core",
  "optional-roles",
  "finish",
]
const IMPORT_FLOW: SetupPhase[] = ["welcome", "import", "finish"]

const emptyIdentityConfig = (): IdentityModelConfig => ({
  baseURL: "",
  apiKey: "",
  model: "",
})

export function createEmptyCustomProviderDraft(): CustomProviderDraft {
  return {
    id: "",
    name: "",
    adapter: "openai-compatible",
    npm: "",
    api: "",
    env: [],
    options: {},
    credentialMode: "synergy",
    apiKey: "",
    models: [
      {
        key: "",
        id: "",
        name: "",
        family: "",
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 0, output: 0 },
        cost: {},
        headers: {},
        options: {},
      },
    ],
  }
}

const emptyCoreValidationResult = (): CoreValidationResult => ({
  valid: false,
  fields: {
    model: { valid: false, message: "" },
    vision_model: { valid: false, message: "" },
    embedding: { valid: false, message: "" },
    rerank: { valid: false, message: "" },
  } as Record<CoreField, CoreFieldValidation>,
})

const emptyValidationRun = <Result>(result: Result | null = null): ValidationRun<Result> => ({
  status: "idle",
  error: "",
  result,
})

const emptyCoreValidation = (): CoreValidationState => emptyValidationRun(emptyCoreValidationResult())

const emptyImportValidation = (): ImportValidationState => ({
  static: emptyValidationRun<ImportStaticValidationResult>(null),
  live: emptyValidationRun(emptyCoreValidationResult()),
})

function createInitialState(): ConfigState {
  return {
    phase: "welcome",
    intent: null,

    availableProviders: [],
    connectedProviders: [],
    customProviderDraft: createEmptyCustomProviderDraft(),
    providerDrafts: {},
    stagedAuth: {},

    selectedModel: "",

    selectedVisionModel: "",

    embeddingConfig: emptyIdentityConfig(),
    rerankConfig: emptyIdentityConfig(),
    coreValidation: emptyCoreValidation(),

    roles: {
      nano_model: undefined,
      mini_model: undefined,
      mid_model: undefined,
      thinking_model: undefined,
      long_context_model: undefined,
      creative_model: undefined,
      holos_friend_reply_model: undefined,
    },

    importDraft: {
      raw: "",
      validation: emptyImportValidation(),
    },
    importedConfig: null,
    importedProviders: [],
    importedRoles: {},

    saving: false,
    saved: false,
    configPath: "",
  }
}

function isIdentityConfigComplete(config: IdentityModelConfig) {
  return Boolean(config.baseURL && config.apiKey && config.model)
}

function hasConnectedModel(connectedProviders: ConnectedProvider[], value: string | undefined) {
  if (!value) return false
  return connectedProviders.some((provider) => provider.models.some((model) => `${provider.id}/${model.id}` === value))
}

function hasConnectedProvider(state: ConfigState) {
  return state.connectedProviders.length > 0
}

function hasPrimaryModels(state: ConfigState) {
  return Boolean(state.selectedModel && state.selectedVisionModel)
}

function hasRecallSetup(state: ConfigState) {
  return isIdentityConfigComplete(state.embeddingConfig) && isIdentityConfigComplete(state.rerankConfig)
}

export function hasPartialRecallSetup(state: ConfigState) {
  const hasEmbedding = isIdentityConfigComplete(state.embeddingConfig)
  const hasRerank = isIdentityConfigComplete(state.rerankConfig)
  return (hasEmbedding || hasRerank) && !(hasEmbedding && hasRerank)
}

export function isRecallSkipped(state: ConfigState) {
  return !hasRecallSetup(state)
}

export function isRequiredCoreValidated(state: ConfigState) {
  return state.coreValidation.status === "passed" && Boolean(state.coreValidation.result?.valid)
}

export const [configStore, setConfigStore] = createStore<ConfigState>(createInitialState())

export function getActivePhaseOrder(state: ConfigState): SetupPhase[] {
  if (state.intent === "import") return IMPORT_FLOW
  if (state.intent === "manual") return MANUAL_FLOW
  return ["welcome"]
}

export function getProgressPhaseOrder(state: ConfigState): SetupPhase[] {
  return getActivePhaseOrder(state).filter((phase) => phase !== "welcome")
}

export function syncConnectedProviders(connectedProviders: ConnectedProvider[]) {
  const nextModel = hasConnectedModel(connectedProviders, configStore.selectedModel) ? configStore.selectedModel : ""
  const nextVisionModel = hasConnectedModel(connectedProviders, configStore.selectedVisionModel)
    ? configStore.selectedVisionModel
    : ""

  const requiredCoreMutated =
    nextModel !== configStore.selectedModel || nextVisionModel !== configStore.selectedVisionModel

  setConfigStore("connectedProviders", connectedProviders)

  if (nextModel !== configStore.selectedModel) {
    setConfigStore("selectedModel", nextModel)
  }

  if (nextVisionModel !== configStore.selectedVisionModel) {
    setConfigStore("selectedVisionModel", nextVisionModel)
  }

  for (const [key, value] of Object.entries(configStore.roles) as Array<[RoleKey, string | undefined]>) {
    if (value && !hasConnectedModel(connectedProviders, value)) {
      setConfigStore("roles", key, undefined)
    }
  }

  if (requiredCoreMutated) touchCoreValidation()
}

export function hydrateManualConfig(config: Record<string, unknown>) {
  const provider = config.provider
  setConfigStore(
    "providerDrafts",
    provider && typeof provider === "object" ? (provider as Record<string, ConfigProvider>) : {},
  )

  setConfigStore("selectedModel", typeof config.model === "string" ? config.model : "")
  setConfigStore("selectedVisionModel", typeof config.vision_model === "string" ? config.vision_model : "")

  const identity =
    config.identity && typeof config.identity === "object" ? (config.identity as Record<string, unknown>) : {}
  const embedding =
    identity.embedding && typeof identity.embedding === "object" ? (identity.embedding as Record<string, unknown>) : {}
  const rerank =
    identity.rerank && typeof identity.rerank === "object" ? (identity.rerank as Record<string, unknown>) : {}

  setConfigStore("embeddingConfig", {
    baseURL: typeof embedding.baseURL === "string" ? embedding.baseURL : "",
    apiKey: typeof embedding.apiKey === "string" ? embedding.apiKey : "",
    model: typeof embedding.model === "string" ? embedding.model : "",
  })

  setConfigStore("rerankConfig", {
    baseURL: typeof rerank.baseURL === "string" ? rerank.baseURL : "",
    apiKey: typeof rerank.apiKey === "string" ? rerank.apiKey : "",
    model: typeof rerank.model === "string" ? rerank.model : "",
  })

  for (const key of Object.keys(configStore.roles) as RoleKey[]) {
    const value = config[key]
    setConfigStore("roles", key, typeof value === "string" ? value : undefined)
  }
}

export function resetCoreValidation() {
  setConfigStore("coreValidation", emptyCoreValidation())
}

export function touchCoreValidation() {
  if (configStore.coreValidation.status === "idle") return
  resetCoreValidation()
}

export function getRequiredCorePayload(state: ConfigState): FinalizeSetupInput {
  const payload: FinalizeSetupInput = {
    model: state.selectedModel || undefined,
    vision_model: state.selectedVisionModel || undefined,
    embedding: isIdentityConfigComplete(state.embeddingConfig)
      ? {
          baseURL: state.embeddingConfig.baseURL,
          apiKey: state.embeddingConfig.apiKey,
          model: state.embeddingConfig.model,
        }
      : undefined,
    rerank: isIdentityConfigComplete(state.rerankConfig)
      ? {
          baseURL: state.rerankConfig.baseURL,
          apiKey: state.rerankConfig.apiKey,
          model: state.rerankConfig.model,
        }
      : undefined,
  }

  if (Object.keys(state.providerDrafts).length > 0) {
    payload.provider = state.providerDrafts
  }

  if (Object.keys(state.stagedAuth).length > 0) {
    payload.auth = state.stagedAuth
  }

  return payload
}

export function getFinalizePayload(state: ConfigState): FinalizeSetupInput {
  const payload: FinalizeSetupInput = {
    ...getRequiredCorePayload(state),
  }

  for (const [key, value] of Object.entries(state.roles) as Array<[keyof RoleAssignments, string | undefined]>) {
    if (value) payload[key] = value
  }

  return payload
}

export function isRequiredCoreFilled(state: ConfigState) {
  return hasConnectedProvider(state) && hasPrimaryModels(state) && !hasPartialRecallSetup(state)
}

export function isImportedConfigValidated(state: ConfigState) {
  return (
    state.importDraft.validation.live.status === "passed" && Boolean(state.importDraft.validation.live.result?.valid)
  )
}

export function getPhaseState(state: ConfigState, phase: SetupPhase): PhaseState {
  const hasIntent = state.intent !== null

  switch (phase) {
    case "welcome":
      return { complete: hasIntent, ready: true }
    case "import":
      return {
        complete: state.intent === "import" && isImportedConfigValidated(state),
        ready: state.intent === "import",
      }
    case "connect-provider":
      return {
        complete: state.intent === "manual" && hasConnectedProvider(state),
        ready: state.intent === "manual",
      }
    case "choose-models":
      return {
        complete: state.intent === "manual" && hasPrimaryModels(state),
        ready: state.intent === "manual" && hasConnectedProvider(state),
      }
    case "recall-setup":
      return {
        complete: state.intent === "manual" && !hasPartialRecallSetup(state),
        ready: state.intent === "manual" && hasPrimaryModels(state),
      }
    case "validate-core":
      return {
        complete: state.intent === "manual" && isRequiredCoreValidated(state),
        ready: state.intent === "manual" && isRequiredCoreFilled(state),
      }
    case "optional-roles":
      return {
        complete: state.intent === "manual" && isRequiredCoreValidated(state),
        ready: state.intent === "manual" && isRequiredCoreValidated(state),
      }
    case "finish":
      return {
        complete: state.saved,
        ready:
          state.intent === "import"
            ? isImportedConfigValidated(state)
            : state.intent === "manual"
              ? isRequiredCoreValidated(state)
              : false,
      }
  }
}

export function canAccessPhase(state: ConfigState, phase: SetupPhase) {
  if (phase === state.phase) return true
  if (phase === "welcome") return true

  const activeOrder = getActivePhaseOrder(state)
  if (!activeOrder.includes(phase)) return false

  const targetIndex = activeOrder.indexOf(phase)
  if (targetIndex === -1) return false

  for (const previousPhase of activeOrder.slice(0, targetIndex)) {
    if (!getPhaseState(state, previousPhase).complete) return false
  }

  return getPhaseState(state, phase).ready
}

export function getNextPhase(state: ConfigState): SetupPhase | null {
  const activeOrder = getActivePhaseOrder(state)
  const index = activeOrder.indexOf(state.phase)
  if (index === -1 || index === activeOrder.length - 1) return null

  const nextPhase = activeOrder[index + 1]
  return canAccessPhase(state, nextPhase) ? nextPhase : null
}

export function getPreviousPhase(state: ConfigState): SetupPhase | null {
  const activeOrder = getActivePhaseOrder(state)
  const index = activeOrder.indexOf(state.phase)
  if (index <= 0) return null
  return activeOrder[index - 1]
}

export function selectIntent(intent: Exclude<SetupIntent, null>) {
  setConfigStore({
    ...createInitialState(),
    intent,
    phase: intent === "import" ? "import" : "connect-provider",
  })
}

export function resetSetupFlow() {
  setConfigStore(createInitialState())
}

export function goToNextPhase() {
  const nextPhase = getNextPhase(configStore)
  if (nextPhase) setConfigStore("phase", nextPhase)
}

export function goToPreviousPhase() {
  const previousPhase = getPreviousPhase(configStore)
  if (!previousPhase) return

  if (configStore.phase === "import" || configStore.phase === "connect-provider") {
    setConfigStore("intent", null)
    setConfigStore("phase", "welcome")
    return
  }

  setConfigStore("phase", previousPhase)
}
