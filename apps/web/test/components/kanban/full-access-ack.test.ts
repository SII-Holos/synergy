import solid from "babel-preset-solid"
import typescript from "@babel/preset-typescript"
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { setupI18n } from "@lingui/core"
import { createComponent, createSignal, onCleanup } from "solid-js"
import type { Accessor } from "solid-js"
import type { BoardPane } from "../../../src/components/kanban/model/pane-selection"
import { render } from "solid-js/web"

// The kanban board gates its pane control-profile selector through the real
// acknowledgement composable. This suite mounts the real board with one live
// pane and clicks the real composer chip, so deleting the `fullAccessAck.ensure`
// call in `updateProfileFor` fails the suite. Only the config boundary (the
// acknowledgement key and its write) and the session API are stubbed.
await plugin({
  name: "kanban-full-access-ack-dom",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => ({
      contents: (await transformAsync(await Bun.file(path).text(), {
        filename: path,
        parserOpts: { plugins: ["jsx"] },
        presets: [
          [solid, { generate: "dom" }],
          [typescript, { ignoreExtensions: true, onlyRemoveTypeImports: false }],
        ],
        sourceMaps: "inline",
      }))!.code!,
      loader: "js",
    }))
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
  },
})

// The pane transcript renderer is unrelated to the profile control and is the
// only path from the board into the shared message-part preload mock, so it is
// replaced while the composer chip and the board handler stay real.
mock.module("@ericsanchezok/synergy-ui/session-turn", () => ({
  SessionTurn: () => null,
  buildSessionTurnProjection: () => ({ roots: [], members: new Map() }),
}))

const i18n = setupI18n({ locale: "en", messages: { en: {} } })
const { I18nProvider } = await import("@lingui/solid")

const getAnimations = Element.prototype.getAnimations
Element.prototype.getAnimations = () => []
afterAll(() => {
  Element.prototype.getAnimations = getAnimations
})

let config: Record<string, unknown> = {}
const configWrites: unknown[] = []
const navigations: string[] = []
const surfaces = new Map<
  string,
  {
    tabs: Array<{ id: string; panelId: string }>
    active?: string
    opened?: boolean
    reveal?: { interacted?: boolean; consumed?: boolean }
  }
>()
const sessionWrites: Array<{ sessionID: string; controlProfile: string; resolvePendingPermissions?: boolean }> = []

mock.module("../../../src/context/global-sync", () => ({
  GlobalSyncProvider: (props: { children?: unknown }) => props.children,
  updatePlanBlueprintOfferState: () => {},
  refreshPlanBlueprintOfferFromLoadedParts: () => {},
  useGlobalSync: () => ({
    get data() {
      return { config, scope: [] }
    },
    sessionStatus: {},
    permissions: {},
    questions: {},
    cortex: [],
    peekScopeState: () => undefined,
    ensureScopeState: () => [{}, () => {}],
    retainScopeState: () => ({ state: [{}, () => {}], release() {} }),
    captureResourceRequest: () => 1,
    capturePartSnapshotRequest: () => 1,
    partSnapshotAction: () => {},
    beginContextProjection: () => 1,
    applyResourceResponse: () => false,
    setLatestContextMessage: () => {},
    touchMessageBucket: () => {},
    scopeReconnectVersion: () => 1,
    messageEvictionVersion: () => 1,
    invalidateResource: () => {},
  }),
}))

mock.module("../../../src/context/global-sdk", () => ({
  useGlobalSDK: () => ({
    url: "http://127.0.0.1:0",
    capabilities: { has: () => true },
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

// Every other scope/session call the board makes reaches this client; the
// acknowledgement suite only cares that the transition was not blocked.
mock.module("@ericsanchezok/synergy-sdk/client", () => ({
  createSynergyClient: () => ({
    session: {
      update: async (input: { sessionID: string; controlProfile: string; resolvePendingPermissions?: boolean }) => {
        sessionWrites.push(input)
        return { data: {} }
      },
      messagePage: async () => ({
        data: { items: [], referencedRoots: [], nextCursor: null, hasMore: false, total: 0 },
      }),
    },
  }),
}))

// The board reads its pinned/recent sources from the layout navigation store.
const navEntry = {
  id: "ses_board",
  scopeID: "home",
  scopeType: "home" as const,
  title: "Board session",
  category: "home" as const,
  lastActivityAt: 1,
  pinned: 0,
  archived: false,
  completionNotice: { unread: false, unreadCount: 0 },
}
const [recentEntries, setRecentEntries] = createSignal([navEntry])

mock.module("../../../src/context/layout", () => ({
  useLayout: () => ({
    surface: (key: string) => {
      const state = surfaces.get(key) ?? { tabs: [] }
      surfaces.set(key, state)
      return {
        tabs: () => state.tabs,
        reveal: () => state.reveal,
        setReveal: (value: { interacted?: boolean; consumed?: boolean }) => {
          state.reveal = value
        },
        setTabs: (tabs: Array<{ id: string; panelId: string }>) => {
          state.tabs = tabs
        },
        setActive: (active: string) => {
          state.active = active
        },
        open: () => {
          state.opened = true
        },
      }
    },
    nav: {
      recentEntries,
      rootNavEntries: () => [],
      projectNavEntries: () => [],
    },
  }),
}))

mock.module("@solidjs/router", () => ({ useNavigate: () => (path: string) => navigations.push(path) }))
mock.module("../../../src/components/workspace/mobile-header-close", () => ({
  useWorkspaceMobileHeaderClose: () => () => {},
}))
mock.module("@ericsanchezok/synergy-ui/toast", () => ({ showToast: () => {} }))
mock.module("../../../src/context/locale", () => ({
  useLocale: () => ({
    controller: { activeLocale: () => "en" },
    i18n,
    fmt: { relative: () => "now" },
  }),
}))

// Static imports of `packages/ui` TSX would compile before this file's Bun
// loader is registered, so the UI surfaces load dynamically after it.
const { KanbanPanel } = await import("../../../src/components/kanban")
const { KanbanGrid } = await import("../../../src/components/kanban/layout/grid")
const { KanbanFocus } = await import("../../../src/components/kanban/layout/focus")
const { DialogProvider } = await import("@ericsanchezok/synergy-ui/context/dialog")

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

type Harness = { root: HTMLDivElement; dispose: () => void }

function mount(): Harness {
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(
    () =>
      createComponent(I18nProvider, {
        i18n,
        get children() {
          return createComponent(DialogProvider, {
            get children() {
              return createComponent(KanbanPanel, {})
            },
          })
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

const permissionChip = (harness: Harness) =>
  [...harness.root.querySelectorAll<HTMLButtonElement>(".kanban-composer-chip")].find((node) =>
    node.getAttribute("aria-label")?.startsWith("Permission"),
  )

// The composer's control-profile menu only exists after its popover opens.
async function openProfileMenu(harness: Harness) {
  const chip = permissionChip(harness)
  expect(chip, "no kanban composer permission chip").toBeDefined()
  chip!.click()
  await settle()
}

async function selectProfile(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')].find(
    (node) => node.querySelector(".menu-field-item-label")?.textContent?.trim() === label,
  )
  expect(item, `no kanban control-profile option labelled ${label}`).toBeDefined()
  item!.click()
  await settle()
}

afterEach(() => {
  setRecentEntries([navEntry])
  config = {}
  navigations.length = 0
  surfaces.clear()
  configWrites.length = 0
  sessionWrites.length = 0
  localStorage.clear()
  document.body.innerHTML = ""
})

test("recent sessions can replace visible panes without losing retained drafts", async () => {
  const initial = Array.from({ length: 6 }, (_, index) => ({
    ...navEntry,
    id: `ses_board_${index}`,
    lastActivityAt: 100 - index,
  }))
  setRecentEntries(initial)
  const harness = mount()
  try {
    await settle()
    const pane = (id: string) =>
      [...harness.root.querySelectorAll<HTMLElement>("[data-pane-key]")].find(
        (node) => node.dataset.paneKey === `home\n${id}`,
      )
    const retained = pane("ses_board_0")?.querySelector<HTMLInputElement>("input")
    expect(retained).toBeInstanceOf(HTMLInputElement)
    retained!.value = "Keep my draft"
    retained!.dispatchEvent(new Event("input", { bubbles: true }))
    expect(() => setRecentEntries([{ ...navEntry, id: "ses_new", lastActivityAt: 200 }, ...initial])).not.toThrow()
    await settle()
    expect(harness.root.querySelectorAll('[data-component="kanban-pane"]')).toHaveLength(6)
    expect(pane("ses_board_5")).toBeUndefined()
    expect(pane("ses_board_0")?.querySelector("input")).toBe(retained)
    expect(retained!.value).toBe("Keep my draft")
  } finally {
    harness.dispose()
  }
})

for (const mode of ["grid", "focus"] as const) {
  test(`${mode} panes keep their owner available to cleanup when removed`, () => {
    const initial: BoardPane[] = ["a", "b", "c"].map((id) => ({
      key: id,
      scopeKey: "home",
      sessionID: id,
      kind: "live",
      pinned: false,
    }))
    const [panes, setPanes] = createSignal(initial)
    const closed: string[] = []
    const renderPane = (pane: Accessor<BoardPane>) => {
      onCleanup(() => closed.push(pane().sessionID))
      return document.createElement("div")
    }
    const root = document.createElement("div")
    const dispose = render(
      () =>
        createComponent(I18nProvider, {
          i18n,
          get children() {
            return mode === "grid"
              ? createComponent(KanbanGrid, {
                  get panes() {
                    return panes()
                  },
                  renderPane,
                  cols: 3,
                  rows: 1,
                  onReorder() {},
                })
              : createComponent(KanbanFocus, {
                  get panes() {
                    return panes()
                  },
                  renderPane,
                  railWidth: () => 300,
                  onRailResize() {},
                })
          },
        }),
      root,
    )
    try {
      expect(() => setPanes(initial.slice(0, 2))).not.toThrow()
      expect(closed).toContain("c")
      expect(() => setPanes([])).not.toThrow()
      expect(closed.toSorted()).toEqual(["a", "b", "c"])
    } finally {
      dispose()
    }
  })
}

describe("Full Access acknowledgement on the kanban pane selector", () => {
  test("prompts for the pane profile and does not change it when the risk is unrecorded", async () => {
    const harness = mount()
    try {
      await settle()
      await openProfileMenu(harness)
      await selectProfile("Full Access")

      expect(dialogTitles()).toEqual(["Enable Full Access?"])
      expect(configWrites).toEqual([])
      expect(sessionWrites).toEqual([])
    } finally {
      harness.dispose()
    }
  })

  test("records the acknowledgement then applies the pane profile on confirm", async () => {
    const harness = mount()
    try {
      await settle()
      await openProfileMenu(harness)
      await selectProfile("Full Access")

      confirmButton("Enable Full Access")!.click()
      await settle()

      expect(configWrites).toEqual([{ fullAccessAcknowledged: true }])
      expect(config.fullAccessAcknowledged).toBe(true)
      // Enabling Full Access also resolves permissions already waiting on the
      // pane's session, matching the session page's transition.
      expect(sessionWrites).toEqual([
        { sessionID: "ses_board", controlProfile: "full_access", resolvePendingPermissions: true },
      ])
    } finally {
      harness.dispose()
    }
  })

  test("writes nothing when the human dismisses the warning", async () => {
    const harness = mount()
    try {
      await settle()
      await openProfileMenu(harness)
      await selectProfile("Full Access")

      confirmButton("Keep current mode")!.click()
      await settle()

      expect(configWrites).toEqual([])
      expect(sessionWrites).toEqual([])
    } finally {
      harness.dispose()
    }
  })

  test("applies a later Full Access selection without prompting once the risk is recorded", async () => {
    config = { fullAccessAcknowledged: true }
    const harness = mount()
    try {
      await settle()
      await openProfileMenu(harness)
      await selectProfile("Full Access")

      expect(dialogTitles()).toEqual([])
      expect(configWrites).toEqual([])
      expect(sessionWrites).toEqual([
        { sessionID: "ses_board", controlProfile: "full_access", resolvePendingPermissions: true },
      ])
    } finally {
      harness.dispose()
    }
  })

  test("leaves a non-Full-Access selection unguarded", async () => {
    const harness = mount()
    try {
      await settle()
      await openProfileMenu(harness)
      await selectProfile("Autonomous")

      expect(dialogTitles()).toEqual([])
      expect(configWrites).toEqual([])
      expect(sessionWrites).toEqual([{ sessionID: "ses_board", controlProfile: "autonomous" }])
    } finally {
      harness.dispose()
    }
  })
})

test("a Kanban task opens its own trajectory without replacing another resource tab", async () => {
  surfaces.set("aG9tZQ/ses_board", { tabs: [{ id: "draft", panelId: "notes" }] })
  const harness = mount()
  try {
    await settle()
    const trigger = harness.root.querySelector<HTMLButtonElement>('button[aria-label="Execution trajectory"]')
    expect(trigger).not.toBeNull()
    trigger!.click()
    expect(navigations).toEqual(["/aG9tZQ/session/ses_board"])
    expect(surfaces.get("aG9tZQ/ses_board")).toMatchObject({
      opened: true,
      reveal: { interacted: true },
      tabs: [{ id: "draft", panelId: "notes" }, { panelId: "trajectory" }],
    })
    trigger!.click()
    expect(surfaces.get("aG9tZQ/ses_board")!.tabs).toHaveLength(2)
  } finally {
    harness.dispose()
  }
})
