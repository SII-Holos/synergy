import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { SessionInteraction } from "../../src/session/interaction"
import { tmpdir } from "../fixture/fixture"

function endpoint(chatId: string) {
  return SessionEndpoint.fromChannel({
    type: "test",
    accountId: "account",
    chatId,
  })
}

describe("Session endpoint Scope ownership", () => {
  test("reuses an endpoint only inside its owning Scope", async () => {
    await using firstDirectory = await tmpdir()
    await using secondDirectory = await tmpdir()
    const firstScope = await firstDirectory.scope()
    const secondScope = await secondDirectory.scope()
    const target = endpoint(`chat-${crypto.randomUUID()}`)

    const created = await Session.getOrCreateForEndpoint(target, {
      scope: firstScope,
      interaction: SessionInteraction.unattended("channel:test"),
      title: "External project",
      controlProfile: "autonomous",
    })
    const reused = await Session.getOrCreateForEndpoint(target, { scope: firstScope })

    expect(reused.id).toBe(created.id)
    expect(reused.scope.id).toBe(firstScope.id)
    expect(await Session.findForEndpoint(target, { scope: firstScope })).toMatchObject({ id: created.id })

    await expect(Session.findForEndpoint(target, { scope: secondScope })).rejects.toBeInstanceOf(
      Session.EndpointScopeMismatchError,
    )
    await expect(Session.getOrCreateForEndpoint(target, { scope: secondScope })).rejects.toBeInstanceOf(
      Session.EndpointScopeMismatchError,
    )
    await expect(Session.archiveForEndpoint(target, { scope: secondScope })).rejects.toBeInstanceOf(
      Session.EndpointScopeMismatchError,
    )
  })

  test("creates at most one active Session under concurrent first delivery", async () => {
    await using directory = await tmpdir()
    const scope = await directory.scope()
    const target = endpoint(`chat-${crypto.randomUUID()}`)

    const sessions = await Promise.all(
      Array.from({ length: 12 }, () => Session.getOrCreateForEndpoint(target, { scope })),
    )

    expect(new Set(sessions.map((session) => session.id))).toEqual(new Set([sessions[0]!.id]))
  })

  test("archive preserves history and permits one replacement Session", async () => {
    await using directory = await tmpdir()
    const scope = await directory.scope()
    const target = endpoint(`chat-${crypto.randomUUID()}`)
    const first = await Session.getOrCreateForEndpoint(target, { scope })

    await Session.archiveForEndpoint(target, { scope })
    const replacement = await Session.getOrCreateForEndpoint(target, { scope })

    expect(replacement.id).not.toBe(first.id)
    expect((await Session.get(first.id)).time.archived).toBeNumber()
    expect(await Session.findForEndpoint(target, { scope })).toMatchObject({ id: replacement.id })
  })
})
