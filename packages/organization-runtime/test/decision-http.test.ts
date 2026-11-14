import { expect, test } from "bun:test"
import { OrganizationCommandProtocol as Command } from "@ericsanchezok/synergy-organization-protocol"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { PermissionRules } from "@ericsanchezok/synergy-harness/permission/rules"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { Question } from "@ericsanchezok/synergy-local-runtime/question"
import { executionFixture } from "./support/execution"

test("generated HTTPS replies traverse the actual signed member bridge and settle the native permission and private question", async () => {
  await using f = await executionFixture()
  const native = await f.runtime.run(async () => {
    const session = await Session.get(f.sessionID)
    return ScopeContext.provide({
      scope: session.scope,
      workspace: null,
      fn: async () => {
        const controller = new AbortController()
        const permission = PermissionNext.ask({
          id: "permission-https",
          sessionID: session.id,
          permission: "bash",
          patterns: ["fixture *"],
          metadata: {},
          ruleset: [],
          signal: controller.signal,
        })
        const asked = Promise.withResolvers<string>()
        const unsubscribe = Bus.subscribe(Question.Event.Asked, ({ properties }) => {
          if (properties.sessionID === session.id) asked.resolve(properties.id)
        })
        const question = Question.ask({
          sessionID: session.id,
          questions: [{ question: "Private fixture value", header: "Private", options: [], input_type: "password" }],
          signal: controller.signal,
        })
        return { session, controller, permission, question, questionID: await asked.promise, unsubscribe }
      },
    })
  })
  const request = (requestID: string, decision: Command.Decision): Command.DecisionRequest => ({
    schemaVersion: 1,
    orgID: f.identity.orgID,
    requestID,
    sessionID: f.sessionID,
    projectID: native.session.scope.id,
    runtimeID: f.connection.connected.runtimeID,
    decision,
  })
  const options = { headers: f.headers, throwOnError: true as const }
  try {
    const permission = (
      await f.client.orgSessionInteractions.reply(
        {
          sessionID: f.sessionID,
          orgCommandDecisionRequest: request("permission-http", {
            operation: "decision",
            kind: "permission",
            requestID: "permission-https",
            reply: "always",
          }),
        },
        options,
      )
    ).data
    await native.permission
    expect(permission.effect).toMatchObject({
      kind: "decision",
      decision: {
        status: "resolved",
        winner: { actor: { subjectID: f.identity.accountID }, outcome: { kind: "permission", reply: "always" } },
      },
    })
    expect(await f.runtime.run(() => PermissionRules.userRuleset())).toHaveLength(1)
    const question = (
      await f.client.orgSessionInteractions.reply(
        {
          sessionID: f.sessionID,
          orgCommandDecisionRequest: request("question-http", {
            operation: "decision",
            kind: "question",
            requestID: native.questionID,
            reply: "answer",
            answers: [["private-native-original"]],
          }),
        },
        options,
      )
    ).data
    expect(await native.question).toEqual([["private-native-original"]])
    expect(question.effect).toMatchObject({
      kind: "decision",
      decision: {
        status: "resolved",
        winner: { actor: { subjectID: f.identity.accountID }, outcome: { kind: "question", reply: "answer" } },
      },
    })
    expect(JSON.stringify(question)).not.toContain("private-native-original")
    const query = (await f.client.orgCommands.get({ sessionID: f.sessionID, requestID: "question-http" }, options)).data
    expect(query.accepted).toEqual(question)
    expect(JSON.stringify(query)).not.toContain("private-native-original")
  } finally {
    await f.runtime.run(() =>
      ScopeContext.provide({
        scope: native.session.scope,
        workspace: null,
        fn: async () => {
          native.unsubscribe()
          native.controller.abort()
          await Promise.allSettled([native.permission, native.question])
        },
      }),
    )
  }
})
