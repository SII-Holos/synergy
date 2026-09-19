import { afterEach, describe, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { setupI18n } from "@lingui/core"
import { createComponent } from "solid-js"
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

// The pane transcript renderer is unrelated to the profile control and is the
// only path from the board into the shared message-part preload mock, so it is
// replaced while the composer chip and the board handler stay real.
mock.module("@ericsanchezok/synergy-ui/session-turn", () => ({
  SessionTurn: () => null,
  buildSessionTurnProjection: () => ({ roots: [], members: new Map() }),
}))

const i18n = setupI18n({ locale: "en", messages: { en: {} } })
mock.module("@lingui/solid", () => ({ useLingui: () => ({ _: i18n._.bind(i18n) }) }))

let config: Record<string, unknown> = {}
const configWrites: unknown[] = []
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

mock.module("../../../src/context/layout", () => ({
  useLayout: () => ({
    nav: {
      recentEntries: () => [navEntry],
      rootNavEntries: () => [],
      projectNavEntries: () => [],
    },
  }),
}))

mock.module("@solidjs/router", () => ({ useNavigate: () => () => {} }))
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
const { DialogProvider } = await import("@ericsanchezok/synergy-ui/context/dialog")

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

type Harness = { root: HTMLDivElement; dispose: () => void }

function mount(): Harness {
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(
    () =>
      createComponent(DialogProvider, {
        get children() {
          return createComponent(KanbanPanel, {})
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
    node.getAttribute("title")?.includes("Permission"),
  )

// The composer's control-profile menu only exists after its popover opens.
async function openProfileMenu(harness: Harness) {
  const chip = permissionChip(harness)
  expect(chip, "no kanban composer permission chip").toBeDefined()
  chip!.click()
  await settle()
}

async function selectProfile(label: string) {
  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="listbox"] .kanban-composer-item')].find(
    (node) => node.textContent?.trim() === label,
  )
  expect(item, `no kanban control-profile option labelled ${label}`).toBeDefined()
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
