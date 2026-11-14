import { expect, test } from "bun:test"
import path from "node:path"
import { z } from "zod"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import type { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { ToolDiscovery } from "@ericsanchezok/synergy-harness/test/internal/tool/discovery"
import { ToolPolicySource } from "@ericsanchezok/synergy-harness/tool/policy-source"
import { ProcessAccessSource } from "@ericsanchezok/synergy-harness/process/access-source"
import { OrganizationRuntimeProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { prepareHostedHome } from "../src/home"
import { enrollHostedRuntime } from "../src/enrollment"
import { openHostedRuntime } from "../src/runtime"
import { fixture } from "./support/organization"

const model: Provider.Model = {
  id: "fixture",
  providerID: "fixture",
  name: "Fixture",
  family: "fixture",
  api: { id: "fixture", url: "https://example.invalid", npm: "fixture" },
  capabilities: {
    temperature: false,
    reasoning: false,
    attachment: false,
    toolcall: true,
    interleaved: false,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 8192, output: 1024 },
  status: "active",
  options: {},
  headers: {},
  release_date: "",
}

test("the actual Hosted catalog and execution gate reject unowned global tools while retaining Session and Cortex capabilities", async () => {
  await using service = await fixture()
  const options = { headers: service.headers, throwOnError: true as const }
  const home = await prepareHostedHome({
    baseDirectory: path.join(service.root, "hosted"),
    identity: { orgID: service.identity.orgID, hostID: "tool-policy-host" },
    origin: service.origin,
  })
  const ticket = (
    await service.client.orgRuntime.registerHosted(
      { orgHostedRuntimeRegistration: { name: "Tool policy host", publicKey: home.publicKey } },
      options,
    )
  ).data
  const registration = await enrollHostedRuntime({ home: home.home, identity: home.identity, ticket, ca: service.ca })
  const online = Promise.withResolvers<void>()
  service.interceptFrames((_socket, frame) => {
    if (Protocol.ClientFrame.parse(JSON.parse(String(frame))).type === "heartbeat") online.resolve()
    return false
  })
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = probe.port
  if (!port) throw new Error("The isolated Hosted listener did not reserve a port")
  await probe.stop(true)
  await using runtime = await openHostedRuntime({
    home: home.home,
    identity: home.identity,
    ca: service.ca,
    listen: { port, token: "e".repeat(64) },
  })
  const timer = setTimeout(() => online.reject(new Error("The actual Hosted Runtime did not connect")), 4000)
  try {
    await online.promise
  } finally {
    clearTimeout(timer)
    service.interceptFrames(undefined)
  }
  const project = (
    await service.client.orgProjects.create({ orgProjectCreate: { name: "Tool boundary", description: "" } }, options)
  ).data
  const created = (
    await service.client.orgSessions.create(
      {
        orgCommandCreateRequest: {
          schemaVersion: 1,
          orgID: service.identity.orgID,
          projectID: project.projectID,
          runtimeID: registration.runtimeID,
          requestID: "tool-policy-session",
          creation: { operation: "create", title: "Tool boundary" },
        },
      },
      options,
    )
  ).data
  await runtime.run(async () => {
    const session = await Session.get(created.effect.sessionID)
    await ScopeContext.provide({
      scope: session.scope,
      workspace: null,
      fn: async () => {
        const agent = await Agent.get(PrimaryAgentIdentity.names.general)
        if (!agent) throw new Error("The actual composition did not provide its primary Agent")
        await ToolRegistry.register(
          Tool.define(
            "unowned_history_probe",
            {
              description: "An unreviewed cross-object capability",
              parameters: z.object({}),
              async execute() {
                throw new Error("The unowned capability must never be dispatched")
              },
            },
            { exposure: { mode: "group", group: "session" } },
          ),
        )
        const registered = await ToolRegistry.ids()
        for (const id of ["session_read", "session_list", "session_send", "task_output", "unowned_history_probe"])
          expect(registered).toContain(id)
        const catalog = await ToolDiscovery.collect({
          providerID: model.providerID,
          model,
          agent,
          session,
          includeMCP: false,
        })
        const visible = catalog.tools.filter((tool) => !catalog.disabled.has(tool.id)).map((tool) => tool.id)
        for (const id of [
          "session_read",
          "task",
          "task_list",
          "task_output",
          "task_cancel",
          "organization_knowledge",
          "process",
        ])
          expect(visible).toContain(id)
        expect(ProcessAccessSource.has()).toBe(true)
        const blocked = [
          "session_list",
          "session_search",
          "session_send",
          "scope_list",
          "runtime_reload",
          "agent_config",
          "unowned_history_probe",
        ]
        for (const id of blocked) {
          expect(visible).not.toContain(id)
          if (catalog.tools.some((tool) => tool.id === id)) expect(catalog.disabled.has(id)).toBe(true)
          await expect(
            ToolPolicySource.authorize({
              toolID: id,
              sessionID: session.id,
              messageID: "msg_direct_tool_attempt",
              callID: `call_${id}`,
              args: { target: session.id },
              signal: new AbortController().signal,
            }),
          ).rejects.toBeInstanceOf(ToolPolicySource.DeniedError)
        }
        for (const id of ["session_read", "task_output", "process"])
          await expect(
            ToolPolicySource.authorize({
              toolID: id,
              sessionID: session.id,
              messageID: "msg_owned_tool_attempt",
              callID: `call_${id}`,
              args: {},
              signal: new AbortController().signal,
            }),
          ).resolves.toBeUndefined()
        let processInspected = false
        await expect(
          ProcessAccessSource.withAccess({ signal: new AbortController().signal }, async () => {
            processInspected = true
          }),
        ).rejects.toThrow("genuine current Session Run")
        expect(processInspected).toBe(false)
        await expect(
          ToolDiscovery.collect({ providerID: model.providerID, model, agent, includeMCP: false }),
        ).rejects.toBeInstanceOf(ToolPolicySource.DeniedError)
      },
    })
  })
}, 15_000)
