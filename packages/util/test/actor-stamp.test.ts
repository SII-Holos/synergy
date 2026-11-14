import { expect, test } from "bun:test"
import { ActorStamp } from "../src/actor-stamp"

const principal = {
  kind: "account",
  orgID: "org-a",
  subjectID: "account-a",
  displayName: "Alice",
  clientKind: "web",
  requestID: "request-a",
} satisfies ActorStamp.Info

test("actor stamps retain bounded historical identity without accepting authority or recursive causes", () => {
  expect(ActorStamp.Info.parse(principal)).toEqual(principal)
  expect(ActorStamp.Account.parse(principal)).toEqual(principal)
  expect(ActorStamp.Account.safeParse({ ...principal, kind: "system" }).success).toBe(false)
  const local = { ...principal, kind: "local" }
  expect(ActorStamp.Info.safeParse(local).success).toBe(false)
  const { orgID, ...withoutOrg } = principal
  expect(ActorStamp.Info.safeParse(withoutOrg).success).toBe(false)
  expect(ActorStamp.Info.parse({ ...withoutOrg, kind: "local" })).toMatchObject({ kind: "local" })
  expect(ActorStamp.Info.safeParse({ ...principal, role: "owner" }).success).toBe(false)
  expect(ActorStamp.Info.safeParse({ ...principal, permissions: ["execute"] }).success).toBe(false)
  expect(ActorStamp.Info.safeParse({ ...principal, subjectID: "x".repeat(129) }).success).toBe(false)
  expect(ActorStamp.Info.safeParse({ ...principal, displayName: "x".repeat(201) }).success).toBe(false)
  const system = { ...principal, kind: "system", clientKind: "system", causedBy: [principal] } satisfies ActorStamp.Info
  expect(ActorStamp.Info.parse(system)).toEqual(system)
  expect(ActorStamp.Info.safeParse({ ...system, causedBy: [system] }).success).toBe(false)
  expect(ActorStamp.Info.safeParse({ ...system, causedBy: Array(17).fill(principal) }).success).toBe(false)
  expect(ActorStamp.Info.safeParse({ ...principal, causedBy: [principal] }).success).toBe(false)
})
