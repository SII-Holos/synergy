import { expect, test } from "bun:test"
import path from "node:path"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { SessionInteraction } from "@ericsanchezok/synergy-harness/session/interaction"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { Question } from "@ericsanchezok/synergy-local-runtime/question"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { prepareMemberHome } from "../src/home"
import { enrollMemberRuntime } from "../src/enrollment"
import { readMemberRegistration } from "../src/registration"
import { openMemberRuntime } from "../src/runtime"
import { fixture } from "./support/organization"

test("generated HTTPS confirmation pages cross the native bridge and report real winners without question answers", async () => {
  await using service = await fixture()
  const member = await prepareMemberHome({
    baseDirectory: path.join(service.root, "members"),
    identity: service.identity,
    origin: service.origin,
  })
  await enrollMemberRuntime({
    home: member.home,
    identity: member.identity,
    ticket: await service.ticket(member.identity.deviceID, member.publicKey),
    ca: service.ca,
  })
  const registration = (await readMemberRegistration(member.home, member.identity))!
  const options = { headers: service.headers, throwOnError: true as const }
  const project = (
    await service.client.orgProjects.create({ orgProjectCreate: { name: "Confirmations", description: "" } }, options)
  ).data
  const online = Promise.withResolvers<void>()
  service.interceptFrames((_socket, frame) => {
    if (JSON.parse(String(frame)).type === "heartbeat") online.resolve()
    return false
  })
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = probe.port!
  await probe.stop(true)
  await using runtime = await openMemberRuntime({
    home: member.home,
    identity: member.identity,
    ca: service.ca,
    listen: { port, token: "c".repeat(64) },
  })
  const timer = setTimeout(() => online.reject(new Error("Native confirmation bridge did not connect")), 3000)
  try {
    await online.promise
  } finally {
    clearTimeout(timer)
  }
  const created = (
    await service.client.orgSessions.create(
      {
        orgCommandCreateRequest: {
          schemaVersion: 1,
          orgID: member.identity.orgID,
          projectID: project.projectID,
          runtimeID: registration.runtimeID,
          requestID: "interaction-create",
          creation: { operation: "create" },
        },
      },
      options,
    )
  ).data
  const sessionID = created.effect.sessionID
  const questionText = "Confirmation context ".repeat(5000)
  const native = await runtime.run(async () => {
    const session = await Session.get(sessionID)
    return ScopeContext.provide({
      scope: session.scope,
      workspace: null,
      fn: async () => {
        await Session.update(sessionID, (draft) => {
          draft.interaction = SessionInteraction.interactive("fixture")
        })
        const controller = new AbortController()
        const asked = Promise.withResolvers<string>()
        const unsubscribe = Bus.subscribe(Question.Event.Asked, ({ properties }) => {
          if (properties.sessionID === sessionID) asked.resolve(properties.id)
        })
        const permission = PermissionNext.ask({
          id: "permission-native-http",
          sessionID,
          permission: "bash",
          patterns: ["fixture *"],
          metadata: { privateMetadata: "must-stay-native" },
          ruleset: [],
          signal: controller.signal,
        })
        const question = Question.ask({
          sessionID,
          questions: [{ question: questionText, header: "Fixture", options: [], input_type: "password" }],
          signal: controller.signal,
        })
        void permission.catch(() => {})
        void question.catch(() => {})
        return { session, controller, unsubscribe, permission, question, questionID: await asked.promise }
      },
    })
  })
  try {
    const first = (
      await service.client.orgSessionInteractions.list(
        { sessionID, orgInteractionQuery: { operation: "pending", rootSessionID: sessionID, limit: 1 } },
        options,
      )
    ).data
    if (first.operation !== "pending") throw new Error("Expected pending confirmations")
    expect(first.items).toHaveLength(1)
    expect(first.runtimeKind).toBe("member")
    expect(first.hasMore).toBeTrue()
    const second = (
      await service.client.orgSessionInteractions.list(
        {
          sessionID,
          orgInteractionQuery: { operation: "pending", rootSessionID: sessionID, limit: 1, cursor: first.cursor },
        },
        options,
      )
    ).data
    if (second.operation !== "pending") throw new Error("Expected next confirmations")
    const entries = [...first.items, ...second.items]
    expect(entries.find((entry) => entry.kind === "question")?.questions[0]?.question).toBe(questionText)
    expect(JSON.stringify(entries)).not.toContain("must-stay-native")
    await service.client.orgSessionInteractions.reply(
      {
        sessionID,
        orgCommandDecisionRequest: {
          schemaVersion: 1,
          orgID: member.identity.orgID,
          projectID: project.projectID,
          runtimeID: registration.runtimeID,
          sessionID,
          requestID: "interaction-answer",
          decision: {
            operation: "decision",
            kind: "question",
            requestID: native.questionID,
            reply: "answer",
            answers: [["private-original-answer"]],
          },
        },
      },
      options,
    )
    expect(await native.question).toEqual([["private-original-answer"]])
    const decisions = (
      await service.client.orgSessionInteractions.list(
        {
          sessionID,
          orgInteractionQuery: {
            operation: "decisions",
            rootSessionID: sessionID,
            identities: [
              { kind: "question", requestID: native.questionID },
              { kind: "permission", requestID: "permission-native-http" },
              { kind: "question", requestID: "question-old-expired" },
            ],
          },
        },
        options,
      )
    ).data
    if (decisions.operation !== "decisions") throw new Error("Expected native decision identities")
    expect(decisions.items.map((entry) => entry.state)).toEqual(["resolved", "pending", "expired"])
    expect(JSON.stringify(decisions)).not.toContain("private-original-answer")
  } finally {
    await runtime.run(() =>
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
