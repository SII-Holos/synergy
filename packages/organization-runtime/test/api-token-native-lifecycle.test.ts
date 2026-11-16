import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { z } from "zod"
import {
  OrganizationApiTokenProtocol as Token,
  OrganizationCommandProtocol as Command,
  OrganizationPublicationProtocol as Publication,
} from "@ericsanchezok/synergy-organization-protocol"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { cloudExecutionFixture } from "./support/cloud-execution"

type Fixture = Awaited<ReturnType<typeof cloudExecutionFixture>>
type Member = Awaited<ReturnType<Fixture["member"]>>

async function publishNativeArtifact(f: Fixture, member: Member, sessionID: string) {
  const human = { headers: f.service.headers, throwOnError: true as const }
  const bytes = new Uint8Array(Publication.chunkBytes + 17).fill(73)
  const native = await member.runtime.run(async () => {
    const session = await Session.get(sessionID)
    const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID }
    const artifact = await RolloutArtifact.write(
      owner,
      (async function* () {
        for (let offset = 0; offset < bytes.length; offset += 65536) yield bytes.subarray(offset, offset + 65536)
      })(),
      "application/octet-stream",
    )
    if (artifact.status !== "complete" || !artifact.sha256)
      throw new Error("The actual native Session artifact is not complete")
    return { owner, artifact, hash: artifact.sha256 }
  })
  const upload = (
    await f.service.client.orgPublications.createUpload(
      {
        requestID: "external-native-upload",
        purpose: "artifact",
        scope: { kind: "project", projectID: f.project.projectID },
        sourceSessionID: sessionID,
      },
      human,
    )
  ).data
  const file = (
    await f.service.client.orgPublications.putFile(
      {
        uploadID: upload.uploadID,
        path: "result.bin",
        bytes: native.artifact.bytes,
        sha256: native.hash,
        mediaType: native.artifact.mediaType,
      },
      human,
    )
  ).data
  await member.runtime.run(async () => {
    let offset = 0
    let buffered = 0
    let parts: Uint8Array[] = []
    async function publishChunk() {
      if (!buffered) return
      const body = Buffer.concat(parts)
      await f.service.client.orgPublications.putChunk(
        { uploadID: upload.uploadID, fileID: file.fileID, offset, body: new Blob([new Uint8Array(body)]) },
        human,
      )
      offset += body.length
      parts = []
      buffered = 0
    }
    for await (const part of RolloutArtifact.read(native.owner, native.artifact)) {
      parts.push(part)
      buffered += part.length
      if (buffered === Publication.chunkBytes) await publishChunk()
      if (buffered > Publication.chunkBytes) throw new Error("The native artifact exceeded its publication window")
    }
    await publishChunk()
    expect(offset).toBe(bytes.length)
  })
  await f.service.client.orgPublications.seal(
    { uploadID: upload.uploadID, fileCount: 1, totalBytes: bytes.length },
    human,
  )
  const artifact = (
    await f.service.client.orgArtifacts.publish(
      {
        requestID: "external-native-artifact",
        artifactID: "external-native-result",
        expectedRevision: 0,
        uploadID: upload.uploadID,
        title: "Original native external work",
      },
      human,
    )
  ).data
  expect(artifact.sourceSessionID).toBe(sessionID)
  return {
    bytes,
    hash: native.hash,
    manifestHash: artifact.manifestHash,
    target: { artifactID: artifact.artifactID, version: artifact.version, fileID: file.fileID },
  }
}

test.skipIf(process.platform === "win32")(
  "one external API token owns creation, unknown receipt recovery, physical cancellation and retained artifact reads",
  async () => {
    const f = await cloudExecutionFixture({ modelContext: 131072 })
    const failures: unknown[] = []
    try {
      const member = await f.member("external-native-owner")
      const human = { headers: f.service.headers, throwOnError: true as const }
      const issued = Token.Created.parse(
        (
          await f.service.client.orgApiTokens.create(
            {
              orgApiTokenCreate: {
                requestID: "external-native-token",
                projectID: f.project.projectID,
                label: "External lifecycle integration",
                operations: [
                  "sessions.create",
                  "sessions.configure",
                  "sessions.input",
                  "sessions.cancel",
                  "sessions.read",
                  "artifacts.read",
                ],
                expiresAt: Date.now() + 60_000,
              },
            },
            human,
          )
        ).data,
      )
      const token = Token.Secret.parse(issued.token)
      const api = { headers: { authorization: `Bearer ${token}` }, throwOnError: true as const }
      const creation = {
        orgCommandCreateRequest: {
          schemaVersion: 1 as const,
          orgID: f.service.identity.orgID,
          projectID: f.project.projectID,
          runtimeID: member.registration.runtimeID,
          requestID: "external-native-create",
          creation: { operation: "create" as const, title: "External native lifecycle" },
        },
      }
      const created = await f.service.client.orgSessions.create(creation, api)
      expect(created.response.status).toBe(202)
      const sessionID = created.data.effect.sessionID
      expect((await f.service.client.orgSessions.create(creation, api)).data.effect.sessionID).toBe(sessionID)
      await f.service.client.orgSessionResources.set(
        {
          sessionID,
          orgSessionResourceChange: {
            expectedRevision: 0,
            selection: {
              modelResourceID: f.model.resourceID,
              connectionResourceIDs: [],
              infrastructure: {
                workspace: { resourceID: f.storage.resourceID, workspaceID: f.workspace.workspaceID },
                environment: { resourceID: f.compute.resourceID, environmentID: f.environment.environmentID },
              },
            },
          },
        },
        api,
      )
      let lost = false
      f.service.interceptHTTP(async (request) => {
        if (
          lost ||
          request.method !== "POST" ||
          new URL(request.url).pathname !== `/org/v1/sessions/${sessionID}/commands`
        )
          return
        lost = true
        expect((await f.service.service.fetch(request)).status).toBe(202)
        return Response.json(
          {
            code: "SERVICE_UNAVAILABLE",
            outcome: "unknown",
            retryable: false,
            message: "Fixture HTTPS acknowledgement loss",
          },
          { status: 503 },
        )
      })
      const input = {
        sessionID,
        orgCommandInputRequest: {
          schemaVersion: 1 as const,
          orgID: f.service.identity.orgID,
          projectID: f.project.projectID,
          runtimeID: member.registration.runtimeID,
          sessionID,
          requestID: "external-native-task",
          input: {
            operation: "input" as const,
            mode: "task" as const,
            parts: [{ type: "text" as const, text: "Produce the externally requested native work" }],
          },
        },
      }
      const unknown = await f.service.client.orgCommands.input(input, { headers: api.headers })
      expect(unknown.response.status).toBe(503)
      expect(unknown.error).toMatchObject({ outcome: "unknown" })
      const receipt = (await f.service.client.orgCommands.lookup({ requestID: "external-native-task" }, api)).data
      expect(receipt.state).toBe("accepted")
      const accepted = Command.InputAccepted.parse(receipt.accepted)
      expect(accepted.permit.actor).toMatchObject({
        subjectID: f.service.identity.accountID,
        clientKind: "api",
        tokenID: issued.metadata.tokenID,
      })
      expect((await f.service.client.orgCommands.input(input, api)).response.status).toBe(200)
      expect(
        (
          await f.service.client.orgCommands.input(
            {
              ...input,
              orgCommandInputRequest: {
                ...input.orgCommandInputRequest,
                input: { ...input.orgCommandInputRequest.input, parts: [{ type: "text", text: "Changed payload" }] },
              },
            },
            { headers: api.headers },
          )
        ).response.status,
      ).toBe(409)
      await member.runtime.run(async () => {
        const queue = await SessionInbox.list(sessionID)
        expect(queue).toHaveLength(1)
        expect(queue[0]?.message?.actor).toMatchObject({ clientKind: "api", tokenID: issued.metadata.tokenID })
      })
      const selected = await member.attachQueued(sessionID, accepted)
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      const program =
        "process.stdout.write('EXTERNAL_NATIVE_READY\\n'); await new Promise(resolve => process.stdin.once('data', resolve));"
      const command = await selected.bash(`${quote(process.execPath)} -e ${quote(program)}`)
      await f.waitForOutput(command.executionID, "EXTERNAL_NATIVE_READY")
      const physical = await f.physical(command.executionID)
      expect(physical.execution.state).toBe("running")
      expect(physical.uses.some((use) => use.kind === "operation" && use.ownership.kind === "execution")).toBe(true)
      expect((await f.service.client.orgSessions.get({ sessionID }, api)).response.status).toBe(200)
      const artifact = await publishNativeArtifact(f, member, sessionID)
      expect((await f.service.client.orgArtifacts.version(artifact.target, api)).data.manifestHash).toBe(
        artifact.manifestHash,
      )
      const content = await f.service.client.orgArtifacts.content(artifact.target, { ...api, parseAs: "arrayBuffer" })
      expect(content.response.status).toBe(200)
      expect(
        createHash("sha256")
          .update(Buffer.from(z.instanceof(ArrayBuffer).parse(content.data)))
          .digest("hex"),
      ).toBe(artifact.hash)
      const range = await f.service.client.orgArtifacts.content(artifact.target, {
        ...api,
        headers: { ...api.headers, range: "bytes=2-5" },
        parseAs: "arrayBuffer",
      })
      expect(range.response.status).toBe(206)
      expect(new Uint8Array(z.instanceof(ArrayBuffer).parse(range.data))).toEqual(artifact.bytes.slice(2, 6))
      expect((await f.service.client.orgApiTokens.list({}, { headers: api.headers })).response.status).toBe(403)
      const gate = f.holdCancelOnce()
      try {
        const cancellation = {
          sessionID,
          orgCommandControlRequest: {
            schemaVersion: 1 as const,
            orgID: f.service.identity.orgID,
            projectID: f.project.projectID,
            runtimeID: member.registration.runtimeID,
            sessionID,
            requestID: "external-native-cancel",
            control: { operation: "cancel" as const, runID: accepted.effect.messageID, controlVersion: 0 },
          },
        }
        const cancelled = Command.ControlAccepted.parse(
          (await f.service.client.orgCommands.control(cancellation, api)).data,
        )
        expect(cancelled.effect).toMatchObject({
          operation: "cancel",
          runID: accepted.effect.messageID,
          runStatusAtReception: "running",
          cancelRequestedAt: expect.any(Number),
        })
        const timeout = Promise.withResolvers<never>()
        const timer = setTimeout(
          () => timeout.reject(new Error("The original physical cancellation did not enter its finite gate")),
          5000,
        )
        let pending: Awaited<typeof gate.entered>
        try {
          pending = await Promise.race([gate.entered, timeout.promise])
        } finally {
          clearTimeout(timer)
        }
        expect(pending.id).toBe(physical.execution.id)
        expect(pending.digest).toBe(physical.execution.digest)
        expect(pending.target).toEqual(physical.execution.target)
        expect(await f.observation(command.executionID)).toMatchObject({
          state: "running",
          treeDrained: false,
          streamsDrained: false,
        })
        expect(
          (await f.physical(command.executionID)).uses.some(
            (use) => use.kind === "operation" && use.ownership.kind === "execution",
          ),
        ).toBe(true)
        expect((await f.service.client.orgCommands.control(cancellation, api)).data).toEqual(cancelled)
        gate.release()
        const deadline = Date.now() + 5000
        for (;;) {
          const current = await f.physical(command.executionID)
          const run = await selected.runtime.run(async () =>
            RolloutLedger.getRun(RolloutLifecycle.owner(await Session.get(sessionID)), accepted.effect.messageID),
          )
          if (current.execution.state === "completed" && run.status === "cancelled") {
            expect(current.execution.status).toMatchObject({ treeDrained: true, streamsDrained: true })
            expect(current.uses.some((use) => use.kind === "operation" && use.ownership.kind === "execution")).toBe(
              false,
            )
            break
          }
          if (Date.now() >= deadline)
            throw new Error(
              "Original cancellation did not finish native drainage: " +
                JSON.stringify({
                  execution: current.execution.state,
                  native: current.execution.status?.state,
                  run: run.status,
                  recording: run.recording,
                }),
            )
          await Bun.sleep(10)
        }
      } finally {
        gate.release()
      }
      expect(f.nativeStarts()).toBe(1)
      expect(f.nativeEffects(physical.execution.id).cancel).toBeGreaterThan(0)
      await selected.finalizeTerminalTask()
      await selected.finalizeTerminalTask()
      await member.close()
      expect(
        (
          await f.service.client.orgSessions.create(
            { orgCommandCreateRequest: { ...creation.orgCommandCreateRequest, requestID: "external-native-offline" } },
            { headers: api.headers },
          )
        ).response.status,
      ).toBe(503)
      const retained = await f.service.client.orgArtifacts.content(artifact.target, { ...api, parseAs: "arrayBuffer" })
      expect(retained.response.status).toBe(200)
      expect(
        createHash("sha256")
          .update(Buffer.from(z.instanceof(ArrayBuffer).parse(retained.data)))
          .digest("hex"),
      ).toBe(artifact.hash)
      expect(
        (
          await f.service.client.orgApiTokens.revoke(
            { tokenID: issued.metadata.tokenID, orgApiTokenRevoke: { expectedRevision: 1 } },
            human,
          )
        ).response.status,
      ).toBe(200)
      expect(
        (await f.service.client.orgCommands.lookup({ requestID: "external-native-task" }, { headers: api.headers }))
          .response.status,
      ).toBe(401)
      expect(
        (await f.service.client.orgArtifacts.content(artifact.target, { headers: api.headers, parseAs: "arrayBuffer" }))
          .response.status,
      ).toBe(401)
    } catch (error) {
      failures.push(error)
    }
    try {
      await f[Symbol.asyncDispose]()
    } catch (error) {
      failures.push(error)
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, "External API lifecycle and original native cleanup failed")
  },
  30000,
)
