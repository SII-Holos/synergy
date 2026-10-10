import { expect, test } from "bun:test"
import { createSynergyClient, type SessionTransferState } from "@ericsanchezok/synergy-sdk/client"
import { migratePausedSession } from "../../../src/components/session/session-transfer"

test("a lost activation response retries the same handoff without exporting or executing again", async () => {
  const calls: string[] = []
  const migrationID = "90b48d40-2938-4ebc-9f79-cf206e94532a"
  const sourceID = "351174e5-d914-41f9-bd6b-cc2f964c8143"
  const targetID = "b80f7082-4bc5-4367-9395-7e8a4b5119da"
  let phase: SessionTransferState["phase"] = "prepared"
  let activated = false
  const receipt = {
    migrationID,
    sessionID: "ses_fixture",
    sourceID,
    targetID,
    digest: "a".repeat(64),
    phase: "prepared" as const,
  }
  const client = (origin: string) =>
    createSynergyClient({
      baseUrl: origin,
      throwOnError: true,
      fetch: Object.assign(
        async (request: RequestInfo | URL) => {
          const url = new URL(request instanceof Request ? request.url : String(request))
          calls.push(`${url.hostname}${url.pathname}`)
          if (url.pathname === "/session-transfer/host") return Response.json({ id: targetID })
          if (url.pathname === "/session-transfer/ses_fixture") return Response.json({ ...receipt, phase })
          if (url.pathname.endsWith("/archive"))
            return new Response(new Blob(["fixture"]), { headers: { "Content-Type": "application/zip" } })
          if (url.pathname.endsWith("/stage")) return Response.json(receipt)
          if (url.pathname.endsWith("/commit")) {
            phase = "committed"
            return Response.json({ ...receipt, secret: "b".repeat(64) })
          }
          if (url.pathname.endsWith("/activate")) {
            activated = true
            return Response.json({ data: { message: "lost response" } }, { status: 503 })
          }
          if (url.pathname.includes("/destination/"))
            return Response.json({ ...receipt, phase: activated ? "activated" : "prepared" })
          if (url.pathname.endsWith("/complete")) {
            phase = "completed"
            return Response.json({ ...receipt, phase })
          }
          throw new Error(`Unexpected migration operation ${url.pathname}`)
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    })
  const source = client("http://source")
  const target = client("http://target")
  await expect(
    migratePausedSession({ source, target, sessionID: receipt.sessionID, scopeID: "home", migrationID }),
  ).rejects.toBeDefined()
  await migratePausedSession({ source, target, sessionID: receipt.sessionID, scopeID: "home", migrationID })
  expect(phase as SessionTransferState["phase"]).toBe("completed")
  expect(calls.filter((call) => call.endsWith("/archive"))).toHaveLength(1)
  expect(calls.filter((call) => call.endsWith("/stage"))).toHaveLength(1)
  expect(calls.filter((call) => call.endsWith("/activate"))).toHaveLength(1)
  expect(calls.some((call) => call.includes("continue") || call.includes("prompt"))).toBe(false)
})

test("a cancelled receive is discarded before retrying the same destination", async () => {
  const migrationID = "90b48d40-2938-4ebc-9f79-cf206e94532a"
  const sourceID = "351174e5-d914-41f9-bd6b-cc2f964c8143"
  const targetID = "b80f7082-4bc5-4367-9395-7e8a4b5119da"
  const receipt = {
    migrationID,
    sessionID: "ses_fixture",
    sourceID,
    targetID,
    digest: "a".repeat(64),
    phase: "prepared",
  }
  let phase = "cancelled"
  let discardFails = true
  let prepares = 0
  let discards = 0
  const client = (origin: string) =>
    createSynergyClient({
      baseUrl: origin,
      throwOnError: true,
      fetch: Object.assign(
        async (request: RequestInfo | URL) => {
          const url = new URL(request instanceof Request ? request.url : String(request))
          if (url.pathname.endsWith("/host")) return Response.json({ id: targetID })
          if (url.pathname === "/session-transfer/ses_fixture") return Response.json({ ...receipt, phase })
          if (url.pathname.endsWith("/cancel")) return Response.json({ ...receipt, secret: "c".repeat(64) })
          if (url.pathname.endsWith("/discard")) {
            discards++
            return discardFails ? Response.json({ message: "offline" }, { status: 503 }) : Response.json(true)
          }
          if (url.pathname.endsWith("/prepare")) {
            prepares++
            phase = "prepared"
            return Response.json({ ...receipt, phase })
          }
          if (url.pathname.endsWith("/archive"))
            return new Response(new Blob(["fixture"]), { headers: { "Content-Type": "application/zip" } })
          if (url.pathname.endsWith("/stage")) return Response.json(receipt)
          if (url.pathname.endsWith("/commit")) return Response.json({ ...receipt, secret: "b".repeat(64) })
          if (url.pathname.endsWith("/activate")) return Response.json({ ...receipt, phase: "activated" })
          if (url.pathname.endsWith("/complete")) {
            phase = "completed"
            return Response.json({ ...receipt, phase })
          }
          throw new Error(`Unexpected operation ${url.pathname}`)
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    })
  const input = {
    source: client("http://source"),
    target: client("http://target"),
    sessionID: receipt.sessionID,
    scopeID: "home",
    migrationID: crypto.randomUUID(),
  }
  await expect(migratePausedSession(input)).rejects.toBeDefined()
  expect(prepares).toBe(0)
  expect(phase).toBe("cancelled")
  discardFails = false
  await migratePausedSession(input)
  expect(discards).toBe(2)
  expect(prepares).toBe(1)
  expect(phase).toBe("completed")
})
