import { TEST_AGENT_NAME } from "@ericsanchezok/synergy-testing/agent-fixture"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { setupI18n } from "@lingui/core"
import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { Prompt } from "../../../src/context/prompt"
import type { LoopTerminal } from "../../../src/components/prompt-input/loop-status"

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
const [statusType, setStatusType] = createSignal<TestStatusType>("idle")
const [sessionID, setSessionID] = createSignal("ses_prompt")
const statusForType = () =>
  statusType() === "pause"
    ? { type: "busy" as const }
    : statusType() === "paused"
      ? { type: "paused" as const, reason: "aborted" as const, since: 1 }
      : { type: statusType() as "idle" | "busy" }
const [promptParts, setPromptParts] = createSignal<Prompt>([])
const [transitionError, setTransitionError] = createSignal(false)
let draftResets = 0
const toastTitles: string[] = []
let abandonFails = false
const abortCalls: Array<{ sessionID?: string }> = []
const continueCalls: Array<{ sessionID?: string }> = []
const abandonCalls: Array<{ sessionID?: string }> = []
let abandonBarrier: Promise<void> | undefined
const installedFeatures = ["blueprint", "lattice", "light-loop", "boss", "note", "workbench"]
const [selection, setSelection] = createSignal<{ features: string[] } | undefined>({ features: installedFeatures })
const [sessionBinding, setSessionBinding] = createSignal<{ loopID: string; source?: "user" | "lattice" | "plugin" }>()
const [sessionWorkflow, setSessionWorkflow] =
  createSignal<import("@ericsanchezok/synergy-sdk/client").Session["workflow"]>()
const loopGetCalls: string[] = []
const loopGetSignals: AbortSignal[] = []
const lightCancelCalls: string[] = []
const lightUpdateCalls: Array<{ id: string; lightloopUpdateInput: { instructions: string } }> = []
let lightUpdateBarrier: Promise<void> | undefined
let loopCancelFails = false
let loopCancelBarrier: Promise<void> | undefined
let loopReply: Promise<unknown> | undefined
let lightTerminalReply: LoopTerminal | undefined

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
  workflow: {
    session: {
      cancelLightloop: async ({ id }: { id: string }) => {
        lightCancelCalls.push(id)
        await loopCancelBarrier
        if (loopCancelFails) throw new Error("Cancellation unavailable")
        setSessionWorkflow(undefined)
        return { data: {} }
      },
      updateLightloop: async (input: { id: string; lightloopUpdateInput: { instructions: string } }) => {
        lightUpdateCalls.push(input)
        await lightUpdateBarrier
        return { data: {} }
      },
      getLightloopTerminal: async () => ({
        data: lightTerminalReply ?? { status: "cancelled", instructions: "Verify edge cases", createdAt: 1 },
      }),
    },
  },
  session: {
    abort: async (input: { sessionID?: string }) => {
      abortCalls.push(input)
      return { data: {} }
    },
    continue: async (input: { sessionID?: string }) => {
      continueCalls.push(input)
      return { data: { handled: true } }
    },
    abandon: async (input: { sessionID?: string }) => {
      abandonCalls.push(input)
      await abandonBarrier
      if (abandonFails) return { error: { name: "SessionAbandonError", data: { message: "Cancellation unavailable" } } }
      return { data: { repaired: false, paused: false, abandoned: false } }
    },
  },
  blueprint: {
    loop: {
      get: async (input: { id: string }, options?: { signal?: AbortSignal }) => {
        loopGetCalls.push(input.id)
        if (options?.signal) loopGetSignals.push(options.signal)
        return { data: await loopReply }
      },
      cancel: async () => ({ data: {} }),
    },
  },
})

mock.module("../../../src/context/global-sdk", () => ({
  useGlobalSDK: () => ({
    capabilities: { current: selection, has: (id: string) => selection()?.features.includes(id) ?? false },
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
  useParams: () => ({
    dir: "home",
    get id() {
      return sessionID()
    },
  }),
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

mock.module("../../../src/context/server", () => ({
  useServer: () => ({ url: "http://127.0.0.1:0" }),
  serverDisplayName: (url: string) => url,
  normalizeServerUrl: (url: string) => url,
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
    session: {
      get: () => ({
        id: "ses_prompt",
        blueprint: sessionBinding(),
        workflow: sessionWorkflow(),
        controlProfile: undefined,
        scope: { id: "scope_fixture" },
      }),
    },
    planBlueprintOffer: { equip: () => {}, dismiss: () => {}, mute: () => {} },
  }),
}))

mock.module("../../../src/components/dialog/dialog-select-model", () => ({ ModelSelectorPopover: () => null }))

mock.module("../../../src/context/local", () => ({
  useLocal: () => ({
    agent: { list: () => [], current: () => ({ name: TEST_AGENT_NAME }), set: () => {}, ready: () => true },
    model: {
      all: () => [],
      current: () => undefined,
      set: () => {},
      variant: { list: () => [], current: () => undefined, set: () => {}, ready: () => true },
    },
  }),
}))

mock.module("../../../src/context/file", () => ({
  useProjectFiles: () => ({ roots: () => [], search: async () => [], open: async () => {} }),
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
    current: promptParts,
    dirty: () => promptParts().length > 0,
    cursor: () => 0,
    set: (value: Prompt) => setPromptParts(value),
    reset: () => {
      draftResets++
      setPromptParts([])
    },
    resetDraft: () => {
      draftResets++
      setPromptParts([])
    },
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
  draftTransitionKey: () => "draft:fixture",
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
mock.module("@ericsanchezok/synergy-ui/toast", () => ({
  showToast: (input: { title: string }) => toastTitles.push(input.title),
}))

// Static imports of `packages/ui` TSX compile before this file's Bun loader is
// registered, so the UI surfaces load dynamically after it.
const { createPromptInputController } = await import("../../../src/components/prompt-input/prompt-controller")
const { DialogProvider } = await import("@ericsanchezok/synergy-ui/context/dialog")
const { PI } = await import("../../../src/components/prompt-input/prompt-input-i18n")
const { composerPresentation } = await import("../../../src/components/prompt-input/composer-presentation")

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

type Harness = { root: HTMLDivElement; dispose: () => void }

function Toolbar() {
  const controller = createPromptInputController({
    get readOnly() {
      return transitionError()
    },
    get sessionTransitionError() {
      return transitionError()
    },
  })
  return [
    composerPresentation(controller.input)?.status?.(),
    controller.input.render("context"),
    controller.input.render("toolbar"),
  ]
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
  setStatusType("idle")
  setPromptParts([])
  setTransitionError(false)
  abortCalls.length = 0
  continueCalls.length = 0
  abandonCalls.length = 0
  abandonBarrier = undefined
  abandonFails = false
  draftResets = 0
  toastTitles.length = 0
  setSessionBinding(undefined)
  setSessionWorkflow(undefined)
  setSelection({ features: installedFeatures })
  loopGetCalls.length = 0
  loopGetSignals.length = 0
  loopReply = undefined
  lightTerminalReply = undefined
  setSessionID("ses_prompt")
  lightCancelCalls.length = 0
  lightUpdateCalls.length = 0
  lightUpdateBarrier = undefined
  loopCancelFails = false
  loopCancelBarrier = undefined
  document.body.innerHTML = ""
})

describe("single composer control", () => {
  test.each(["lattice", "plugin"] as const)(
    "a removed Blueprint source cannot issue its first GET or lock the ordinary composer (%s)",
    async (source) => {
      const baseFeatures = ["blueprint", "note", "plugin-host"]
      setSelection({ features: baseFeatures })
      setSessionBinding({ loopID: "source-loop", source })
      setPromptParts(message("Keep my ordinary draft"))
      const harness = mount()
      try {
        await settle()
        expect(loopGetCalls).toEqual([])
        expect(primaryControl(PI.sendMessage.message)?.disabled).toBe(false)
        primaryControl(PI.sendMessage.message)!.dispatchEvent(new FocusEvent("focus"))
        await settle()
        expect(document.querySelector('[role="tooltip"]')?.textContent).not.toContain(PI.abandonHint.message)
        const pending = Promise.withResolvers<unknown>()
        loopReply = pending.promise
        setSelection({ features: [...baseFeatures, "lattice", "plugin-blueprint"] })
        await settle()
        expect(loopGetCalls).toEqual(["source-loop"])
        expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(PI.abandonHint.message)
        setSelection({ features: baseFeatures })
        pending.resolve({ id: "source-loop", source, status: "running" })
        await settle()
        expect(loopGetCalls).toEqual(["source-loop"])
        expect(loopGetSignals[0]?.aborted).toBe(true)
        expect(primaryControl(PI.sendMessage.message)?.disabled).toBe(false)
        expect(document.querySelector('[role="tooltip"]')?.textContent).not.toContain(PI.abandonHint.message)
        expect(promptParts()).toEqual(message("Keep my ordinary draft"))
      } finally {
        harness.dispose()
      }
    },
  )
  test("a recovery reason appears once and describes the disabled send action", async () => {
    setTransitionError(true)
    setPromptParts(message("Keep after recovery"))
    const harness = mount()
    try {
      const control = document.querySelector<HTMLButtonElement>(".prompt-input-submit")!
      expect(control.disabled).toBe(true)
      expect(control.getAttribute("aria-label")).toBe(PI.sendMessage.message)
      const description = document.getElementById(control.getAttribute("aria-describedby")!)
      expect(description?.textContent).toBe(PI.recoveryRequired.message)
      control.dispatchEvent(new FocusEvent("focus"))
      await settle()
      expect(document.querySelector('[role="tooltip"]')).toBeNull()
      expect(document.body.textContent?.split(PI.recoveryRequired.message)).toHaveLength(2)
      setTransitionError(false)
      await settle()
      expect(control.disabled).toBe(false)
      expect(control.hasAttribute("aria-describedby")).toBe(false)
    } finally {
      harness.dispose()
    }
  })

  test("a queued message tooltip presents the action only once", async () => {
    setStatusType("busy")
    setPromptParts(message("Queue this"))
    const harness = mount()
    try {
      const control = primaryControl(PI.queueMessage.message)!
      control.dispatchEvent(new FocusEvent("focus"))
      await settle()
      const tooltip = document.querySelector('[role="tooltip"]')
      expect(tooltip).not.toBeNull()
      expect(tooltip?.textContent?.split(PI.queueMessage.message)).toHaveLength(2)
    } finally {
      harness.dispose()
    }
  })

  test("a failed abandonment reports failure and keeps the paused draft available", async () => {
    setStatusType("paused")
    setPromptParts(message("Keep after failure"))
    abandonFails = true
    const harness = mount()
    try {
      const control = document.querySelector<HTMLButtonElement>(".prompt-input-submit")!
      control.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 3100))
      control.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
      const release = new MouseEvent("click", { bubbles: true, cancelable: true })
      control.dispatchEvent(release)
      expect(release.defaultPrevented).toBe(true)
      expect(abandonCalls).toHaveLength(1)
      expect(toastTitles).toEqual([PI.abandonFailed.message])
      expect(promptParts()).toEqual(message("Keep after failure"))
      expect(draftResets).toBe(0)
      expect(control.disabled).toBe(false)
      expect(control.getAttribute("aria-label")).toBe(PI.sendAndContinue.message)
    } finally {
      harness.dispose()
    }
  })
  test("a new pointer gesture permits sending after release produced no click while abandonment was pending", async () => {
    setStatusType("paused")
    setPromptParts(message("Send this later"))
    const pending = Promise.withResolvers<void>()
    abandonBarrier = pending.promise
    const harness = mount()
    try {
      const control = document.querySelector<HTMLButtonElement>(".prompt-input-submit")!
      control.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 3100))
      expect(control.disabled).toBe(true)
      control.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
      setStatusType("idle")
      pending.resolve()
      await settle()
      expect(control.disabled).toBe(false)
      control.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }))
      control.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
      const next = new MouseEvent("click", { bubbles: true, cancelable: true })
      control.dispatchEvent(next)
      expect(next.defaultPrevented).toBe(false)
      expect(abandonCalls).toHaveLength(1)
    } finally {
      pending.resolve()
      harness.dispose()
    }
  })
  test.each([false, true])(
    "releasing a partial hold cancels without continuing or sending (draft=%s)",
    async (draft) => {
      setStatusType("paused")
      setPromptParts(draft ? message("Adjust direction") : [])
      const harness = mount()
      try {
        const control = document.querySelector<HTMLButtonElement>(".prompt-input-submit")!
        control.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }))
        await new Promise((resolve) => setTimeout(resolve, 350))
        control.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
        const release = new MouseEvent("click", { bubbles: true, cancelable: true })
        control.dispatchEvent(release)
        await settle()
        expect(release.defaultPrevented).toBe(true)
        expect(continueCalls).toEqual([])
        expect(abandonCalls).toEqual([])
        expect(promptParts()).toEqual(draft ? message("Adjust direction") : [])
      } finally {
        harness.dispose()
      }
    },
  )
  test("a completed hold consumes the release click and preserves the draft", async () => {
    setStatusType("paused")
    setPromptParts(message("Keep this draft"))
    const harness = mount()
    try {
      const control = document.querySelector<HTMLButtonElement>(".prompt-input-submit")!
      control.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 5, clientY: 5, bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 3100))
      control.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true }))
      const release = new MouseEvent("click", { bubbles: true, cancelable: true })
      control.dispatchEvent(release)
      expect(release.defaultPrevented).toBe(true)
      expect(abandonCalls).toEqual([{ sessionID: "ses_prompt" }])
      expect(promptParts()).toEqual(message("Keep this draft"))
      expect(draftResets).toBe(0)
      const next = new MouseEvent("click", { bubbles: true, cancelable: true })
      control.dispatchEvent(next)
      expect(next.defaultPrevented).toBe(false)
    } finally {
      harness.dispose()
    }
  })
  test("renders exactly one primary control", () => {
    setStatusType("idle")
    const harness = mount()
    try {
      expect(controlCount()).toBe(1)
    } finally {
      harness.dispose()
    }
  })

  test("sends while a draft is present, even on a paused session", () => {
    setStatusType("paused")
    setPromptParts(message("half-written prompt"))
    const harness = mount()
    try {
      expect(primaryControl(PI.sendAndContinue.message)).toBeDefined()
      // A paused session with a draft offers Send, never a second stop control.
      expect(primaryControl(PI.pauseControl.message)).toBeUndefined()
    } finally {
      harness.dispose()
    }
  })

  test("pauses a running session with an empty draft", async () => {
    setStatusType("pause")
    setPromptParts([])
    const harness = mount()
    try {
      const control = primaryControl(PI.pauseControl.message)
      expect(control, "no pause control for a running session").toBeDefined()
      expect(control!.disabled).toBe(false)

      control!.dispatchEvent(new FocusEvent("focus"))
      await settle()
      const tooltip = document.querySelector('[role="tooltip"]')!
      expect(tooltip.textContent).toContain(PI.pauseControl.message)
      expect(tooltip.textContent).toContain(PI.pauseControlHint.message)

      control!.click()
      await settle()

      expect(abortCalls).toEqual([{ sessionID: "ses_prompt" }])
    } finally {
      harness.dispose()
    }
  })

  test("continues a paused session instead of offering a stop control", async () => {
    setStatusType("paused")
    setPromptParts([])
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
    setStatusType("idle")
    setPromptParts([])
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

describe("Loop status entry", () => {
  test("the edit icon opens the goal directly and saves only to its captured owner", async () => {
    setSessionWorkflow({ kind: "lightloop", instructions: "Verify edge cases" })
    setStatusType("paused")
    const harness = mount()
    try {
      harness.root.querySelector<HTMLButtonElement>('[aria-label="Edit goal"]')!.click()
      await settle()
      const textarea = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!
      textarea.value = "Include cancellation"
      textarea.dispatchEvent(new Event("input", { bubbles: true }))
      const save = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
        (button) => button.textContent === PI.lightLoopTaskSave.message,
      )!
      expect(save.disabled).toBe(false)
      save.click()
      await settle()
      expect(lightUpdateCalls).toEqual([
        expect.objectContaining({ id: "ses_prompt", lightloopUpdateInput: { instructions: "Include cancellation" } }),
      ])
      harness.root.querySelector<HTMLButtonElement>('[aria-label="Edit goal"]')!.click()
      await settle()
      setSessionID("ses_other")
      await settle()
      expect(document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')?.readOnly).toBe(true)
      expect(
        [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].some(
          (button) => button.textContent === PI.lightLoopTaskSave.message,
        ),
      ).toBe(false)
      expect(lightUpdateCalls).toHaveLength(1)
    } finally {
      harness.dispose()
    }
  })
  test("a late goal save cannot close a reopened editor or erase its new draft", async () => {
    setSessionWorkflow({ kind: "lightloop", instructions: "Verify edge cases" })
    setStatusType("paused")
    const pending = Promise.withResolvers<void>()
    lightUpdateBarrier = pending.promise
    const harness = mount()
    const button = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
        (node) => node.textContent === label,
      )!
    try {
      harness.root.querySelector<HTMLButtonElement>('[aria-label="Edit goal"]')!.click()
      await settle()
      const original = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!
      original.value = "First revision"
      original.dispatchEvent(new Event("input", { bubbles: true }))
      button(PI.lightLoopTaskSave.message).click()
      button(PI.lightLoopTaskCancel.message).click()
      harness.root.querySelector<HTMLButtonElement>('[aria-label="Edit goal"]')!.click()
      await settle()
      const current = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!
      current.value = "Keep this new draft"
      current.dispatchEvent(new Event("input", { bubbles: true }))
      pending.resolve()
      await settle()
      expect(document.querySelector('[role="dialog"] textarea')).toBe(current)
      expect(current.value).toBe("Keep this new draft")
      expect(toastTitles).toEqual([])
    } finally {
      pending.resolve()
      harness.dispose()
    }
  })
  test("Blueprint cancellation uses the existing whole-loop exit and never clears a failed request", async () => {
    setSessionBinding({ loopID: "loop-cancel", source: "user" })
    loopReply = Promise.resolve({
      id: "loop-cancel",
      source: "user",
      sessionID: "ses_prompt",
      scopeID: "scope_fixture",
      title: "Check the result",
      noteID: "note",
      status: "auditing",
      time: { created: 1, updated: 1 },
    })
    const harness = mount()
    try {
      await settle()
      const cancel = harness.root.querySelector<HTMLButtonElement>('[aria-label="Cancel loop"]')!
      abandonFails = true
      cancel.click()
      await settle()
      expect(abandonCalls).toEqual([{ sessionID: "ses_prompt" }])
      expect(harness.root.textContent).toContain("In review")
      expect(cancel.disabled).toBe(false)
      expect(toastTitles.length).toBeGreaterThan(0)
    } finally {
      harness.dispose()
    }
  })
  test("Light Loop has direct edit and cancel actions; failed cancellation retains the goal", async () => {
    setSessionWorkflow({ kind: "lightloop", instructions: "Verify edge cases" })
    setStatusType("paused")
    const harness = mount()
    try {
      await settle()
      const entry = harness.root.querySelector('[data-component="loop-status-entry"]')
      expect(entry).not.toBeNull()
      const edit = entry!.querySelector<HTMLButtonElement>('[aria-label="Edit goal"]')
      expect(edit).not.toBeNull()
      edit!.click()
      await settle()
      expect(document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')?.value).toBe("Verify edge cases")
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      await settle()
      const cancel = entry!.querySelector<HTMLButtonElement>('[aria-label="Cancel loop"]')!
      loopCancelFails = true
      cancel.click()
      await settle()
      expect(lightCancelCalls).toEqual(["ses_prompt"])
      expect(entry!.textContent).toContain("Verify edge cases")
      expect(toastTitles.length).toBeGreaterThan(0)
      loopCancelFails = false
      const pending = Promise.withResolvers<void>()
      loopCancelBarrier = pending.promise
      cancel.click()
      cancel.click()
      await settle()
      expect(lightCancelCalls).toHaveLength(2)
      expect(cancel.disabled).toBe(true)
      pending.resolve()
      await settle()
      expect(harness.root.textContent).toContain("Cancelled")
    } finally {
      harness.dispose()
    }
  })
  test("bound Blueprint title stays visible before execution", async () => {
    setSessionBinding({ loopID: "loop-visible", source: "user" })
    loopReply = Promise.resolve({
      id: "loop-visible",
      source: "user",
      sessionID: "ses_prompt",
      scopeID: "scope_fixture",
      title: "Verify the deliverable",
      noteID: "note",
      status: "armed",
      time: { created: 1, updated: 1 },
    })
    const harness = mount()
    try {
      await settle()
      expect(harness.root.querySelector('[data-component="loop-status-entry"]')?.getAttribute("aria-label")).toBe(
        "BlueprintLoop",
      )
      expect(harness.root.textContent).toContain("Verify the deliverable")
      expect(harness.root.textContent).toContain("Bound")
    } finally {
      harness.dispose()
    }
  })
  test.each([
    ["idle", "Bound"],
    ["busy", "Running"],
    ["paused", "Paused"],
  ] as const)("Light Loop exposes the active session stage %s", async (status, label) => {
    setSessionWorkflow({ kind: "lightloop", instructions: "Verify edge cases" })
    setStatusType(status)
    const harness = mount()
    try {
      await settle()
      const entry = harness.root.querySelector('[data-component="loop-status-entry"]')
      expect(entry?.getAttribute("aria-label")).toBe("Light Loop")
      expect(entry?.textContent).toContain(label)
      expect(entry?.querySelector("button")?.disabled).toBe(false)
    } finally {
      harness.dispose()
    }
  })
  test.each([
    ["completed", undefined],
    ["failed", "Failed"],
    ["cancelled", "Cancelled"],
    ["timed_out", "Time limit reached"],
    ["iteration_exhausted", "Review limit reached"],
  ] as const)("Light Loop settles from the terminal record (%s)", async (status, label) => {
    setSessionWorkflow({ kind: "lightloop", instructions: "Verify edge cases" })
    setStatusType("busy")
    const harness = mount()
    try {
      await settle()
      expect(harness.root.querySelector('[data-component="loop-status-entry"]')?.textContent).toContain("Running")
      lightTerminalReply = {
        status,
        instructions: "Verify edge cases",
        error: "Execution could not finish",
        createdAt: 2,
      }
      setSessionWorkflow(undefined)
      setStatusType("idle")
      await settle()
      const entry = harness.root.querySelector('[data-component="loop-status-entry"]')
      if (label) {
        expect(entry?.textContent).toContain(label)
        expect(entry?.textContent).toContain("Verify edge cases")
        expect(entry?.querySelector('[aria-label="Edit goal"]')).toBeNull()
      } else expect(entry).toBeNull()
    } finally {
      harness.dispose()
    }
  })
})
