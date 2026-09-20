import { afterEach, describe, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { setupI18n } from "@lingui/core"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"
import type { Prompt } from "../../../src/context/prompt"

// The dedicated stop control exists only for the case the primary button cannot
// cover: a working session whose composer still holds a draft. The primary button
// stops an *empty* composer, while a draft makes it send instead, so the run would
// be unstoppable from the UI without this second control. This suite mounts the
// real `createPromptInputController` toolbar, so removing the `showsDedicatedStop`
// gate, the `Show` around the control, or the `stopRunAndCancel` wiring fails it.
await plugin({
  name: "prompt-stop-control-render",
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

let statusType: "idle" | "busy" = "idle"
let promptParts: Prompt = []
const abortCalls: Array<{ sessionID?: string }> = []
const loopCancelCalls: string[] = []

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
  },
  blueprint: {
    loop: {
      cancel: async (input: { id: string }) => {
        loopCancelCalls.push(input.id)
        return { data: {} }
      },
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
    statusFor: () => ({ type: statusType }),
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

const stopControl = () => buttonWithLabel(PI.stopRunControl.message)
const primaryControl = (label: string) => buttonWithLabel(label)

afterEach(() => {
  statusType = "idle"
  promptParts = []
  abortCalls.length = 0
  loopCancelCalls.length = 0
  document.body.innerHTML = ""
})

describe("dedicated stop control", () => {
  test("renders a stop control for a working session that holds a draft, and stops the run when clicked", async () => {
    statusType = "busy"
    promptParts = message("half-written prompt")
    const harness = mount()
    try {
      const control = stopControl()
      expect(control, "no dedicated stop control for a working session with a draft").toBeDefined()
      expect(control!.disabled).toBe(false)

      // The draft makes the primary button send rather than stop, so the
      // dedicated control is the only stop affordance in this state.
      expect(primaryControl(PI.sendMessage.message)).toBeDefined()

      control!.click()
      await settle()

      expect(abortCalls).toEqual([{ sessionID: "ses_prompt" }])
    } finally {
      harness.dispose()
    }
  })

  test("omits the stop control while the session is idle", async () => {
    statusType = "idle"
    promptParts = message("half-written prompt")
    const harness = mount()
    try {
      expect(stopControl()).toBeUndefined()
    } finally {
      harness.dispose()
    }
  })

  test("omits the stop control for an empty draft, which the primary button already stops", async () => {
    statusType = "busy"
    promptParts = []
    const harness = mount()
    try {
      expect(stopControl()).toBeUndefined()
      expect(
        primaryControl(PI.stopSession.message),
        "the primary button must own the empty-composer stop",
      ).toBeDefined()
    } finally {
      harness.dispose()
    }
  })
})
