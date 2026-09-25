import { afterEach, describe, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { setupI18n } from "@lingui/core"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"

// The prompt-input mode selector is the composer's own Full Access activation
// path. This suite mounts the real `createPromptInputController` and clicks the
// real toolbar selector, so removing the `fullAccessAck.ensure` call in
// `updateControlProfile` fails the suite. Contexts the acknowledgement path does
// not read are stubbed at their module boundary; the composable, the confirm
// dialog, the selector, and the handler are all production code.
await plugin({
  name: "prompt-full-access-ack-dom",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => ({
      contents: (await transformAsync(await Bun.file(path).text(), {
        filename: path,
        presets: [
          [import.meta.resolve("babel-preset-solid"), { generate: "dom" }],
          [import.meta.resolve("@babel/preset-typescript"), { isTSX: true, allExtensions: true }],
        ],
        sourceMaps: "inline",
      }))!.code!,
      loader: "js",
    }))
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
  },
})

const i18n = setupI18n({ locale: "en", messages: { en: {} } })
const translate = i18n._.bind(i18n)
mock.module("@lingui/solid", () => ({ useLingui: () => ({ _: translate }) }))

let config: Record<string, unknown> = {}
const configWrites: unknown[] = []
const sessionWrites: Array<{ sessionID: string; controlProfile: string; resolvePendingPermissions?: boolean }> = []

mock.module("../../../src/context/global-sync", () => ({
  GlobalSyncProvider: (props: { children?: unknown }) => props.children,
  updatePlanBlueprintOfferState: () => {},
  refreshPlanBlueprintOfferFromLoadedParts: () => {},
  useGlobalSync: () => ({
    get data() {
      return { config }
    },
    reconnectVersion: () => 1,
  }),
}))

mock.module("../../../src/context/global-sdk", () => ({
  useGlobalSDK: () => ({
    capabilities: { has: () => true },
    url: "http://127.0.0.1:0",
    client: {
      config: {
        domain: {
          update: async (input: { configDomainUpdateInput: { config: unknown } }) => {
            configWrites.push(input.configDomainUpdateInput.config)
            const patch = input.configDomainUpdateInput.config as { fullAccessAcknowledged?: boolean }
            if (patch.fullAccessAcknowledged === true) config = { ...config, fullAccessAcknowledged: true }
            return { data: { changedFields: ["fullAccessAcknowledged"] } }
          },
        },
      },
    },
  }),
}))

mock.module("@ericsanchezok/synergy-sdk/client", () => ({
  createSynergyClient: () => ({
    session: {
      update: async (input: { sessionID: string; controlProfile: string; resolvePendingPermissions?: boolean }) => {
        sessionWrites.push(input)
        return { data: {} }
      },
      input: async () => ({ data: {} }),
      messagePage: async () => ({
        data: { items: [], referencedRoots: [], nextCursor: null, hasMore: false, total: 0 },
      }),
    },
  }),
}))

mock.module("../../../src/context/locale", () => ({
  useLocale: () => ({ controller: { activeLocale: () => "en" }, i18n, fmt: { relative: () => "now" } }),
}))

mock.module("@solidjs/router", () => ({
  useParams: () => ({ dir: "home", id: "ses_prompt" }),
  useNavigate: () => () => {},
}))

mock.module("../../../src/context/sdk", () => ({
  useSDK: () => ({
    client: {
      session: {
        get: async () => ({ data: {} }),
        statuses: async () => ({ data: {} }),
        update: async (input: { sessionID: string; controlProfile: string; resolvePendingPermissions?: boolean }) => {
          sessionWrites.push(input)
          return { data: {} }
        },
      },
    },
    connected: () => true,
    directory: "/tmp/fixture",
    isHome: false,
    scopeKey: "home",
    url: "http://127.0.0.1:0",
    event: { listen: () => () => {}, on: () => () => {} },
  }),
}))

mock.module("../../../src/context/sync", () => ({
  useSync: () => ({
    get data() {
      return {
        command: [],
        config: { controlProfile: "guarded", attachment: {} },
        path: { directory: "/tmp/fixture" },
      }
    },
    session: { get: () => ({ id: "ses_prompt", controlProfile: undefined, scope: { id: "scope_fixture" } }) },
    planBlueprintOffer: { equip: () => {}, dismiss: () => {}, mute: () => {} },
  }),
}))

mock.module("../../../src/context/local", () => ({
  useLocal: () => ({
    agent: {
      list: () => [],
      current: () => ({ name: "synergy" }),
      set: () => {},
      ready: () => true,
    },
    model: {
      all: () => [],
      current: () => undefined,
      set: () => {},
      variant: { list: () => [], current: () => undefined, set: () => {} },
    },
  }),
}))

mock.module("../../../src/context/file", () => ({
  useFile: () => ({
    searchFilesAndDirectories: async () => [],
    view: { selectedLines: () => null },
  }),
}))

mock.module("../../../src/context/input", () => ({
  InputProvider: (props: { children?: unknown }) => props.children,
  useInput: () => ({
    controlProfile: () => undefined,
    setControlProfile: () => {},
    sendShortcut: () => "enter",
  }),
}))

mock.module("../../../src/context/prompt", () => ({
  DEFAULT_PROMPT: [],
  isPromptEqual: () => true,
  sanitizePrompt: (value: unknown) => value,
  PromptProvider: (props: { children?: unknown }) => props.children,
  usePrompt: () => ({
    ready: () => true,
    current: () => [],
    dirty: () => false,
    cursor: () => 0,
    set: () => {},
    reset: () => {},
    resetDraft: () => {},
    capture: () => ({ draft: {}, isCurrent: () => true, release() {} }),
    context: { items: () => [], add: () => {}, set: () => {}, reset: () => {}, remove: () => {} },
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
  }),
}))

mock.module("../../../src/context/layout", () => ({
  useLayout: () => ({ isDesktop: () => false, nav: { navEntryForSession: () => undefined } }),
}))

mock.module("../../../src/context/command", () => ({
  useCommand: () => ({ options: [], trigger: () => {}, keybind: () => "", map: () => {}, register: () => {} }),
}))

mock.module("../../../src/context/workbench", () => ({
  useWorkbenchPanels: () => ({ openPanel: () => {} }),
}))

mock.module("../../../src/context/session-transition", () => ({
  useSessionTransition: () => ({ getRecovery: () => undefined, clearRecovery: () => {} }),
}))
mock.module("../../../src/context/platform", () => ({
  usePlatform: () => ({
    platform: "web",
    openLink: () => {},
    restart: async () => {},
    notify: async () => {},
    fetch: globalThis.fetch,
  }),
}))

mock.module("../../../src/context/session-data-view", () => ({
  createSessionDataRuntime: () => ({}),
  useSessionDataView: () => () => ({
    messagesFor: () => [],
    statusFor: () => ({ type: "idle" }),
    planBlueprintOfferFor: () => undefined,
    cortexTasks: () => [],
  }),
}))

mock.module("../../../src/context/plan-blueprint-offer", () => ({
  emptyPlanBlueprintOfferState: () => ({
    state: "idle",
    offer: undefined,
    blueprint: undefined,
    lattice: undefined,
    lightloop: undefined,
    plan: undefined,
  }),
  shouldDisplayPlanBlueprintOffer: () => false,
}))

// The dictation button statically imports the whole Settings surface, which is
// unrelated to the profile selector.
mock.module("../../../src/components/prompt-input/use-voice-dictation", () => ({
  VoiceDictationButton: () => null,
}))
mock.module("../../../src/components/prompt-input/voice-dictation-core", () => ({
  collectDictationContext: () => ({}),
}))
mock.module("../../../src/components/lattice/lattice-config-dialog", () => ({
  LatticeConfigDialog: () => null,
}))
mock.module("@ericsanchezok/synergy-ui/composer-slots", () => ({
  ComposerSlotOutlet: () => null,
}))
mock.module("@ericsanchezok/synergy-ui/toast", () => ({ showToast: () => {} }))

// Static imports of `packages/ui` TSX would compile before this file's Bun
// loader is registered, so the UI surfaces load dynamically after it.
const { createPromptInputController } = await import("../../../src/components/prompt-input/prompt-controller")
const { DialogProvider } = await import("@ericsanchezok/synergy-ui/context/dialog")

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

type Harness = { root: HTMLDivElement; dispose: () => void }

function Toolbar() {
  return createPromptInputController({}).input.render("toolbar")
}

function mount(): Harness {
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(
    () =>
      createComponent(DialogProvider, {
        get children() {
          return createComponent(Toolbar, {})
        },
      }),
    root,
  )
  return { root, dispose }
}

const dialogTitles = () =>
  [...document.querySelectorAll('[data-slot="dialog-title"]')].map((node) => node.textContent?.trim())

const confirmButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-slot="dialog-actions"] button')].find(
    (node) => node.textContent?.trim() === label,
  )

const modeTrigger = (harness: Harness) =>
  harness.root.querySelector<HTMLButtonElement>(".prompt-input-toolbar-button[aria-label$='permission mode']")

async function openModeMenu(harness: Harness) {
  const trigger = modeTrigger(harness)
  expect(trigger, "no prompt-input permission-mode trigger").toBeDefined()
  trigger!.click()
  await settle()
}

async function selectMode(label: string) {
  const item = [...document.querySelectorAll<HTMLButtonElement>('[data-slot="list-item"]')].find((node) =>
    node.textContent?.startsWith(label),
  )
  expect(item, `no prompt-input permission mode labelled ${label}`).toBeDefined()
  item!.click()
  await settle()
}

afterEach(() => {
  config = {}
  configWrites.length = 0
  sessionWrites.length = 0
  localStorage.clear()
  document.body.innerHTML = ""
})

describe("Full Access acknowledgement on the prompt-input mode selector", () => {
  test("prompts when Full Access is chosen and the risk is unrecorded", async () => {
    const harness = mount()
    try {
      await openModeMenu(harness)
      await selectMode("Full Access")

      expect(dialogTitles()).toEqual(["Enable Full Access?"])
      expect(configWrites).toEqual([])
      expect(sessionWrites).toEqual([])
    } finally {
      harness.dispose()
    }
  })

  test("records the acknowledgement then applies Full Access on confirm", async () => {
    const harness = mount()
    try {
      await openModeMenu(harness)
      await selectMode("Full Access")

      confirmButton("Enable Full Access")!.click()
      await settle()

      expect(configWrites).toEqual([{ fullAccessAcknowledged: true }])
      expect(config.fullAccessAcknowledged).toBe(true)
      expect(sessionWrites).toEqual([
        { sessionID: "ses_prompt", controlProfile: "full_access", resolvePendingPermissions: true },
      ])
    } finally {
      harness.dispose()
    }
  })

  test("writes nothing when the human dismisses the warning", async () => {
    const harness = mount()
    try {
      await openModeMenu(harness)
      await selectMode("Full Access")

      confirmButton("Keep current mode")!.click()
      await settle()

      expect(configWrites).toEqual([])
      expect(sessionWrites).toEqual([])
    } finally {
      harness.dispose()
    }
  })

  test("applies Full Access without prompting once the risk is recorded", async () => {
    config = { fullAccessAcknowledged: true }
    const harness = mount()
    try {
      await openModeMenu(harness)
      await selectMode("Full Access")

      expect(dialogTitles()).toEqual([])
      expect(configWrites).toEqual([])
      expect(sessionWrites).toEqual([
        { sessionID: "ses_prompt", controlProfile: "full_access", resolvePendingPermissions: true },
      ])
    } finally {
      harness.dispose()
    }
  })

  test("leaves a non-Full-Access mode unguarded", async () => {
    const harness = mount()
    try {
      await openModeMenu(harness)
      await selectMode("Autonomous")

      expect(dialogTitles()).toEqual([])
      expect(configWrites).toEqual([])
      expect(sessionWrites).toEqual([{ sessionID: "ses_prompt", controlProfile: "autonomous" }])
    } finally {
      harness.dispose()
    }
  })
})
