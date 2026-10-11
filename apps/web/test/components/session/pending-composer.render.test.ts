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
  let rejectGuide!: (error: unknown) => void
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
          await new Promise<void>((resolve, reject) => {
            release = resolve
            rejectGuide = reject
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
  original.click()
  expect(guideCalls).toBe(1)
  rejectGuide({ data: { message: "Guide unavailable" } })
  await Promise.resolve()
  await Promise.resolve()
  expect(root.querySelector('[role="alert"]')?.textContent).toContain("Guide unavailable")
  expect(original.disabled).toBe(false)
  original.click()
  expect(guideCalls).toBe(2)
  expect(original.disabled).toBe(true)
  setIdentity("session-two")
  setItems([{ ...item, id: "inb_other", sessionID: "session-two" }])
  expect(button()).not.toBe(original)
  expect(button().disabled).toBe(false)
  release()
  await Promise.resolve()
  await Promise.resolve()
  expect(button().disabled).toBe(false)
  expect(root.querySelector('[role="alert"]')).toBeNull()
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

test("withdrawal recovery respects rollback and first-task locks", async () => {
  const root = document.createElement("div")
  document.body.append(root)
  const [rollback, setRollback] = createSignal(false)
  const [hasRoot, setHasRoot] = createSignal(true)
  let removeCalls = 0
  dispose = render(
    () =>
      createComponent(PendingComposerQueue, {
        identity: "session-one",
        items: [item],
        get rollbackActive() {
          return rollback()
        },
        get hasCanonicalRoot() {
          return hasRoot()
        },
        onGuide: () => {},
        onRemove: async () => {
          removeCalls++
          throw { message: "Withdrawal unavailable" }
        },
      }),
    root,
  )
  const retry = () =>
    Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("Retry"),
    )
  Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent === "Withdraw")!
    .click()
  await Promise.resolve()
  await Promise.resolve()
  expect(removeCalls).toBe(1)
  expect(root.querySelector('[role="alert"]')?.textContent).toContain("Removal could not be confirmed")
  expect(retry()).toBeDefined()
  const retainedRetry = retry()!
  setRollback(true)
  retainedRetry.click()
  expect(removeCalls).toBe(1)
  expect(retry()).toBeUndefined()
  setRollback(false)
  setHasRoot(false)
  expect(retry()).toBeUndefined()
  setHasRoot(true)
  retry()!.click()
  expect(removeCalls).toBe(2)
})

test("removing one queued identity retains the other row and its focused control", () => {
  const root = document.createElement("div")
  document.body.append(root)
  const other = { ...item, id: "inb_other", messageID: "message-other", summary: { title: "Other direction" } }
  const [items, setItems] = createSignal([item, other])
  dispose = render(
    () =>
      createComponent(PendingComposerQueue, {
        identity: "session-one",
        get items() {
          return items()
        },
        rollbackActive: false,
        hasCanonicalRoot: true,
        onGuide: () => {},
        onRemove: () => {},
      }),
    root,
  )
  const rows = root.querySelectorAll('[data-slot="pending-timeline-item"]')
  const focused = rows[1]!.querySelector<HTMLButtonElement>("button")!
  focused.focus()
  setItems([other])
  expect(root.querySelectorAll('[data-slot="pending-timeline-item"]').length).toBe(1)
  expect(root.querySelector('[data-slot="pending-timeline-item"]')).toBe(rows[1])
  expect(document.activeElement).toBe(focused)
  setItems([])
  expect(root.querySelector("section")).toBeNull()
})
