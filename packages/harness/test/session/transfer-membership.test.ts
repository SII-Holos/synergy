import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Session } from "../../src/session"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"
import { SessionTransferCore as Core } from "../../src/session/transfer-core"
import { SessionTransferAggregate as Aggregate } from "../../src/session/transfer-aggregate"
import type { SessionTransferOwners as Owners } from "../../src/session/transfer-owners"

test("sealed aggregate edges reject a wholly omitted child and unrelated or cyclic canonical members", async () => {
  await using runtime = await testRuntime({ register: Core.register })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspace: null, environmentID: null })
        const child = await Session.create({ workspace: null, environmentID: null, parentID: root.id })
        const sibling = await Session.create({ workspace: null, environmentID: null, parentID: root.id })
        const handoffID = "complete-membership"
        const contexts: Owners.SourceContext[] = []
        for (const session of [root, child, sibling])
          await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
        for (const session of [root, child, sibling]) {
          await Epochs.freeze({
            sessionID: session.id,
            scopeID: "home",
            rootSessionID: root.id,
            handoffID,
            sourceID: "A",
            targetID: "B",
            fromEpoch: 1,
            toEpoch: 2,
          })
          contexts.push({
            session: await Session.get(session.id),
            handoffID,
            rootSessionID: root.id,
            signal: new AbortController().signal,
          })
        }
        const captured: Aggregate.Node[] = []
        for (const context of contexts) captured.push(await Aggregate.capture(context))
        const members = (omit?: string) =>
          (async function* () {
            for (let index = 0; index < contexts.length; index++) {
              const context = contexts[index]
              if (context.session.id === omit) continue
              yield {
                identity: {
                  sessionID: context.session.id,
                  scopeID: context.session.scope.id,
                  parentID: context.session.parentID,
                },
                owners: captured[index].owners,
                node: captured[index],
                edges: Aggregate.edges(context),
              }
            }
          })()
        const input = { handoffID, rootSessionID: root.id, scopeID: "home", signal: new AbortController().signal }
        expect(await Aggregate.validate({ ...input, members: members() })).toMatchObject({ members: 3 })
        await expect(Aggregate.validate({ ...input, members: members(child.id) })).rejects.toThrow("child")
        await expect(
          Aggregate.validate({
            ...input,
            members: (async function* () {
              for await (const member of members())
                yield member.identity.sessionID === child.id
                  ? { ...member, identity: { ...member.identity, scopeID: "foreign" } }
                  : member
            })(),
          }),
        ).rejects.toThrow("Scope")
        await expect(
          Aggregate.validate({
            ...input,
            members: (async function* () {
              for await (const member of members())
                yield member.identity.sessionID === root.id
                  ? {
                      ...member,
                      identity: { ...member.identity, parentID: child.id },
                      node: { ...member.node, parentID: child.id },
                    }
                  : member
            })(),
          }),
        ).rejects.toThrow("root")
        await expect(
          Aggregate.validate({
            ...input,
            members: (async function* () {
              for await (const member of members()) {
                const id = member.identity.sessionID
                const parentID = id === root.id ? undefined : id === child.id ? sibling.id : child.id
                const nextChild = id === root.id ? undefined : id === child.id ? sibling.id : child.id
                yield {
                  ...member,
                  identity: { ...member.identity, parentID },
                  node: { ...member.node, parentID, children: nextChild ? 1 : 0 },
                  edges: (async function* () {
                    if (nextChild) yield { kind: "child", ownerID: "session-core", sessionID: nextChild }
                  })(),
                }
              }
            })(),
          }),
        ).rejects.toThrow("cyclic or unreachable")
      },
    }),
  )
})
