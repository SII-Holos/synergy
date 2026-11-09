import { expect, test } from "bun:test"
import { OrganizationGatewayProtocol as Gateway } from "@ericsanchezok/synergy-organization-protocol"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { ProviderRequestSource } from "@ericsanchezok/synergy-harness/provider/request-source"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionExecutionSource } from "@ericsanchezok/synergy-harness/session/execution-source"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { executionFixture } from "./support/execution"

const plan: Provider.WorkerPlan = {
  authoritative: true,
  env: [],
  options: {},
  timeouts: { ttfbMs: 1000, idleMs: 1000, wallMs: 3000 },
}

async function materialize(f: Awaited<ReturnType<typeof executionFixture>>) {
  await f.runtime.run(async () => {
    const session = await Session.get(f.sessionID)
    await SessionExecutionSource.authorize({ sessionID: session.id, scopeID: session.scope.id })
  })
  const proof = await f.binding()
  return f.runtime.run(async () => {
    const session = await Session.get(f.sessionID)
    const user = MessageV2.User.parse(
      await MessageV2.readInfo({ scopeID: session.scope.id, sessionID: session.id, messageID: proof.rootID }),
    )
    const model = await ScopeContext.provide({
      scope: session.scope,
      workspace: null,
      fn: () => Provider.getModel(user.model.providerID, user.model.modelID),
    })
    return { session, user, model, abort: new AbortController().signal, sessionID: session.id }
  })
}

test("member request preparation binds canonical roots and gives each call its own finite capability", async () => {
  await using f = await executionFixture({ execution: true })
  const input = await materialize(f)
  await f.runtime.run(async () => {
    const [first, second] = await Promise.all([
      ProviderRequestSource.prepare(input, plan),
      ProviderRequestSource.prepare(input, plan),
    ])
    const a = Gateway.decode(first.key!)
    const b = Gateway.decode(second.key!)
    expect(a.permit.callID).not.toBe(b.permit.callID)
    expect(a.permit).toMatchObject({ rootID: input.user.id, sessionID: f.sessionID, resourceID: f.model.resourceID })
    expect(first.options.hostRequest).toMatchObject({
      purpose: "organization-model",
      origin: f.origin,
      signingIdentity: f.connection.connected.signingIdentity,
    })
    expect(plan.key).toBeUndefined()
    expect(plan.options).toEqual({})
    expect(input.model.options).toEqual({})
    await ScopeContext.provide({ scope: Scope.home(), fn: async () => expect(await Provider.list()).toEqual({}) })
    await ScopeContext.provide({
      scope: input.session.scope,
      workspace: null,
      fn: async () => {
        const catalog = await Provider.list()
        expect(Object.keys(catalog)).toEqual([input.model.providerID])
        expect(JSON.stringify(catalog)).not.toContain(first.key!)
        expect(JSON.stringify(catalog)).not.toContain("private-upstream-key")
      },
    })
  })
})

test("member sources reject receipt substitution, foreign targets, detached model changes and unadmitted children", async () => {
  await using f = await executionFixture({ execution: true })
  const input = await materialize(f)
  let reservations = 0
  f.interceptHTTP((request) => {
    if (new URL(request.url).pathname.endsWith("/gateway/calls")) reservations++
  })
  await f.runtime.run(async () => {
    await expect(
      SessionExecutionSource.authorize({ sessionID: f.sessionID, scopeID: "foreign-project" }),
    ).rejects.toBeInstanceOf(SessionExecutionSource.DeniedError)
    for (const changes of [
      { user: { ...input.user, sessionID: "foreign-session" } },
      { user: { ...input.user, rootID: "foreign-root" } },
      { model: { ...input.model, providerID: "private-provider" } },
      { model: { ...input.model, id: "other-model" } },
    ])
      await expect(ProviderRequestSource.prepare({ ...input, ...changes }, plan)).rejects.toBeInstanceOf(
        ProviderRequestSource.PreparationError,
      )
    const child = await ScopeContext.provide({
      scope: input.session.scope,
      workspace: null,
      fn: () => Session.create({ parentID: f.sessionID }),
    })
    await expect(
      SessionExecutionSource.authorize({ sessionID: child.id, scopeID: child.scope.id, parentSessionID: f.sessionID }),
    ).rejects.toBeInstanceOf(SessionExecutionSource.DeniedError)
    await SessionInbox.deliver({
      sessionID: f.sessionID,
      mode: "task",
      message: {
        role: "user",
        actor: input.user.actor,
        origin: { type: "user" },
        parts: [{ type: "text", text: "Unadmitted replacement" }],
      },
    })
    await expect(
      SessionExecutionSource.authorize({ sessionID: f.sessionID, scopeID: input.session.scope.id }),
    ).rejects.toBeInstanceOf(SessionExecutionSource.DeniedError)
    expect(reservations).toBe(0)
  })
})

test("accepted roots retain selection grants while resource disablement and disconnect deny fresh preparation", async () => {
  await using f = await executionFixture({ execution: true })
  const input = await materialize(f)
  const prepared = await f.runtime.run(() => ProviderRequestSource.prepare(input, plan))
  await f.client.orgResourceGrants.set(
    {
      resourceID: f.model.resourceID,
      kind: "account",
      subjectID: f.identity.accountID,
      orgResourceGrantChange: { expectedRevision: 1, enabled: false },
    },
    { headers: f.headers, throwOnError: true },
  )
  expect((await f.runtime.run(() => ProviderRequestSource.prepare(input, plan))).key).not.toBe(prepared.key)
  await f.client.orgResources.update(
    { resourceID: f.model.resourceID, orgResourceChange: { expectedRevision: 1, state: "disabled" } },
    { headers: f.headers, throwOnError: true },
  )
  await f.runtime.run(async () => {
    await expect(ProviderRequestSource.prepare(input, plan)).rejects.toBeInstanceOf(
      ProviderRequestSource.PreparationError,
    )
    await expect(
      SessionExecutionSource.authorize({ sessionID: f.sessionID, scopeID: input.session.scope.id }),
    ).rejects.toBeInstanceOf(SessionExecutionSource.DeniedError)
  })
  await f.connection.close()
  await f.runtime.run(() =>
    expect(ProviderRequestSource.prepare(input, plan)).rejects.toBeInstanceOf(ProviderRequestSource.PreparationError),
  )
  await f.client.orgResources.update(
    { resourceID: f.model.resourceID, orgResourceChange: { expectedRevision: 2, state: "enabled" } },
    { headers: f.headers, throwOnError: true },
  )
  await f.reconnect()
  const next = Gateway.decode((await f.runtime.run(() => ProviderRequestSource.prepare(input, plan))).key!)
  const previous = Gateway.decode(prepared.key!)
  expect(next.permit.connectionEpoch).toBeGreaterThan(previous.permit.connectionEpoch)
  expect(next.permit.callID).not.toBe(previous.permit.callID)
  const cancelled = new AbortController()
  cancelled.abort(new Error("Cancelled before preparation"))
  await f.runtime.run(() =>
    expect(ProviderRequestSource.prepare({ ...input, abort: cancelled.signal }, plan)).rejects.toThrow(
      "Cancelled before preparation",
    ),
  )
})

test("resource model changes cannot silently reinterpret a materialized native root", async () => {
  await using f = await executionFixture({ execution: true })
  const input = await materialize(f)
  const configuration = f.model.configuration
  if (configuration.protocol !== "openai-compatible")
    throw new Error("Model fixture requires OpenAI-compatible configuration")
  await f.client.orgResources.update(
    {
      resourceID: f.model.resourceID,
      orgResourceChange: {
        expectedRevision: 1,
        configuration: { ...configuration, model: { ...configuration.model, id: "changed-model" } },
      },
    },
    { headers: f.headers, throwOnError: true },
  )
  await f.runtime.run(async () => {
    await expect(
      SessionExecutionSource.authorize({ sessionID: f.sessionID, scopeID: input.session.scope.id }),
    ).rejects.toBeInstanceOf(SessionExecutionSource.DeniedError)
    await expect(ProviderRequestSource.prepare(input, plan)).rejects.toBeInstanceOf(
      ProviderRequestSource.PreparationError,
    )
    expect((await Session.get(f.sessionID)).modelSelection?.selected.model).toEqual(input.user.model)
  })
})
