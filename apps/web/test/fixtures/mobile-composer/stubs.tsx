import { setupI18n } from "@lingui/core"
import { createMediaQuery } from "@solid-primitives/media"
import { createRoot, type Component, type JSX } from "solid-js"

// This fixture mounts the real `DefaultComposer` around the real
// `createPromptInputController`, so only two things are replaced: the ambient
// context providers, and the dialogs that open onto unrelated product surfaces.
// Controls under test — the work-context buttons, the agent and permission
// selectors, the add menu, the resize separator and the expand control — are the
// shipped components, not copies.

const i18n = setupI18n({ locale: "en", messages: { en: {} } })

export const useLocale = () => ({
  i18n,
  fmt: {
    relative: () => "now",
    time: (value: number) => String(value),
    date: (value: number) => String(value),
    number: (value: number) => String(value),
  },
  controller: { activeLocale: () => "en", generation: () => 0 },
})

export const useNavigate = () => () => {}
export const useLocation = () => ({ pathname: "/home/session", search: "", hash: "", query: {} })
export const useSearchParams = () => [{} as Record<string, string>, () => {}]
export const useResolvedPath = (path: string) => ({ pathname: path })
export const A: Component<{ href?: string; children?: JSX.Element }> = (props) => (
  <a href={props.href}>{props.children}</a>
)
export const Route: Component = () => null
export const Router: Component<{ children?: JSX.Element }> = (props) => <>{props.children}</>
export const Navigate: Component<{ href?: string }> = () => null

const features = ["workbench", "media", "digital-twin", "blueprint", "lattice", "light-loop", "boss", "note"]
const capabilities = { has: (id: string) => features.includes(id), current: () => ({ features }) }

const workspace = {
  id: "main",
  scopeID: "scope_fixture",
  type: "directory",
  revision: 1,
  binding: { generation: 1, state: "bound", path: "/tmp/fixture", hostID: "host", physicalID: "identity" },
  lifecycle: "active",
  metadata: {},
  sharedWritableWorkspaceIDs: [],
  createdAt: 1,
  updatedAt: 1,
}

const client = {
  global: { health: async () => ({ data: { healthy: true } }) },
  project: {
    directories: async () => ({
      data: {
        version: 1,
        scopeID: "scope_fixture",
        revision: 1,
        mainWorkspaceID: "main",
        additionalWorkspaceIDs: [],
        folders: [{ workspaceID: "main", generation: 1, path: "/tmp/fixture", git: true, available: true }],
      },
    }),
    worktreeInventory: async () => ({ data: { items: [] } }),
  },
  workspace: { list: async () => ({ data: [workspace] }) },
  environment: { get: async () => ({ data: { provider: "native" } }) },
  config: { domain: { update: async () => ({ data: { changedFields: [] } }) } },
  session: {
    abort: async () => ({ data: {} }),
    continue: async () => ({ data: { handled: true } }),
    abandon: async () => ({ data: { repaired: false, paused: false, abandoned: false } }),
    update: async () => ({ data: {} }),
    input: async () => ({ data: {} }),
    selectWorkspace: async () => ({ data: {} }),
    turnExecution: async () => ({ data: [] }),
    messagePage: async () => ({ data: { items: [], referencedRoots: [], nextCursor: null, hasMore: false, total: 0 } }),
  },
  blueprint: {
    loop: {
      get: async () => ({ data: undefined }),
      cancel: async () => ({ data: {} }),
      create: async () => ({ data: {} }),
      start: async () => ({ data: {} }),
    },
  },
  workflow: {
    session: {
      set: async () => ({ data: {} }),
      updateLightloop: async () => ({ data: {} }),
      cancelLightloop: async () => ({ data: {} }),
      getLightloopTerminal: async () => ({ data: undefined }),
    },
  },
  digitalTwin: { predictNextInput: async () => ({ data: undefined }) },
  voice: { transcribe: async () => ({ data: { text: "" } }) },
}

export const useSDK = () => ({
  client,
  capabilities,
  connected: () => true,
  directory: "/tmp/fixture",
  isHome: false,
  scopeID: "scope_fixture",
  scopeKey: "scope_fixture",
  url: "http://127.0.0.1:1",
  event: { on: () => () => {}, listen: () => () => {} },
})

export const useGlobalSDK = () => ({ url: "http://127.0.0.1:1", client, capabilities })

// `useProviders` reads a full provider snapshot and destructures the scope
// state accessor pair, so both shapes are spelled out rather than left empty.
const providerSnapshot = {
  all: [{ id: "fixture", name: "Fixture", models: {} }],
  connected: [] as string[],
  profiles: {},
  default: {},
  complete: true,
  runtimeAvailability: {},
  authHealth: {},
}

const fixtureProject = {
  id: "scope_fixture",
  type: "project",
  name: "Fixture project",
  time: { updated: 1, archived: false },
  local: { worktree: "/tmp/fixture", directory: "/tmp/fixture", sandboxes: [], vcs: "git" },
}

export const useGlobalSync = () => ({
  data: { config: {}, scope: [fixtureProject], provider: providerSnapshot },
  reconnectVersion: () => 1,
  refreshScopes: async () => {},
  applyResourceMutationResponse: () => {},
  captureResourceRequest: () => ({}),
  ensureScopeState: () => [undefined, () => {}],
  invalidateResource: () => {},
  loadModelCatalog: async () => {},
  ensureModels: async () => {},
})

export const updatePlanBlueprintOfferState = () => {}
export const refreshPlanBlueprintOfferFromLoadedParts = () => {}
export const GlobalSyncProvider = (props: { children?: JSX.Element }) => <>{props.children}</>

export const useSync = () => ({
  get data() {
    return {
      command: [],
      config: { controlProfile: "guarded", attachment: {} },
      path: { directory: "/tmp/fixture", workspace: { path: "/tmp/fixture" } },
      workspaces: [workspace],
      scope: [],
    }
  },
  scope: undefined,
  session: { get: () => undefined, sync: async () => {} },
  planBlueprintOffer: { equip: () => {}, dismiss: () => {}, mute: () => {} },
  set: () => {},
})

const isDesktop = createRoot(() => createMediaQuery("(min-width: 768px)"))
export const useLayout = () => ({
  isDesktop,
  nav: { navEntryForSession: () => undefined },
  scopes: { list: () => [] },
})
export type NavEntry = { id: string }

export const useParams = () => ({})

export const useLocal = () => ({
  agent: {
    list: () => [{ name: "pico", hidden: false }],
    current: () => ({ name: "pico" }),
    set: () => {},
    ready: () => true,
  },
  model: {
    all: () => [],
    current: () => undefined,
    set: () => {},
    variant: { list: () => [], current: () => undefined, set: () => {}, ready: () => true },
  },
  handoffNewSessionIntent: () => {},
})

export const useInput = () => ({
  controlProfile: () => undefined,
  setControlProfile: () => {},
  sendShortcut: () => "enter",
})
export type SendShortcut = "enter" | "mod-enter"
export type ControlProfileId = "guarded" | "autonomous" | "full_access"

export const DEFAULT_PROMPT: unknown[] = []
export const isPromptEqual = () => true
export const sanitizePrompt = (value: unknown) => value
export type Prompt = unknown[]
export type ContentPart = unknown
export type TextPart = unknown
export type FileAttachmentPart = unknown
export type FileContextItem = unknown
export type ContextItem = unknown
export type UploadedAttachmentPart = unknown
export type NoteAttachmentPart = unknown
export type SessionAttachmentPart = unknown

const emptyContext = { items: () => [], add: () => {}, set: () => {}, reset: () => {}, remove: () => {} }

export const usePrompt = () => ({
  ready: () => true,
  current: () => [],
  assistance: () => undefined,
  setAssistance: () => {},
  revision: () => 0,
  cursor: () => 0,
  dirty: () => false,
  set: () => {},
  reset: () => {},
  resetDraft: () => {},
  placeholder: () => "Describe a task",
  attachments: () => [],
  admissionIdentity: () => "fixture",
  restoreIfUnchanged: () => true,
  recoverDraft: () => {},
  capture: () => ({
    draft: { assistance: () => undefined, current: () => [], context: emptyContext, revision: () => 0 },
    isCurrent: () => true,
    release() {},
  }),
  context: emptyContext,
  prepareProjectTransfer: () => ({ conflict: false, commit: () => true, release: () => {} }),
  attach: () => {},
  shell: () => {},
  plan: () => {},
  boss: () => {},
  lattice: () => {},
  lightLoop: () => {},
  blueprintStart: () => {},
  signal: () => {},
  some: () => false,
  submit: () => {},
  submitArrow: () => {},
})

export const PromptProvider = (props: { children?: JSX.Element }) => <>{props.children}</>
export const InputProvider = (props: { children?: JSX.Element }) => <>{props.children}</>

// The shipped context exposes `options` as a getter that returns an array, not
// as an accessor function; the controller reads it directly.
export const useCommand = () => ({
  options: [] as Array<{
    id: string
    title: string
    description?: string
    keybind?: string
    slash?: string
    disabled?: boolean
    suggested?: boolean
  }>,
  register: () => {},
  trigger: () => {},
  show: () => {},
  keybind: () => "",
  keybinds: () => {},
  suspended: () => false,
})

export const useServer = () => ({
  url: "http://127.0.0.1:1",
  list: [],
  setActive: () => {},
  scopes: { open: () => {} },
})
export const normalizeServerUrl = (url: string) => url
export const serverDisplayName = (url: string) => url.replace(/^https?:\/\//, "")

export const usePlatform = () => ({ platform: "web", fetch: globalThis.fetch })
export type Platform = Record<string, unknown>

export const useWorkbenchPanels = () => ({ openPanel: () => {} })

export const draftTransitionKey = () => "draft:fixture"
export const useSessionTransition = () => ({
  get: () => undefined,
  getRecovery: () => undefined,
  clearRecovery: () => {},
  setRecovery: () => {},
  prepareDraft: () => undefined,
  handoffMessage: () => undefined,
  messageArrival: () => undefined,
  messageIdentity: () => undefined,
})

export const useSessionDataView = () => () => ({
  messagesFor: () => [],
  statusFor: () => ({ type: "idle" }),
  planBlueprintOfferFor: () => undefined,
  cortexTasks: () => [],
  inboxFor: () => [],
})

export const useViewActivity = () => () => true

export const useFile = () => ({ searchFilesAndDirectories: async () => [], view: { selectedLines: () => null } })
export const useProjectFiles = () => ({ roots: () => [], search: async () => [], open: async () => {} })
export const useConfirm = () => ({ ask: async () => true })

export const emptyPlanBlueprintOfferState = () => ({
  state: "idle",
  offer: undefined,
  blueprint: undefined,
  lattice: undefined,
  lightloop: undefined,
  plan: undefined,
})
export const shouldDisplayPlanBlueprintOffer = () => false
export type PlanBlueprintOffer = unknown

const stubSurface = (name: string) => {
  const Surface: Component<Record<string, unknown>> = () => <div data-stub-surface={name} />
  return Surface
}

export const DialogWorkspace = stubSurface("workspace")
export const DialogIndependentCopy = stubSurface("independent-copy")
export const DialogScopeEdit = stubSurface("scope-edit")
export const DialogWorktrees = stubSurface("worktrees")
export const DialogWorkingLocation = stubSurface("working-location")
export const DialogProjectDirectoryRecovery = stubSurface("project-directory-recovery")
export const DialogCreateProject = stubSurface("create-project")
export const DialogSelectProject = stubSurface("select-project")
export const DialogSelectServer = stubSurface("select-server")
export const ProjectMenuContent = stubSurface("project-menu")
export const pickProjectDirectories = async () => null
export const useProjectDirectoryPicker = () => ({ pickProjectDirectories })

// The shipped stylesheet hides this trigger on narrow layouts and under the
// default shell, so it is rendered rather than removed: the hiding rule stays
// under test instead of being satisfied by absence.
export const ModelSelectorPopover = (props: {
  triggerAs?: (attributes: Record<string, unknown>) => JSX.Element
}): JSX.Element => (props.triggerAs ? props.triggerAs({}) : null)

export const SettingsDialog: Component = () => null
export const LatticeConfigDialog: Component = () => null
export type LatticeEnableConfig = unknown
