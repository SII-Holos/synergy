import { describe, expect, test } from "bun:test"
import {
  createSessionDataView,
  EMPTY_CORTEX,
  EMPTY_DAG,
  EMPTY_INBOX,
  EMPTY_MESSAGES,
  EMPTY_PARTS,
  EMPTY_PART_TABLE,
  EMPTY_PERMISSIONS,
  EMPTY_QUESTIONS,
  EMPTY_SESSIONS,
  EMPTY_TODOS,
} from "../../src/context/session-data-view"
import type { Data } from "../../src/context/data"

const MESSAGE = {
  id: "m1",
  sessionID: "s1",
  role: "assistant",
  parentID: "root",
  rootID: "root",
  agent: "synergy",
  mode: "test",
  path: { cwd: "/workspace", root: "/workspace" },
  cost: 0,
  time: { created: 1 },
  model: { providerID: "provider", modelID: "model" },
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  modelID: "model",
  providerID: "provider",
} as const
const PART = {
  id: "p1",
  sessionID: "s1",
  messageID: "m1",
  type: "text",
  text: "hello",
} as const
function fullData(): Data {
  return {
    session: [{ id: "s1" } as never],
    session_status: { s1: { type: "idle" } },
    session_diff: { s1: [] },
    message: { s1: [MESSAGE] },
    part: { m1: [PART] },
    permission: { s1: [] },
    inbox: { s1: [] },
    todo: { s1: [] },
    dag: { s1: [] },
    question: { s1: [] },
    cortex: [],
  }
}

describe("createSessionDataView", () => {
  test("returns stored buckets for present keys", () => {
    const view = createSessionDataView(fullData())
    expect(view.partsFor("m1")).toEqual([PART])
    expect(view.messagesFor("s1")).toEqual([MESSAGE])
    expect(view.permissionsFor("s1")).toEqual([])
    expect(view.statusFor("s1")).toEqual({ type: "idle" })
    expect(view.inboxFor("s1")).toEqual([])
    expect(view.todosFor("s1")).toEqual([])
    expect(view.dagNodesFor("s1")).toEqual([])
    expect(view.questionsFor("s1")).toEqual([])
    expect(view.cortexTasks()).toEqual([])
    expect(view.sessionFor("s1")).toBeDefined()
  })

  test("returns shared empty arrays for missing buckets without throwing", () => {
    const view = createSessionDataView(fullData())
    expect(view.partsFor("missing-message")).toBe(EMPTY_PARTS)
    expect(view.messagesFor("missing-session")).toBe(EMPTY_MESSAGES)
    expect(view.permissionsFor("missing-session")).toBe(EMPTY_PERMISSIONS)
    expect(view.inboxFor("missing-session")).toBe(EMPTY_INBOX)
    expect(view.todosFor("missing-session")).toBe(EMPTY_TODOS)
    expect(view.dagNodesFor("missing-session")).toBe(EMPTY_DAG)
    expect(view.questionsFor("missing-session")).toBe(EMPTY_QUESTIONS)
    expect(view.cortexTasks()).toEqual([])

    const withoutCortex = { ...fullData(), cortex: undefined }
    expect(createSessionDataView(withoutCortex).cortexTasks()).toBe(EMPTY_CORTEX)
  })

  test("returns shared empty arrays for missing optional buckets on a partial store", () => {
    const partial = {
      session: [],
      session_status: {},
      session_diff: {},
      message: {},
      part: {},
    } as Data
    const view = createSessionDataView(partial)
    expect(view.inboxFor("s1")).toBe(EMPTY_INBOX)
    expect(view.todosFor("s1")).toBe(EMPTY_TODOS)
    expect(view.dagNodesFor("s1")).toBe(EMPTY_DAG)
    expect(view.questionsFor("s1")).toBe(EMPTY_QUESTIONS)
    expect(view.cortexTasks()).toBe(EMPTY_CORTEX)
  })

  test("returns shared empty arrays and undefined status when data is undefined", () => {
    const view = createSessionDataView(undefined)
    expect(view.partsFor("m1")).toBe(EMPTY_PARTS)
    expect(view.messagesFor("s1")).toBe(EMPTY_MESSAGES)
    expect(view.permissionsFor("s1")).toBe(EMPTY_PERMISSIONS)
    expect(view.statusFor("s1")).toBeUndefined()
    expect(view.inboxFor("s1")).toBe(EMPTY_INBOX)
    expect(view.todosFor("s1")).toBe(EMPTY_TODOS)
    expect(view.dagNodesFor("s1")).toBe(EMPTY_DAG)
    expect(view.questionsFor("s1")).toBe(EMPTY_QUESTIONS)
    expect(view.cortexTasks()).toBe(EMPTY_CORTEX)
    expect(view.sessions()).toBe(EMPTY_SESSIONS)
    expect(view.sessionFor("s1")).toBeUndefined()
  })

  test("returns the same singleton reference across calls (equality-guard safety)", () => {
    const view = createSessionDataView(undefined)
    expect(view.partsFor("a")).toBe(view.partsFor("b"))
    expect(view.messagesFor("a")).toBe(view.messagesFor("b"))
    expect(view.permissionsFor("a")).toBe(view.permissionsFor("b"))
    expect(view.inboxFor("a")).toBe(view.inboxFor("b"))
    expect(view.sessions()).toBe(view.sessions())
    expect(view.cortexTasks()).toBe(view.cortexTasks())
  })

  test("sessions and sessionFor read the store at call time, not view creation", () => {
    const data = fullData()
    const view = createSessionDataView(data)
    expect(view.sessionFor("s1")).toBeDefined()
    // Wholesale session-list replacement (the intermediate state a session
    // switch can leave behind): a view created before the swap must observe
    // the new list on every call.
    const replacement = [{ id: "s2" } as never]
    data.session = replacement
    expect(view.sessions()).toBe(replacement)
    expect(view.sessionFor("s1")).toBeUndefined()
    expect(view.sessionFor("s2")).toBeDefined()
  })

  test("hasInboxBucket distinguishes a loaded empty bucket from a missing one", () => {
    const view = createSessionDataView(fullData())
    expect(view.hasInboxBucket("s1")).toBe(true)
    expect(view.hasInboxBucket("missing")).toBe(false)
    expect(createSessionDataView(undefined).hasInboxBucket("s1")).toBe(false)
  })

  test("shared empty constants are frozen against consumer mutation", () => {
    expect(Object.isFrozen(EMPTY_PARTS)).toBe(true)
    expect(Object.isFrozen(EMPTY_MESSAGES)).toBe(true)
    expect(Object.isFrozen(EMPTY_PERMISSIONS)).toBe(true)
    expect(Object.isFrozen(EMPTY_INBOX)).toBe(true)
    expect(Object.isFrozen(EMPTY_TODOS)).toBe(true)
    expect(Object.isFrozen(EMPTY_DAG)).toBe(true)
    expect(Object.isFrozen(EMPTY_QUESTIONS)).toBe(true)
    expect(Object.isFrozen(EMPTY_CORTEX)).toBe(true)
    expect(Object.isFrozen(EMPTY_SESSIONS)).toBe(true)
    expect(Object.isFrozen(EMPTY_PART_TABLE)).toBe(true)
  })

  test("sessionFor finds by id across the session list", () => {
    const data = fullData()
    const view = createSessionDataView(data)
    expect(view.sessionFor("s1")).toBeDefined()
    expect(view.sessionFor("nope")).toBeUndefined()
  })
})
