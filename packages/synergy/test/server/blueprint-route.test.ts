import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { NoteStore } from "../../src/note"
import { BlueprintRoute } from "../../src/server/blueprint"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { MessageV2 } from "../../src/session/message-v2"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

let originalDeliver: typeof SessionManager.deliver

beforeEach(() => {
  originalDeliver = SessionManager.deliver
})

afterEach(() => {
  ;(SessionManager.deliver as any) = originalDeliver
})

function app() {
  return new Hono().route("/blueprint", BlueprintRoute)
}

async function createBlueprint(defaultAgent: string, auditAgent?: string) {
  return NoteStore.create({
    title: `${defaultAgent} Blueprint`,
    kind: "blueprint",
    blueprint: {
      description: `Run with ${defaultAgent}`,
      defaultAgent,
      auditAgent,
    },
  })
}

async function createLoop(noteID: string, sessionID: string) {
  const response = await app().request("/blueprint/loop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      noteID,
      title: "Prompt split",
      sessionID,
      runMode: "current",
    }),
  })
  expect(response.status).toBe(200)
  return response.json() as Promise<{ id: string; executionAgent?: string; auditAgent: string }>
}

describe("BlueprintRoute start prompt", () => {
  test("snapshots execution and audit agents onto the loop", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const note = await createBlueprint("synergy-max", "security-reviewer")
        const loop = await createLoop(note.id, session.id)

        expect(loop.executionAgent).toBe("synergy-max")
        expect(loop.auditAgent).toBe("security-reviewer")
      },
    })
  })

  test("uses the general Blueprint prompt for synergy", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const note = await createBlueprint("synergy")
        const loop = await createLoop(note.id, session.id)
        const deliveries: Parameters<typeof SessionManager.deliver>[0][] = []
        ;(SessionManager.deliver as any) = mock(async (input: Parameters<typeof SessionManager.deliver>[0]) => {
          deliveries.push(input)
        })

        const response = await app().request(`/blueprint/loop/${loop.id}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })

        expect(response.status).toBe(200)
        expect(deliveries).toHaveLength(1)
        const mail = deliveries[0].mail
        expect(mail.type).toBe("user")
        if (mail.type !== "user") throw new Error("expected user mail")
        expect(mail.agent).toBe("synergy")
        const text = (mail.parts[0] as MessageV2.TextPart).text
        expect(text).toContain('Execute the Blueprint "Prompt split"')
        expect(text).toContain("domain-appropriate specialists")
        expect(text).not.toContain("coding Blueprint")
        expect(text).not.toContain("migration or compatibility")
        expect(text).not.toContain("parallel implementation slices")
      },
    })
  })

  test("uses the coding Blueprint prompt for synergy-max", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const note = await createBlueprint("synergy-max")
        const loop = await createLoop(note.id, session.id)
        const deliveries: Parameters<typeof SessionManager.deliver>[0][] = []
        ;(SessionManager.deliver as any) = mock(async (input: Parameters<typeof SessionManager.deliver>[0]) => {
          deliveries.push(input)
        })

        const response = await app().request(`/blueprint/loop/${loop.id}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })

        expect(response.status).toBe(200)
        expect(deliveries).toHaveLength(1)
        const mail = deliveries[0].mail
        expect(mail.type).toBe("user")
        if (mail.type !== "user") throw new Error("expected user mail")
        expect(mail.agent).toBe("synergy-max")
        const text = (mail.parts[0] as MessageV2.TextPart).text
        expect(text).toContain('Execute the coding Blueprint "Prompt split"')
        expect(text).toContain("migration or compatibility")
        expect(text).toContain("parallel implementation slices")
      },
    })
  })
})
