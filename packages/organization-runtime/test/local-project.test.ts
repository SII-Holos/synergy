import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { prepareMemberHome } from "../src/home"
import { enrollMemberRuntime } from "../src/enrollment"
import { readMemberRegistration } from "../src/registration"
import { openMemberRuntime } from "../src/runtime"
import { OrganizationLocalProjects as Bindings } from "../src/local-project"
import { fixture } from "./support/organization"

test("signed member creation uses the project's shared native directory and explicit Environment without changing old Sessions", async () => {
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
  const project = (
    await service.client.orgProjects.create(
      { orgProjectCreate: { name: "Native project", description: "" } },
      { headers: service.headers, throwOnError: true },
    )
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
    listen: { port, token: "b".repeat(64) },
  })
  const timer = setTimeout(() => online.reject(new Error("Member was not online")), 3000)
  try {
    await online.promise
  } finally {
    clearTimeout(timer)
  }
  const create = async (requestID: string) => {
    const result = await service.client.orgSessions.create(
      {
        orgCommandCreateRequest: {
          schemaVersion: 1,
          orgID: member.identity.orgID,
          projectID: project.projectID,
          runtimeID: registration.runtimeID,
          requestID,
          creation: { operation: "create", title: requestID },
        },
      },
      { headers: service.headers, throwOnError: true },
    )
    return runtime.run(() => Session.get(result.data.effect.sessionID))
  }
  const original = await create("unbound")
  const first = path.join(service.root, "first")
  const second = path.join(service.root, "second")
  await Promise.all([fs.mkdir(first), fs.mkdir(second)])
  const initial = await runtime.run(() => Bindings.get(project.projectID))
  const bound = await runtime.run(() =>
    Bindings.bind(project.projectID, { requestID: "bind-first", expectedRevision: initial.revision, directory: first }),
  )
  expect(bound.binding?.label).toBe("first")
  expect(JSON.stringify(bound)).not.toContain(first)
  const one = await create("first-one")
  const two = await create("first-two")
  expect(one.workspaceID).toBe(bound.binding!.workspaceID)
  expect(two.workspaceID).toBe(one.workspaceID)
  expect(one.workspace?.path).toBe(await fs.realpath(first))
  expect(one.environmentID).toBeTruthy()
  expect(two.environmentID).toBe(one.environmentID)
  expect(await runtime.run(() => Environment.get(one.environmentID!, project.projectID))).toMatchObject({
    provider: "native",
    state: "idle",
    generation: 0,
    spec: {},
  })
  await expect(
    runtime.run(() =>
      Bindings.bind(project.projectID, { requestID: "stale", expectedRevision: initial.revision, directory: second }),
    ),
  ).rejects.toThrow("changed")
  await runtime.run(() =>
    Bindings.bind(project.projectID, { requestID: "bind-second", expectedRevision: bound.revision, directory: second }),
  )
  const newer = await create("second-one")
  expect(newer.workspaceID).not.toBe(one.workspaceID)
  expect(newer.workspace?.path).toBe(await fs.realpath(second))
  expect((await runtime.run(() => Session.get(original.id))).workspaceID).toBeNull()
  expect((await runtime.run(() => Session.get(one.id))).workspaceID).toBe(one.workspaceID)
  expect((await runtime.run(() => Scope.fromID(project.projectID)))?.id).toBe(project.projectID)
  expect(
    await runtime.run(() =>
      Bindings.bind(project.projectID, {
        requestID: "bind-first",
        expectedRevision: initial.revision,
        directory: first,
      }),
    ),
  ).toEqual(bound)
})
