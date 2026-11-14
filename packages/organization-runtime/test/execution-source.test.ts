import { expect, spyOn, test } from "bun:test"
import { OrganizationGatewayProtocol as Gateway } from "@ericsanchezok/synergy-organization-protocol"
import { Cortex } from "@ericsanchezok/synergy-harness/cortex"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { ProviderRequestSource } from "@ericsanchezok/synergy-harness/provider/request-source"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionExecutionSource } from "@ericsanchezok/synergy-harness/session/execution-source"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { executionFixture } from "./support/execution"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"

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
    const task = await ScopeContext.provide({
      scope: input.session.scope,
      workspace: null,
      fn: () =>
        Cortex.prepare({
          description: "Admitted child",
          prompt: "Use the accepted organization task",
          agent: input.user.agent,
          parentSessionID: f.sessionID,
          parentMessageID: input.user.id,
        }),
    })
    const admitted = await Session.get(task.sessionID)
    await expect(
      SessionExecutionSource.authorize({
        sessionID: admitted.id,
        scopeID: admitted.scope.id,
        parentSessionID: admitted.parentID,
      }),
    ).resolves.toBeUndefined()
    await ScopeContext.provide({ scope: input.session.scope, workspace: null, fn: () => Cortex.cancel(task.id) })
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

test("Cortex child model calls retain the accepted ancestor root capability", async () => {
  await using f = await executionFixture({ execution: true })
  const input = await materialize(f)
  const task = await f.runtime.run(() =>
    ScopeContext.provide({
      scope: input.session.scope,
      workspace: null,
      fn: () =>
        Cortex.prepare({
          description: "Child model call",
          prompt: "Use the accepted organization task",
          agent: input.user.agent,
          parentSessionID: f.sessionID,
          parentMessageID: input.user.id,
        }),
    }),
  )
  const prepared = await f.runtime.run(async () => {
    const child = await Session.get(task.sessionID)
    await SessionExecutionSource.authorize({
      sessionID: child.id,
      scopeID: child.scope.id,
      parentSessionID: child.parentID,
    })
    return ScopeContext.provide({
      scope: child.scope,
      workspace: null,
      fn: async () => {
        await SessionInbox.deliver({
          sessionID: child.id,
          mode: "task",
          message: {
            role: "user",
            agent: input.user.agent,
            model: { providerID: input.model.providerID, modelID: input.model.id },
            origin: { type: "system" },
            parts: [{ type: "text", text: "Child call" }],
          },
        })
        const item = (await SessionInbox.list(child.id))[0]!
        expect((await SessionInbox.materializeNextTask(child.id)).status).toBe("materialized")
        await RolloutLedger.beginRun(RolloutLifecycle.owner(child), item.messageID)
        const user = MessageV2.User.parse(
          await MessageV2.readInfo({ scopeID: child.scope.id, sessionID: child.id, messageID: item.messageID }),
        )
        const model = await Provider.getModel(input.model.providerID, input.model.id)
        return ProviderRequestSource.prepare({ ...input, sessionID: child.id, user, model }, plan)
      },
    })
  })
  const capability = Gateway.decode(prepared.key!)
  expect(capability.permit.sessionID).toBe(f.sessionID)
  expect(capability.permit.rootID).toBe(input.user.id)
  await f.runtime.run(() =>
    ScopeContext.provide({ scope: input.session.scope, workspace: null, fn: () => Cortex.cancel(task.id) }),
  )
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

test("closing the original execution fixture releases native Cortex retention before disposing its Runtime", async () => {
  const f = await executionFixture({ execution: true })
  const owner = f.runtime.run(() => RuntimeContext.current())
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const schedule = setTimeout
  const cancel = clearTimeout
  using scheduling = spyOn(globalThis, "setTimeout").mockImplementation(
    new Proxy(schedule, {
      apply(target, receiver, args) {
        const timer = Reflect.apply(target, receiver, args) as ReturnType<typeof setTimeout>
        if (RuntimeContext.tryCurrent() === owner && (args[1] === 30_000 || args[1] === 300_000)) timers.add(timer)
        return timer
      },
    }),
  )
  using cancelling = spyOn(globalThis, "clearTimeout").mockImplementation(
    new Proxy(cancel, {
      apply(target, receiver, args) {
        timers.delete(args[0])
        return Reflect.apply(target, receiver, args)
      },
    }),
  )
  try {
    const input = await materialize(f)
    await f.runtime.run(() =>
      ScopeContext.provide({
        scope: input.session.scope,
        workspace: null,
        fn: async () => {
          const task = await Cortex.prepare({
            description: "Original execution retention",
            prompt: "Retain the actual admitted child",
            agent: input.user.agent,
            parentSessionID: f.sessionID,
            parentMessageID: input.user.id,
            notifyParentOnComplete: false,
          })
          await Cortex.cancel(task.id)
          expect(Cortex.get(task.id)?.status).toBe("cancelled")
        },
      }),
    )
    expect(timers.size).toBe(2)
    await f[Symbol.asyncDispose]()
    expect(() => f.runtime.run(() => {})).toThrow("Runtime is closed")
    expect(timers.size).toBe(0)
  } finally {
    try {
      await f[Symbol.asyncDispose]()
    } finally {
      for (const timer of timers) cancel(timer)
    }
  }
})
