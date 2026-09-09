import { expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"
import { setupI18n } from "@lingui/core"
import type { GeneralStore } from "../../../../src/components/settings/types"

await plugin({
  name: "storage-panel-dom",
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
const calls: Array<{ action: string; apply: boolean }> = []
const notices: Array<{ type: string; title: string }> = []
let pending: { onConfirm(): Promise<void> } | undefined
let dryError = false
let empty = false
mock.module("../../../../src/components/dialog/confirm-dialog", () => ({
  useConfirm: () => ({
    show(value: { onConfirm(): Promise<void> }) {
      pending = value
    },
  }),
}))
mock.module("@ericsanchezok/synergy-ui/toast", () => ({
  showToast: (value: { type: string; title: string }) => notices.push(value),
}))
const usage = {
  scopeID: "scope_fixture",
  owners: { shared: 1, legacy: 2, deleted: 1 },
  shared: { allocatedBytes: 2048 },
  legacy: { allocatedBytes: 1024 },
  indexes: { allocatedBytes: 512 },
  retainedLegacy: { unowned: 1, reclaimed: 0, sharedBaselines: 0, unregistered: 0 },
}
function reply(action: string, apply: boolean) {
  calls.push({ action, apply })
  if (dryError) return { error: { message: "fixture integrity unavailable" } }
  const report =
    action === "clean"
      ? { candidates: [{ bytes: 1024 }], removed: apply ? 1 : 0, bytes: 1024, errors: [] }
      : action === "migrate"
        ? { results: [{ status: apply ? "migrated" : "pending" }] }
        : { before: { bytes: 2048 }, after: { bytes: 1024 }, applied: apply }
  return { data: { results: empty ? [] : [report], failures: [] } }
}
mock.module("../../../../src/context/global-sdk", () => ({
  useGlobalSDK: () => ({
    client: {
      scope: { list: async () => ({ data: [{ id: "scope_fixture", name: "Research workspace" }] }) },
      storage: {
        snapshot: {
          usage: async () => ({ data: [usage] }),
          clean: async (input: { storageSnapshotCleanInput: { apply: boolean } }) =>
            reply("clean", input.storageSnapshotCleanInput.apply),
          migrate: async (input: { storageSnapshotMigrateInput: { apply: boolean } }) =>
            reply("migrate", input.storageSnapshotMigrateInput.apply),
          compact: async (input: { storageSnapshotCompactInput: { apply: boolean } }) =>
            reply("compact", input.storageSnapshotCompactInput.apply),
        },
      },
    },
  }),
}))
const { StoragePanel } = await import("../../../../src/components/settings/panels/StoragePanel")
const general = { snapshot: true } as GeneralStore
const settle = () => new Promise((resolve) => setTimeout(resolve, 15))
test("storage maintenance previews changes before confirmation and reports applied results", async () => {
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(() => createComponent(StoragePanel, { general, onGeneralChange() {} }), root)
  const click = async (label: string) => {
    const button = [...root.querySelectorAll("button")].find((item) => item.textContent?.trim() === label)
    expect(button).toBeDefined()
    button!.click()
    await settle()
  }
  try {
    await settle()
    expect(root.textContent).toContain("Research workspace")
    expect(root.textContent).toContain("1 on shared storage")
    for (const [label, action] of [
      ["Reclaim", "clean"],
      ["Migrate", "migrate"],
      ["Pack", "compact"],
    ]) {
      pending = undefined
      calls.length = 0
      await click(label!)
      expect(calls).toEqual([{ action, apply: false }])
      expect(pending).toBeDefined()
      await pending!.onConfirm()
      await settle()
      expect(calls).toEqual([
        { action, apply: false },
        { action, apply: true },
      ])
    }
    expect(notices.filter((item) => item.type === "success")).toHaveLength(3)
    empty = true
    pending = undefined
    calls.length = 0
    await click("Reclaim")
    expect(pending).toBeUndefined()
    expect(notices.at(-1)?.title).toBe("Nothing to reclaim")
    empty = false
    dryError = true
    await click("Reclaim")
    expect(pending).toBeUndefined()
    expect(notices.at(-1)?.type).toBe("error")
    expect(calls.every((item) => !item.apply)).toBe(true)
  } finally {
    dispose()
    root.remove()
    empty = false
    dryError = false
  }
})
