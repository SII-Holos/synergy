import { afterEach, describe, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { setupI18n } from "@lingui/core"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"
import type { Prompt } from "../../../src/context/prompt"

// The composer has exactly one primary control whose meaning follows session
// state: Send with a draft, Pause while running, Continue while paused, and
// Disabled when idle with nothing armed. This suite mounts the real
// `createPromptInputController` toolbar, so a second control creeping back onto
// the row, or a Pause rendered for a paused session, fails it.
await plugin({
  name: "prompt-single-control-render",
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

type TestStatusType = "idle" | "busy" | "pause" | "paused"
let statusType: TestStatusType = "idle"
const statusForType = () =>
  statusType === "pause"
    ? { type: "busy" as const }
    : statusType === "paused"
      ? { type: "paused" as const, reason: "aborted" as const, since: 1 }
      : { type: statusType }
let promptParts: Prompt = []
const abortCalls: Array<{ sessionID?: string }> = []
const continueCalls: Array<{ sessionID?: string }> = []

const message = (content: string): Prompt => [{ type: "text", content, start: 0, end: content.length }]

mock.module("../../../src/context/global-sync", () => ({
  GlobalSyncProvider: (props: { children?: unknown }) => props.children,
  updatePlanBlueprintOfferState: () => {},
  refreshPlanBlueprintOfferFromLoadedParts: () => {},
  useGlobalSync: () => ({
    get data() {
      return { config: {} }
    },
    reconnectVersion: () => 1,
  }),
}))

const sdkClient = () => ({
  session: {
    abort: async (input: { sessionID?: string }) => {
      abortCalls.push(input)
      return { data: {} }
    },
    continue: async (input: { sessionID?: string }) => {
      continueCalls.push(input)
      return { data: { handled: true } }
    },
    abandon: async () => ({ data: { repaired: false, paused: false, abandoned: false } }),
  },
  blueprint: {
    loop: {
      cancel: async () => ({ data: {} }),
    },
  },
})

mock.module("../../../src/context/global-sdk", () => ({
  useGlobalSDK: () => ({
    url: "http://127.0.0.1:0",
    client: { config: { domain: { update: async () => ({ data: { changedFields: [] } }) } } },
  }),
}))

mock.module("@ericsanchezok/synergy-sdk/client", () => ({
  createSynergyClient: () => ({
    ...sdkClient(),
    session: {
      ...sdkClient().session,
      update: async () => ({ data: {} }),
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
    client: sdkClient(),
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
    agent: { list: () => [], current: () => ({ name: "synergy" }), set: () => {}, ready: () => true },
    model: {
      all: () => [],
      current: () => undefined,
      set: () => {},
      variant: { list: () => [], current: () => undefined, set: () => {}, ready: () => true },
    },
  }),
}))

mock.module("../../../src/context/file", () => ({
  useFile: () => ({ searchFilesAndDirectories: async () => [], view: { selectedLines: () => null } }),
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
    current: () => promptParts,
    dirty: () => promptParts.length > 0,
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
    statusFor: () => statusForType(),
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

// Static imports of `packages/ui` TSX compile before this file's Bun loader is
// registered, so the UI surfaces load dynamically after it.
const { createPromptInputController } = await import("../../../src/components/prompt-input/prompt-controller")
const { DialogProvider } = await import("@ericsanchezok/synergy-ui/context/dialog")
const { PI } = await import("../../../src/components/prompt-input/prompt-input-i18n")

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

const buttonWithLabel = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.getAttribute("aria-label") === label)

const primaryControl = (label: string) => buttonWithLabel(label)
const controlCount = () =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].filter((node) =>
    node.classList.contains("prompt-input-submit"),
  ).length

afterEach(() => {
  statusType = "idle"
  promptParts = []
  abortCalls.length = 0
  continueCalls.length = 0
  document.body.innerHTML = ""
})

describe("single composer control", () => {
  test("renders exactly one primary control", () => {
    statusType = "idle"
    const harness = mount()
    try {
      expect(controlCount()).toBe(1)
    } finally {
      harness.dispose()
    }
  })

  test("sends while a draft is present, even on a paused session", () => {
    statusType = "paused"
    promptParts = message("half-written prompt")
    const harness = mount()
    try {
      expect(primaryControl(PI.sendMessage.message)).toBeDefined()
      // A paused session with a draft offers Send, never a second stop control.
      expect(primaryControl(PI.pauseControl.message)).toBeUndefined()
    } finally {
      harness.dispose()
    }
  })

  test("pauses a running session with an empty draft", async () => {
    statusType = "pause"
    promptParts = []
    const harness = mount()
    try {
      const control = primaryControl(PI.pauseControl.message)
      expect(control, "no pause control for a running session").toBeDefined()
      expect(control!.disabled).toBe(false)

      control!.click()
      await settle()

      expect(abortCalls).toEqual([{ sessionID: "ses_prompt" }])
    } finally {
      harness.dispose()
    }
  })

  test("continues a paused session instead of offering a stop control", async () => {
    statusType = "paused"
    promptParts = []
    const harness = mount()
    try {
      const control = primaryControl(PI.continueControl.message)
      expect(control, "no continue control for a paused session").toBeDefined()
      // The regression this guards: a paused session must never render "Stop".
      expect(primaryControl(PI.pauseControl.message)).toBeUndefined()

      control!.click()
      await settle()

      expect(continueCalls).toEqual([{ sessionID: "ses_prompt" }])
      expect(abortCalls).toEqual([])
    } finally {
      harness.dispose()
    }
  })

  test("disables the control when the session is idle and nothing is armed", () => {
    statusType = "idle"
    promptParts = []
    const harness = mount()
    try {
      const control = primaryControl(PI.sendMessage.message)
      expect(control).toBeDefined()
      expect(control!.disabled).toBe(true)
    } finally {
      harness.dispose()
    }
  })
})
