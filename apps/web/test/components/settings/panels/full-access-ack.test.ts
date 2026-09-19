import { afterEach, describe, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { setupI18n } from "@lingui/core"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"
import type { SafetyStore } from "../../../../src/components/settings/types"

// The acknowledgement gate is wiring, not a predicate: this suite drives the
// real Settings control-profile surfaces through the real composable, so a
// missing `fullAccessAck.ensure` call in either handler fails the suite. Only
// the config client (the write boundary) and the config store it reads are
// stubbed.
await plugin({
  name: "full-access-ack-dom",
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
mock.module("@lingui/solid", () => ({ useLingui: () => ({ _: i18n._.bind(i18n) }) }))

// The persisted acknowledgement key and the domain update that records it are
// the true external boundary here; everything between the click and the write
// is production code. A successful write refreshes the config store the way the
// `config.updated` event does in the running app.
let config: Record<string, unknown> = {}
const updates: Array<{ domain: string; configDomainUpdateInput: { config: unknown } }> = []

mock.module("../../../../src/context/global-sync", () => ({
  useGlobalSync: () => ({
    get data() {
      return { config }
    },
  }),
}))

mock.module("../../../../src/context/global-sdk", () => ({
  useGlobalSDK: () => ({
    url: "http://127.0.0.1:0",
    client: {
      config: {
        domain: {
          update: async (input: { domain: string; configDomainUpdateInput: { config: unknown } }) => {
            updates.push(input)
            const patch = input.configDomainUpdateInput.config as { fullAccessAcknowledged?: boolean }
            if (patch.fullAccessAcknowledged === true) config = { ...config, fullAccessAcknowledged: true }
            return { data: { changedFields: ["fullAccessAcknowledged"] } }
          },
        },
      },
    },
  }),
}))

// Static imports of `packages/ui` TSX would compile before this file's Bun
// loader is registered, so the UI surfaces load dynamically after it.
const { ControlProfilePanel } = await import("../../../../src/components/settings/panels/SafetyPanels")
const { DialogProvider } = await import("@ericsanchezok/synergy-ui/context/dialog")

const settle = () => new Promise((resolve) => setTimeout(resolve, 15))

type Harness = {
  root: HTMLDivElement
  changes: Array<[string, string]>
  dispose: () => void
}

function mount(safety: Partial<SafetyStore>): Harness {
  const changes: Array<[string, string]> = []
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(
    () =>
      createComponent(DialogProvider, {
        get children() {
          return createComponent(ControlProfilePanel, {
            safety: safety as SafetyStore,
            controlProfiles: [],
            onSafetyChange: (key, value) => changes.push([key, value]),
          })
        },
      }),
    root,
  )
  return { root, changes, dispose }
}

const profileCard = (harness: Harness, label: string) => {
  const name = [...harness.root.querySelectorAll(".ds-profile-name")].find((node) => node.textContent === label)
  expect(name, `no control-profile card labelled ${label}`).toBeDefined()
  return name!.closest("button")!
}

const dialogTitles = () =>
  [...document.querySelectorAll('[data-slot="dialog-title"]')].map((node) => node.textContent?.trim())

const confirmButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-slot="dialog-actions"] button')].find(
    (node) => node.textContent?.trim() === label,
  )

const nonInteractiveScale = (harness: Harness) =>
  harness.root.querySelector<HTMLInputElement>(".settings-step-scale-slider")!

async function selectNonInteractive(harness: Harness, value: string) {
  const slider = nonInteractiveScale(harness)
  const index = [...harness.root.querySelectorAll(".settings-step-scale-ticks span")].findIndex(
    (node) => node.textContent?.trim() === value,
  )
  expect(index).toBeGreaterThanOrEqual(0)
  slider.value = String(index)
  slider.dispatchEvent(new Event("input", { bubbles: true }))
  await settle()
}

afterEach(() => {
  config = {}
  updates.length = 0
  document.querySelectorAll('[data-component="dialog"]').forEach((node) => node.remove())
})

describe("Full Access acknowledgement on the Settings control-profile grid", () => {
  test("prompts once when Full Access is selected and the risk is unrecorded", async () => {
    const harness = mount({ controlProfile: "guarded", nonInteractiveControlProfile: "autonomous" })
    try {
      profileCard(harness, "Full Access").click()
      await settle()

      expect(dialogTitles()).toEqual(["Enable Full Access?"])
      // The profile must not change underneath the warning.
      expect(harness.changes).toEqual([])
      expect(updates).toEqual([])
    } finally {
      harness.dispose()
    }
  })

  test("records the acknowledgement and applies the profile when the human confirms", async () => {
    const harness = mount({ controlProfile: "guarded", nonInteractiveControlProfile: "autonomous" })
    try {
      profileCard(harness, "Full Access").click()
      await settle()
      confirmButton("Enable Full Access")!.click()
      await settle()

      expect(updates).toEqual([
        { domain: "permissions", configDomainUpdateInput: { config: { fullAccessAcknowledged: true } } },
      ])
      expect(config.fullAccessAcknowledged).toBe(true)
      expect(harness.changes).toEqual([["controlProfile", "full_access"]])
    } finally {
      harness.dispose()
    }
  })

  test("keeps the current profile and writes nothing when the human dismisses the warning", async () => {
    const harness = mount({ controlProfile: "autonomous", nonInteractiveControlProfile: "autonomous" })
    try {
      profileCard(harness, "Full Access").click()
      await settle()
      confirmButton("Keep current mode")!.click()
      await settle()

      expect(updates).toEqual([])
      expect(harness.changes).toEqual([])
    } finally {
      harness.dispose()
    }
  })

  test("does not interrupt a later Full Access selection once the risk is recorded", async () => {
    const harness = mount({ controlProfile: "guarded", nonInteractiveControlProfile: "autonomous" })
    try {
      profileCard(harness, "Full Access").click()
      await settle()
      confirmButton("Enable Full Access")!.click()
      await settle()

      // Autonomous is not Full Access, so it applies immediately.
      profileCard(harness, "Autonomous").click()
      await settle()
      expect(harness.changes).toEqual([
        ["controlProfile", "full_access"],
        ["controlProfile", "autonomous"],
      ])

      profileCard(harness, "Full Access").click()
      await settle()

      expect(dialogTitles()).toEqual([])
      expect(harness.changes).toEqual([
        ["controlProfile", "full_access"],
        ["controlProfile", "autonomous"],
        ["controlProfile", "full_access"],
      ])
      expect(updates).toHaveLength(1)
    } finally {
      harness.dispose()
    }
  })

  test("does not re-prompt when the profile already in force is selected again", async () => {
    const harness = mount({ controlProfile: "full_access", nonInteractiveControlProfile: "autonomous" })
    try {
      profileCard(harness, "Full Access").click()
      await settle()

      expect(dialogTitles()).toEqual([])
      expect(updates).toEqual([])
    } finally {
      harness.dispose()
    }
  })
})

describe("Full Access acknowledgement on the non-interactive default selector", () => {
  test("prompts when Full Access becomes the non-interactive default", async () => {
    const harness = mount({ controlProfile: "guarded", nonInteractiveControlProfile: "autonomous" })
    try {
      await selectNonInteractive(harness, "Full Access")

      expect(dialogTitles()).toEqual(["Enable Full Access?"])
      expect(harness.changes).toEqual([])
    } finally {
      harness.dispose()
    }
  })

  test("records the acknowledgement and applies the non-interactive default on confirm", async () => {
    const harness = mount({ controlProfile: "guarded", nonInteractiveControlProfile: "autonomous" })
    try {
      await selectNonInteractive(harness, "Full Access")
      confirmButton("Enable Full Access")!.click()
      await settle()

      expect(updates).toEqual([
        { domain: "permissions", configDomainUpdateInput: { config: { fullAccessAcknowledged: true } } },
      ])
      expect(harness.changes).toEqual([["nonInteractiveControlProfile", "full_access"]])
    } finally {
      harness.dispose()
    }
  })

  test("does not prompt when the non-interactive default is already Full Access", async () => {
    const harness = mount({ controlProfile: "guarded", nonInteractiveControlProfile: "full_access" })
    try {
      await selectNonInteractive(harness, "Full Access")

      expect(dialogTitles()).toEqual([])
      expect(updates).toEqual([])
    } finally {
      harness.dispose()
    }
  })

  test("leaves the autonomous default unguarded", async () => {
    const harness = mount({ controlProfile: "guarded", nonInteractiveControlProfile: "full_access" })
    try {
      await selectNonInteractive(harness, "Autonomous")

      expect(dialogTitles()).toEqual([])
      expect(harness.changes).toEqual([["nonInteractiveControlProfile", "autonomous"]])
    } finally {
      harness.dispose()
    }
  })
})
