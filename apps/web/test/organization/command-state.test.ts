import { expect, test } from "bun:test"
import { createOrganizationCommandState } from "../../src/organization/command-state"
const request = {
  schemaVersion: 1,
  orgID: "org-a",
  requestID: "request-one",
  projectID: "project-one",
  runtimeID: "runtime-one",
  creation: { operation: "create", title: "Research" },
} as const
test("unknown outcomes keep their original payload and identity across reloads and owners", () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
  const state = createOrganizationCommandState(storage, "space-a", "project-one")
  state.begin(request)
  expect(createOrganizationCommandState(storage, "space-a", "project-one").pending()).toEqual(request)
  expect(createOrganizationCommandState(storage, "space-b", "project-one").pending()).toBeUndefined()
  expect(() => state.begin({ ...request, requestID: "new-request" })).toThrow()
  state.clear("different-request")
  expect(state.pending()).toEqual(request)
  state.clear(request.requestID)
  expect(state.pending()).toBeUndefined()
})
test("failure to persist an operation prevents dispatch and never replaces an earlier request", () => {
  const state = createOrganizationCommandState(
    {
      getItem: () => null,
      setItem: () => {
        throw new Error("Storage full")
      },
      removeItem() {},
    },
    "space-a",
    "project-one",
  )
  expect(() => state.begin(request)).toThrow("Storage full")
  expect(state.pending()).toBeUndefined()
})
