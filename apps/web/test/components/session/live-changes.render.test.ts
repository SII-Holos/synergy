import solid from "babel-preset-solid"
import typescript from "@babel/preset-typescript"
import { afterEach, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { setupI18n } from "@lingui/core"
import { createComponent, createEffect, createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { CurrentTurnChanges, FileDiff, Message } from "@ericsanchezok/synergy-sdk/client"
import type { SessionReviewTabProps } from "../../../src/components/session/session-review-tab"
import { reduceCurrentTurnChanges } from "../../../src/context/current-turn-changes"

await plugin({
  name: "live-changes-render",
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
const i18n = setupI18n({ locale: "en", messages: { en: {} } })
const [connected, setConnected] = createSignal(true)
const [current, setCurrent] = createSignal<CurrentTurnChanges>()
mock.module("@lingui/solid", () => ({ useLingui: () => ({ _: i18n._.bind(i18n), i18n: () => i18n }) }))
mock.module("../../../src/context/sdk", () => ({ useSDK: () => ({ connected }) }))
mock.module("../../../src/context/sync", () => ({ useSync: () => ({ session: { currentTurn: current } }) }))
mock.module("@ericsanchezok/synergy-ui/icon", () => ({ Icon: () => document.createElement("span") }))
mock.module("@ericsanchezok/synergy-ui/button", () => ({
  Button: (props: { children?: string; onClick?: () => void }) => {
    const button = document.createElement("button")
    createEffect(() => {
      button.textContent = props.children ?? ""
    })
    button.onclick = () => props.onClick?.()
    return button
  },
}))
const [recording, setRecording] = createSignal<{ status: "live" | "ready" }>({ status: "live" })
const [failure, setFailure] = createSignal<Error>()
const row: FileDiff = {
  file: "outside-window.ts",
  additions: 2,
  deletions: 1,
  workspace: { id: "workspace", generation: 1, root: "/fixture" },
}
const requests: Array<{ source: string; root?: string }> = []
let refreshes = 0,
  reads = 0
mock.module("../../../src/components/workspace/review-data", () => ({
  errorText: (error: Error) => error.message,
  useReviewData: (input: { source: () => string; messageID: () => string | undefined }) => {
    createEffect(() => requests.push({ source: input.source(), root: input.messageID() }))
    return {
      rows: () => [row],
      context: () => ({ recording: recording() }),
      comparison: {
        get error() {
          return failure()
        },
      },
      refresh() {
        refreshes++
      },
      async load() {
        reads++
        return { diff: { ...row, patch: "+recorded" } }
      },
    }
  },
}))
mock.module("../../../src/components/session/session-review-tab", () => ({
  SessionReviewTab: (props: SessionReviewTabProps) => {
    const root = document.createElement("section"),
      label = document.createElement("output"),
      restore = document.createElement("button"),
      load = document.createElement("button")
    restore.textContent = "Restore file"
    load.textContent = "Expand file"
    createEffect(() => {
      label.textContent = props
        .diffs()
        .map((file) => file.file)
        .join(",")
      restore.hidden = !props.onRestoreFile
    })
    restore.onclick = () => props.onRestoreFile?.(row)
    load.onclick = async () => {
      label.textContent = (await props.loadDiff!(row, new AbortController().signal)).patch ?? ""
    }
    root.append(label, restore, load)
    return root
  },
}))
const { TurnChangeStatus } = await import("../../../src/components/session/turn-change-status")
const { MobileSessionReview } = await import("../../../src/components/session/mobile-session-review")
const { TurnChangeSummaryPanel } = await import("@ericsanchezok/synergy-ui/turn-change-summary-panel")
let dispose: (() => void) | undefined
const root = document.createElement("div")
afterEach(() => {
  dispose?.()
  root.replaceChildren()
  root.remove()
  setConnected(true)
  setCurrent(undefined)
  setFailure(undefined)
  setRecording({ status: "live" })
  requests.length = 0
  refreshes = 0
  reads = 0
})
const tick = () => new Promise((resolve) => queueMicrotask(resolve))

test("the current root projection ignores historical and non-root updates and discards bounded file rows", () => {
  const message: Message = {
    id: "new",
    sessionID: "session",
    role: "user",
    isRoot: true,
    time: { created: 20 },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    summary: { diffs: [row], diffTotals: { files: 300, additions: 900, deletions: 1 } },
  }
  const next = reduceCurrentTurnChanges(undefined, message)
  expect(next).toMatchObject({
    rootID: "new",
    summary: { diffs: [], diffTotals: { files: 300, additions: 900, deletions: 1 } },
  })
  expect(reduceCurrentTurnChanges(next, { ...message, id: "older", time: { created: 10 } })).toBe(next)
  expect(reduceCurrentTurnChanges(next, { ...message, isRoot: false, time: { created: 30 } })).toBe(next)
  expect(reduceCurrentTurnChanges(null, { ...message, summary: undefined })).toMatchObject({
    rootID: "new",
    summary: undefined,
  })
  expect(reduceCurrentTurnChanges(next, { ...message, visible: false })).toBe(next)
  const history = {
    rollback: {
      id: "rollback",
      numTurns: 1,
      created: 40,
      droppedMessageIDs: ["new"],
      droppedUserMessageIDs: ["new"],
      files: [],
      patchPartIDs: [],
      canUnrollback: true,
    },
  }
  const accepted = { rootID: "older", createdAt: 10, summary: { diffs: [] } }
  expect(reduceCurrentTurnChanges(accepted, message, history)).toBe(accepted)
  expect(reduceCurrentTurnChanges(undefined, message, history)).toBeUndefined()
  expect(
    reduceCurrentTurnChanges(accepted, { ...message, id: "after-rollback", time: { created: 50 } }, history)?.rootID,
  ).toBe("after-rollback")
})

test("the whole activity surface opens its root, preserves confirmed zero offline and hands off only accepted final evidence", async () => {
  document.body.append(root)
  const reviewed: string[] = []
  dispose = render(
    () => createComponent(TurnChangeStatus, { sessionID: "session", onReview: (id) => reviewed.push(id) }),
    root,
  )
  expect(root.querySelector("button")).toBeNull()
  setCurrent({
    rootID: "outside-window",
    createdAt: 1,
    summary: {
      diffs: [],
      diffState: { status: "live" },
      diffTotals: { files: 300, additions: 900, deletions: 1 },
      diffHasChanges: true,
    },
  })
  await tick()
  const button = root.querySelector("button")!
  expect(button.textContent).toContain("300 files")
  button.click()
  expect(reviewed).toEqual(["outside-window"])
  setCurrent({
    rootID: "outside-window",
    createdAt: 1,
    summary: {
      diffs: [],
      diffState: { status: "live" },
      diffTotals: { files: 0, additions: 0, deletions: 0 },
      diffHasChanges: true,
    },
  })
  setConnected(false)
  await tick()
  expect(root.textContent).toContain("Recorded changes")
  expect(root.textContent).toContain("0 files")
  setCurrent({
    rootID: "outside-window",
    createdAt: 1,
    summary: { diffs: [], diffState: { status: "error", code: "incomplete" }, diffRevision: "retained" },
  })
  await tick()
  expect(root.textContent).toContain("Unavailable")
  expect(root.textContent).not.toContain("0 files")
  setCurrent({
    rootID: "outside-window",
    createdAt: 1,
    summary: { diffs: [], diffState: { status: "ready" }, diffTotals: { files: 0, additions: 0, deletions: 0 } },
  })
  await tick()
  expect(root.querySelector("button")).toBeNull()
})

test("mobile Review targets a cold root, loads details on expansion and exposes restore only after settlement", async () => {
  document.body.append(root)
  const [messageID, setMessageID] = createSignal<string | undefined>("cold-root")
  let restored = 0
  dispose = render(
    () =>
      createComponent(MobileSessionReview, {
        get messageID() {
          return messageID()
        },
        view: () => ({}) as ReturnType<SessionReviewTabProps["view"]>,
        diffStyle: "unified",
        onRestoreFile: () => restored++,
      }),
    root,
  )
  await tick()
  expect(requests).toEqual([{ source: "turn", root: "cold-root" }])
  expect(root.textContent).toContain("outside-window.ts")
  const button = (text: string) => [...root.querySelectorAll("button")].find((button) => button.textContent === text)!
  expect(button("Restore file").hidden).toBe(true)
  expect(reads).toBe(0)
  button("Expand file").click()
  await tick()
  expect(reads).toBe(1)
  expect(root.textContent).toContain("+recorded")
  button("Refresh comparison").click()
  expect(refreshes).toBe(1)
  setRecording({ status: "ready" })
  await tick()
  expect(button("Restore file").hidden).toBe(false)
  button("Restore file").click()
  expect(restored).toBe(1)
  setFailure(new Error("Comparison expired"))
  await tick()
  expect(root.querySelector('[role="alert"]')?.textContent).toContain("Comparison expired")
  setMessageID(undefined)
  await tick()
  expect(requests.at(-1)).toEqual({ source: "session", root: undefined })
})

test("settled summaries retain exact totals even when every file row is outside the bounded projection", () => {
  document.body.append(root)
  let reviews = 0
  dispose = render(
    () =>
      createComponent(TurnChangeSummaryPanel, {
        diffs: [],
        totals: { files: 300, additions: 900, deletions: 12 },
        onReviewRequested: () => reviews++,
        onFileSelected: () => {},
      }),
    root,
  )
  expect(root.querySelector('[data-slot="turn-change-summary-title"]')?.textContent).toBe("Changed 300 files")
  expect(root.textContent).toContain("+900")
  expect(root.textContent).toContain("-12")
  root.querySelector<HTMLButtonElement>('[data-slot="turn-change-summary-review"]')!.click()
  expect(reviews).toBe(1)
})
