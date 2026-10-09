import { afterEach, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { setupI18n } from "@lingui/core"
import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { SessionInboxItem } from "@ericsanchezok/synergy-sdk"

await plugin({
  name: "pending-composer-render",
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
mock.module("../../../src/context/locale", () => ({ useLocale: () => ({ i18n }) }))
mock.module("@lingui/solid", () => ({ useLingui: () => ({ _: i18n._.bind(i18n) }) }))
const { PendingComposerQueue } = await import("../../../src/components/session/pending-composer-queue")
let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  document.body.replaceChildren()
})

const item: SessionInboxItem = {
  id: "inb_pending",
  sessionID: "session-one",
  messageID: "message-one",
  mode: "task",
  summary: { title: "Pending direction", preview: "Check Beijing weather" },
  source: { type: "user" },
  time: { created: 1 },
  orderKey: "1",
}

test("the live queue follows Inbox identity, mode actions, delivery and session isolation", async () => {
  const root = document.createElement("div")
  document.body.append(root)
  const [identity, setIdentity] = createSignal("session-one")
  const [items, setItems] = createSignal<SessionInboxItem[]>([item])
  const [rollback, setRollback] = createSignal(false)
  let release!: () => void
  let guideCalls = 0
  dispose = render(
    () =>
      createComponent(PendingComposerQueue, {
        get identity() {
          return identity()
        },
        get items() {
          return items()
        },
        get rollbackActive() {
          return rollback()
        },
        hasCanonicalRoot: true,
        onGuide: async () => {
          guideCalls++
          await new Promise<void>((resolve) => {
            release = resolve
          })
        },
        onRemove: () => {
          setItems([])
        },
      }),
    root,
  )
  const button = () => root.querySelector<HTMLButtonElement>("button")!
  expect(root.querySelector("section")?.getAttribute("aria-label")).toBe("Inbox")
  expect(root.textContent).toContain("Pending direction")
  const original = button()
  original.focus()
  setItems([{ ...item, mode: "steer" }])
  expect(button()).toBe(original)
  expect(document.activeElement).toBe(original)
  expect(original.textContent).toBe("Queue")
  original.click()
  expect(guideCalls).toBe(1)
  expect(original.disabled).toBe(true)
  setIdentity("session-two")
  setItems([{ ...item, id: "inb_other", sessionID: "session-two" }])
  expect(button()).not.toBe(original)
  expect(button().disabled).toBe(false)
  release()
  await Promise.resolve()
  await Promise.resolve()
  expect(button().disabled).toBe(false)
  setRollback(true)
  expect(root.querySelectorAll("button").length).toBe(0)
  setRollback(false)
  Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
    .find((element) => element.textContent === "Withdraw")!
    .click()
  expect(root.querySelector("section")).toBeNull()
  setItems([item])
  expect(root.querySelector("section")).not.toBeNull()
  setIdentity("")
  expect(root.querySelector("section")).toBeNull()
})
