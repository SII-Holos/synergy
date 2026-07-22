import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { BlueprintLoopStore } from "../../src/blueprint"
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
  return response.json() as Promise<{ id: string; noteID: string; executionAgent?: string; auditAgent: string }>
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

  test("honors explicit execution agent and model for a Blueprint run", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const note = await createBlueprint("synergy")
        const response = await app().request("/blueprint/loop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            noteID: note.id,
            title: "Prompt split",
            sessionID: session.id,
            runMode: "current",
            executionAgent: "synergy-max",
            model: { providerID: "openai", modelID: "gpt-test" },
          }),
        })
        expect(response.status).toBe(200)
        const loop = (await response.json()) as {
          id: string
          executionAgent?: string
          model?: { providerID: string; modelID: string }
        }
        expect(loop.executionAgent).toBe("synergy-max")
        expect(loop.model).toEqual({ providerID: "openai", modelID: "gpt-test" })

        const deliveries: Parameters<typeof SessionManager.deliver>[0][] = []
        ;(SessionManager.deliver as any) = mock(async (input: Parameters<typeof SessionManager.deliver>[0]) => {
          deliveries.push(input)
        })

        const startResponse = await app().request(`/blueprint/loop/${loop.id}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })

        expect(startResponse.status).toBe(200)
        expect(deliveries).toHaveLength(1)
        const mail = deliveries[0].mail
        expect(mail.type).toBe("user")
        if (mail.type !== "user") throw new Error("expected user mail")
        expect(mail.agent).toBe("synergy-max")
        expect(mail.model).toEqual({ providerID: "openai", modelID: "gpt-test" })
        const text = (mail.parts[0] as MessageV2.TextPart).text
        expect(text).toContain('Execute the coding Blueprint "Prompt split"')
      },
    })
  })

  test("rejects a loop bound to a session from another scope", async () => {
    await using blueprintScope = await tmpdir({ git: true })
    await using otherScope = await tmpdir({ git: true })
    let otherSessionID = ""

    await ScopeContext.provide({
      scope: await otherScope.scope(),
      fn: async () => {
        otherSessionID = (await Session.create({})).id
      },
    })

    await ScopeContext.provide({
      scope: await blueprintScope.scope(),
      fn: async () => {
        const note = await createBlueprint("synergy-max")
        const response = await app().request("/blueprint/loop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            noteID: note.id,
            title: "Wrong scope",
            sessionID: otherSessionID,
            runMode: "current",
          }),
        })

        expect(response.status).toBe(400)
        const body = (await response.json()) as { message?: string }
        expect(body.message).toContain("belongs to scope")
      },
    })
  })

  test("rejects a second active loop for the same Blueprint", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const firstSession = await Session.create({})
        const secondSession = await Session.create({})
        const note = await createBlueprint("synergy-max")
        const firstLoop = await createLoop(note.id, firstSession.id)

        const response = await app().request("/blueprint/loop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            noteID: note.id,
            title: "Duplicate run",
            sessionID: secondSession.id,
            runMode: "new",
          }),
        })

        expect(response.status).toBe(400)
        const body = (await response.json()) as { message?: string; data?: Record<string, string> }
        expect(body.message).toBe("This Blueprint already has an active run.")
        expect(body.data).toEqual({
          noteID: note.id,
          loopID: firstLoop.id,
          sessionID: firstSession.id,
          status: "armed",
        })
      },
    })
  })

  test("start persists user prompt as durable loop context", async () => {
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
          body: JSON.stringify({ userPrompt: "  Treat API compatibility as a hard requirement.  " }),
        })

        expect(response.status).toBe(200)
        const stored = await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)
        expect(stored.userPrompt).toBe("Treat API compatibility as a hard requirement.")
        expect(deliveries).toHaveLength(1)
        const mail = deliveries[0].mail
        expect(mail.type).toBe("user")
        if (mail.type !== "user") throw new Error("expected user mail")
        const text = (mail.parts[0] as MessageV2.TextPart).text
        expect(text).toContain("User instruction:")
        expect(text).toContain("Treat API compatibility as a hard requirement.")
      },
    })
  })

  test("start does not persist blank user prompt context", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const note = await createBlueprint("synergy")
        const loop = await createLoop(note.id, session.id)
        ;(SessionManager.deliver as any) = mock(async () => {})

        const response = await app().request(`/blueprint/loop/${loop.id}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userPrompt: "   \n\t  " }),
        })

        expect(response.status).toBe(200)
        const stored = await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)
        expect(stored.userPrompt).toBeUndefined()
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
        expect(text).toContain("Before acting, identify the Blueprint's chosen implementation route")
        expect(text).toContain("Do not silently substitute a materially different route")
        expect(text).not.toContain("coding Blueprint")
        expect(text).not.toContain("migration or compatibility")
        expect(text).not.toContain("parallel implementation slices")
      },
    })
  })

  test("start returns after scheduling the first prompt", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const note = await createBlueprint("synergy")
        const loop = await createLoop(note.id, session.id)
        let releaseDeliver: (() => void) | undefined
        ;(SessionManager.deliver as any) = mock(async () => {
          await new Promise<void>((resolve) => {
            releaseDeliver = resolve
          })
        })

        const request = app().request(`/blueprint/loop/${loop.id}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
        const response = await Promise.race([
          request,
          new Promise<Response | undefined>((resolve) => setTimeout(() => resolve(undefined), 1000)),
        ])

        try {
          expect(response?.status).toBe(200)
        } finally {
          releaseDeliver?.()
          await request
        }
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
        expect(text).toContain("Before editing code, identify the Blueprint's chosen implementation route")
        expect(text).toContain("Do not silently substitute a materially different architecture")
      },
    })
  })
})
