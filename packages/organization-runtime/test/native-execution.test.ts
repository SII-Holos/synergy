import { expect, test } from "bun:test"
import path from "node:path"
import {
  OrganizationRuntimeProtocol as Protocol,
  OrganizationGatewayProtocol as Gateway,
  OrganizationExecutionProtocol as Execution,
} from "@ericsanchezok/synergy-organization-protocol"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionEvent } from "@ericsanchezok/synergy-harness/session/event"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { prepareMemberHome } from "../src/home"
import { enrollMemberRuntime } from "../src/enrollment"
import { openMemberRuntime } from "../src/runtime"
import { readMemberRegistration } from "../src/registration"
import { fixture } from "./support/organization"

async function observed<T>(promise: Promise<T>) {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => timeout.reject(new Error("Native execution observation timed out")), 4000)
  try {
    return await Promise.race([promise, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

test("accepted organization tasks execute through the native loop and release resources after derived calls drain", async () => {
  const requests: Array<{ authorization: string | null; body: unknown }> = []
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({ authorization: request.headers.get("authorization"), body: await request.json() })
      const events = [
        {
          id: "chat-native",
          created: 1,
          model: "native-model",
          choices: [{ index: 0, delta: { content: "Native answer" }, finish_reason: null }],
        },
        {
          id: "chat-native",
          created: 1,
          model: "native-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        },
      ]
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  try {
    await using f = await fixture()
    const member = await prepareMemberHome({
      baseDirectory: path.join(f.root, "members"),
      identity: f.identity,
      origin: f.origin,
    })
    await enrollMemberRuntime({
      home: member.home,
      identity: member.identity,
      ca: f.ca,
      ticket: await f.ticket(member.identity.deviceID, member.publicKey),
    })
    const registration = (await readMemberRegistration(member.home, member.identity))!
    const online = Promise.withResolvers<void>()
    const released = Promise.withResolvers<Execution.ReleaseReceipt>()
    let releaseAttempts = 0
    const permits: Gateway.Permit[] = []
    f.interceptHTTP(async (request) => {
      if (new URL(request.url).pathname.endsWith("/chat/completions"))
        permits.push(Gateway.decode(request.headers.get("authorization")!.slice("Bearer ".length)).permit)
      if (new URL(request.url).pathname.endsWith("/execution/release")) {
        const response = await f.service.fetch(request)
        releaseAttempts++
        if (response.ok) {
          const receipt = Execution.ReleaseReceipt.parse(await response.clone().json())
          if (releaseAttempts === 1) {
            released.resolve(receipt)
            return new Response("lost release reply", { status: 502 })
          }
          released.resolve(receipt)
        }
        return response
      }
    })
    f.interceptFrames((_socket, raw) => {
      if (Protocol.ClientFrame.parse(JSON.parse(String(raw))).type === "heartbeat") online.resolve()
      return false
    })
    const port = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    const listener = port.port!
    await port.stop(true)
    await using runtime = await openMemberRuntime({
      home: member.home,
      identity: member.identity,
      ca: f.ca,
      listen: { port: listener, token: "e".repeat(64) },
    })
    await observed(online.promise)
    const options = { headers: f.headers, throwOnError: true as const }
    const project = (
      await f.client.orgProjects.create({ orgProjectCreate: { name: "Native execution", description: "" } }, options)
    ).data
    const model = (
      await f.client.orgResources.create(
        {
          orgResourceCreate: {
            name: "Native model",
            scope: { kind: "organization" },
            configuration: {
              protocol: "openai-compatible",
              endpoint: new URL("/v1", upstream.url).href,
              model: { id: "native-model", name: "Native", limit: { context: 128000, output: 4096 } },
            },
            credential: { kind: "bearer", value: "native-upstream-secret" },
          },
        },
        options,
      )
    ).data
    await f.client.orgResourceGrants.set(
      {
        resourceID: model.resourceID,
        kind: "account",
        subjectID: f.identity.accountID,
        orgResourceGrantChange: { expectedRevision: 0, enabled: true },
      },
      options,
    )
    const created = (
      await f.client.orgSessions.create(
        {
          orgCommandCreateRequest: {
            schemaVersion: 1,
            orgID: f.identity.orgID,
            projectID: project.projectID,
            runtimeID: registration.runtimeID,
            requestID: "native-execution-session",
            creation: { operation: "create" },
          },
        },
        options,
      )
    ).data
    const sessionID = created.effect.sessionID
    await f.client.orgSessionResources.set(
      {
        sessionID,
        orgSessionResourceChange: {
          expectedRevision: 0,
          selection: {
            modelResourceID: model.resourceID,
            connectionResourceIDs: [],
            infrastructure: { workspace: null, environment: null },
          },
        },
      },
      options,
    )
    const completion = Promise.withResolvers<{ rootID: string; assistantID: string }>()
    const unsubscribe = await runtime.run(() =>
      Bus.subscribeGlobal(SessionEvent.RootCompleted, (event) => {
        if (event.properties.sessionID === sessionID) completion.resolve(event.properties)
      }),
    )
    try {
      const accepted = (
        await f.client.orgCommands.input(
          {
            sessionID,
            orgCommandInputRequest: {
              schemaVersion: 1,
              orgID: f.identity.orgID,
              projectID: project.projectID,
              runtimeID: registration.runtimeID,
              sessionID,
              requestID: "native-execution-task",
              input: {
                operation: "input",
                mode: "task",
                parts: [{ type: "text", text: "Reply to this organization task" }],
              },
            },
          },
          options,
        )
      ).data
      expect(accepted.effect).toMatchObject({ kind: "inbox", mode: "task" })
      const completed = await observed(completion.promise)
      await runtime.run(async () => {
        const session = await Session.get(sessionID)
        expect(session.modelSelection?.selected.model).toEqual({
          providerID: `organization-${model.resourceID}`,
          modelID: "native-model",
        })
        const owner = RolloutLifecycle.owner(session)
        expect(await RolloutLedger.getRun(owner, completed.rootID)).toMatchObject({ status: "completed" })
        const calls = await RolloutLedger.calls(owner, completed.rootID)
        expect(calls.filter((call) => call.usageRole === "conversation")).toHaveLength(1)
        expect(calls.some((call) => call.usageRole === "auxiliary")).toBeTrue()
        expect(calls).toHaveLength(requests.length)
        for (const call of calls)
          expect(call).toMatchObject({
            status: "completed",
            transportCaptured: true,
            sdkUsage: { inputTokens: 4, outputTokens: 2 },
          })
        await ScopeContext.provide({
          scope: session.scope,
          workspace: null,
          fn: async () => {
            expect(Object.keys(await Provider.list())).toEqual([`organization-${model.resourceID}`])
          },
        })
      })
      expect(permits).toHaveLength(requests.length)
      expect(new Set(permits.map((permit) => permit.callID)).size).toBe(permits.length)
      for (const permit of permits)
        expect(permit).toMatchObject({ sessionID, rootID: completed.rootID, resourceID: model.resourceID })
      for (const request of requests)
        expect(request).toMatchObject({
          authorization: "Bearer native-upstream-secret",
          body: { model: "native-model", stream: true },
        })
      expect(await observed(released.promise)).toMatchObject({
        sessionID,
        rootID: completed.rootID,
        generation: 1,
        outcome: "completed",
      })
      expect(releaseAttempts).toBe(1)
      const selection = await f.client.orgSessionResources.set(
        {
          sessionID,
          orgSessionResourceChange: {
            expectedRevision: 1,
            selection: {
              modelResourceID: model.resourceID,
              connectionResourceIDs: [],
              infrastructure: { workspace: null, environment: null },
            },
          },
        },
        options,
      )
      expect(selection.data.revision).toBe(2)
    } finally {
      unsubscribe()
    }
  } finally {
    await upstream.stop(true)
  }
}, 10_000)
