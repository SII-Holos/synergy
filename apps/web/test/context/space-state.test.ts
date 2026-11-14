import { expect, test } from "bun:test"
import { createSpaceView, spaceKey, SpaceIdentity } from "../../src/context/space-state"

const personal = { kind: "personal", localRuntimeID: "94497ff6-b2b3-478e-a3aa-ce77665f0626" } as const
const organization = {
  kind: "organization",
  orgID: "org-a",
  accountID: "account-a",
  deploymentIncarnation: "deployment-a",
} as const

test("space identity separates accounts, deployments and personal Homes without using a connection URL", () => {
  const variants = [
    personal,
    { ...personal, localRuntimeID: "01487365-5a92-44c6-85bd-3b47c61cb066" },
    organization,
    { ...organization, orgID: "org-b" },
    { ...organization, accountID: "account-b" },
    { ...organization, deploymentIncarnation: "deployment-b" },
  ]
  expect(new Set(variants.map(spaceKey)).size).toBe(variants.length)
  expect(spaceKey({ ...organization })).toBe(spaceKey(organization))
  expect(SpaceIdentity.safeParse({ ...organization, url: "https://unrelated.example" }).success).toBe(false)
  expect(SpaceIdentity.safeParse({ kind: "personal", localRuntimeID: "https://runtime.example" }).success).toBe(false)
})

test("space switching cancels the previous view before publishing the next and never revives an old generation", async () => {
  const view = createSpaceView()
  const first = view.select(organization)
  const events: string[] = []
  first.signal.addEventListener("abort", () => {
    events.push("abort")
    expect(view.current()).toBe(first)
  })
  const pending = Promise.withResolvers<string>()
  const applied: string[] = []
  const response = pending.promise.then((value) => {
    if (view.isCurrent(first)) applied.push(value)
  })
  const second = view.select({ ...organization, accountID: "account-b" })
  events.push("selected")
  expect(events).toEqual(["abort", "selected"])
  expect(first.signal.aborted).toBe(true)
  expect(second.signal.aborted).toBe(false)
  expect(view.isCurrent(first)).toBe(false)
  const returned = view.select(organization)
  expect(returned.key).toBe(first.key)
  expect(returned.generation).toBeGreaterThan(first.generation)
  pending.resolve("late account-a response")
  await response
  expect(applied).toEqual([])
  expect(view.isCurrent(returned)).toBe(true)
  view.clear()
  expect(returned.signal.aborted).toBe(true)
  expect(view.current()).toBeUndefined()
})
