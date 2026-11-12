import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { z } from "zod"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk"
import {
  OrganizationCloudProtocol as Cloud,
  OrganizationHandoffProtocol as Handoff,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceMove } from "@ericsanchezok/synergy-harness/workspace/move"
import {
  SessionTransferStaging as Staging,
  SessionTransferWorkspaces as Files,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { WorkspacePortableTree } from "@ericsanchezok/synergy-harness/workspace/portable-tree"
import { WorkspaceArchive } from "@ericsanchezok/synergy-harness/workspace/archive"
import { OrganizationSessionTransfer as Transfer } from "../src/session-transfer"
import { testResources } from "@ericsanchezok/synergy-testing/resources"
import { prepareMemberHome } from "../src/home"
import { enrollMemberRuntime } from "../src/enrollment"
import { openMemberRuntime } from "../src/runtime"
import { fixture } from "./support/organization"

async function port() {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const selected = server.port!
  await server.stop(true)
  return selected
}

for (const scenario of [
  "complete",
  "cancel",
  "lost-publish",
  "retire",
  "grant-revoked",
  "recipient",
  "return-cloud",
] as const)
  test(`consented native files complete one cross-Realm receipt (${scenario})`, async () => {
    await using resources = testResources()
    using wake = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
    const objects = path.join(process.env.SYNERGY_TEST_ROOT!, "handoff-cloud-" + crypto.randomUUID())
    await fs.mkdir(objects)
    resources.defer("cloud objects", () => fs.rm(objects, { recursive: true, force: true }))
    let allocations = 0
    const f = await fixture({
      cloud: {
        blobStores: {
          files: {
            async put(hash, bytes) {
              await Bun.write(path.join(objects, hash), bytes)
            },
            get: (hash) => Bun.file(path.join(objects, hash)).bytes(),
          },
        },
        workspaceProfiles: { standard: { blobStore: "files" } },
        environmentProviders: [
          {
            id: "unused",
            async allocate() {
              allocations++
              throw new Error("File handoff must not allocate compute")
            },
            async inspect() {
              return { state: "unknown" }
            },
            async deallocate() {},
          },
        ],
      },
    })
    resources.defer("organization", () => f[Symbol.asyncDispose]())
    const options = { headers: f.headers, throwOnError: true as const }
    const project = (
      await f.client.orgProjects.create({ orgProjectCreate: { name: "Cloud move", description: "" } }, options)
    ).data
    const model = (
      await f.client.orgResources.create(
        {
          orgResourceCreate: {
            name: "Unused model",
            scope: { kind: "project", projectID: project.projectID },
            configuration: {
              protocol: "openai-compatible",
              endpoint: "https://provider.example/v1",
              model: { id: "fixture", name: "Fixture", limit: { context: 8192, output: 1024 } },
            },
            credential: { kind: "none" },
          },
        },
        options,
      )
    ).data
    const resource = (
      await f.client.orgResources.create(
        {
          orgResourceCreate: {
            name: "Object files",
            scope: { kind: "project", projectID: project.projectID },
            configuration: { protocol: "workspace-storage", profile: "standard" },
            credential: { kind: "none" },
          },
        },
        options,
      )
    ).data
    for (const selected of [model, resource])
      await f.client.orgResourceGrants.set(
        {
          resourceID: selected.resourceID,
          kind: "account",
          subjectID: f.identity.accountID,
          orgResourceGrantChange: { expectedRevision: 0, enabled: true },
        },
        options,
      )
    const cloud = (
      await f.client.orgCloudWorkspaces.create(
        {
          orgCloudWorkspaceCreate: {
            projectID: project.projectID,
            resourceID: resource.resourceID,
            requestID: "target-cloud",
            name: "Destination",
          },
        },
        options,
      )
    ).data
    const before = (
      await f.client.orgCloudWorkspaces.write(
        {
          workspaceID: cloud.workspaceID,
          orgCloudWorkspaceWrite: {
            operationID: "unrelated",
            expectedRevision: cloud.revision,
            path: "keep.txt",
            data: "a2VlcA==",
            expectedVersion: null,
          },
        },
        options,
      )
    ).data
    let recipient = { accountID: f.identity.accountID, headers: f.headers }
    if (scenario === "recipient") {
      const invite = (await f.client.orgInvites.create({ orgInviteCreate: { role: "member" } }, options)).data
      const account = (
        await f.client.orgInvites.consume(
          {
            orgInviteConsume: {
              token: invite.token,
              requestID: "recipient-invite",
              loginName: "recipient",
              displayName: "Recipient",
              password: "recipient integration password",
            },
          },
          { throwOnError: true },
        )
      ).data
      const login = await f.client.orgAuth.login(
        { orgLoginInput: { loginName: "recipient", password: "recipient integration password" } },
        { throwOnError: true },
      )
      recipient = {
        accountID: account.accountID,
        headers: {
          cookie: login.response.headers.get("set-cookie")!.split(";")[0],
          "x-csrf-token": login.data.csrfToken,
        },
      }
      await f.client.orgProjects.member(
        {
          projectID: project.projectID,
          accountID: account.accountID,
          orgProjectMemberChange: { expectedRevision: project.revision, role: "collaborator" },
        },
        options,
      )
      expect(
        (await f.client.orgCloudWorkspaces.get({ workspaceID: cloud.workspaceID }, { headers: recipient.headers }))
          .response.status,
      ).toBe(404)
    }
    async function member(
      deviceID: string,
      token: string,
      account = { accountID: f.identity.accountID, headers: f.headers },
    ) {
      const home = await prepareMemberHome({
        baseDirectory: path.join(f.root, "members"),
        identity: { ...f.identity, accountID: account.accountID, deviceID },
        origin: f.origin,
      })
      const registration = await enrollMemberRuntime({
        home: home.home,
        identity: home.identity,
        ticket: (
          await f.client.orgRuntime.registerMember(
            { orgMemberRuntimeRegistration: { deviceID, publicKey: home.publicKey } },
            { headers: account.headers, throwOnError: true },
          )
        ).data,
        ca: f.ca,
      })
      const connected = Promise.withResolvers<void>()
      const sockets = new Set<unknown>()
      f.interceptFrames((socket, raw) => {
        const frame = Runtime.ClientFrame.parse(JSON.parse(String(raw)))
        if (frame.type === "handshake" && frame.proof.handshake.runtimeID === registration.runtimeID)
          sockets.add(socket)
        if (frame.type === "heartbeat" && sockets.has(socket)) connected.resolve()
        return false
      })
      const listener = { port: await port(), token }
      const input = { home: home.home, identity: home.identity, ca: f.ca, listen: listener, handoff: true as const }
      const runtime = await openMemberRuntime(input)
      resources.defer("member", () => runtime.close())
      const timeout = setTimeout(() => connected.reject(new Error("Member did not connect")), 5000)
      try {
        await connected.promise
      } finally {
        clearTimeout(timeout)
      }
      const client = createSynergyClient({
        baseUrl: `http://127.0.0.1:${listener.port}`,
        headers: { authorization: `Bearer ${token}` },
      })
      return { runtime, client, registration, headers: account.headers }
    }
    const source = await member("native-source", "a".repeat(64))
    const target = await member("cloud-target", "b".repeat(64), recipient)
    f.interceptFrames(undefined)
    const directory = path.join(f.root, "source-directory")
    await fs.mkdir(directory)
    const bytes = new Uint8Array([0, 255, 37, 128, 10])
    await Bun.write(path.join(directory, "private.bin"), bytes)
    await Bun.write(path.join(directory, ".gitignore"), "ignored.txt\n")
    await Bun.write(path.join(directory, "ignored.txt"), "retained ignored bytes")
    const initial = (await source.client.orgLocalProject.get({ projectID: project.projectID }, { throwOnError: true }))
      .data
    const native = (
      await source.client.orgLocalProject.bind(
        {
          projectID: project.projectID,
          orgLocalProjectBind: { requestID: "native-directory", expectedRevision: initial.revision, directory },
        },
        { throwOnError: true },
      )
    ).data.binding!
    const created = (
      await f.client.orgSessions.create(
        {
          orgCommandCreateRequest: {
            schemaVersion: 1,
            orgID: f.identity.orgID,
            projectID: project.projectID,
            runtimeID: source.registration.runtimeID,
            requestID: "create-native-session",
            creation: { operation: "create" },
          },
        },
        options,
      )
    ).data
    const sessionID = created.effect.sessionID
    if (scenario === "recipient")
      await f.client.orgSessions.share({ sessionID, orgShareChange: { expectedShareGeneration: 0 } }, options)
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
    const original = await source.runtime.run(() => Session.get(sessionID))
    expect(original.workspaceID).toBe(native.workspaceID)
    if (scenario === "complete") {
      const query = { sessionID, requestID: "generated-inspection", targetRuntimeID: target.registration.runtimeID }
      const generated = await f.client.orgHandoff.options(query, { headers: f.headers })
      expect(generated.response.status, JSON.stringify(generated.error)).toBe(200)
      const held = Promise.withResolvers<void>()
      let deliver: (() => unknown) | undefined
      f.interceptFrames((socket, raw) => {
        const frame = Runtime.ClientFrame.parse(JSON.parse(String(raw)))
        if (
          frame.type !== "receipt" ||
          frame.reply.kind !== "handoff-inspection" ||
          frame.reply.result.role !== "target"
        )
          return false
        deliver = () => f.service.websocket.message(socket, typeof raw === "string" ? raw : Buffer.from(raw))
        held.resolve()
        return true
      })
      const stale = f.client.orgHandoff.options(
        { sessionID, requestID: "inspect-before-share", targetRuntimeID: target.registration.runtimeID },
        { headers: f.headers },
      )
      await held.promise
      await f.client.orgSessions.share({ sessionID, orgShareChange: { expectedShareGeneration: 0 } }, options)
      f.interceptFrames(undefined)
      deliver!()
      const invalidated = await stale
      expect(invalidated.response.status).toBe(409)
      expect(invalidated.error).toMatchObject({ code: "STALE_BINDING" })
      const inspect = await f.client.orgHandoff.options(
        { sessionID, requestID: "inspect-before-prepare", targetRuntimeID: target.registration.runtimeID },
        { headers: f.headers },
      )
      expect(inspect.response.status, JSON.stringify(inspect.error)).toBe(200)
      const selection = Handoff.Options.parse(inspect.data)
      expect(selection).toMatchObject({
        sessionID,
        projectID: project.projectID,
        bindingEpoch: 1,
        controlRevision: 0,
        sourceRuntimeID: source.registration.runtimeID,
        targetRuntimeID: target.registration.runtimeID,
        source: { kind: "native", reference: { workspaceID: native.workspaceID, generation: native.generation } },
        native: null,
      })
      expect(JSON.stringify(selection)).not.toContain(directory)
      expect((await f.client.orgHandoff.list({ sessionID }, options)).data.items).toEqual([])
      expect((await source.runtime.run(() => Session.get(sessionID))).paused).toEqual(original.paused)
      expect(allocations).toBe(0)
    }
    if (scenario === "recipient") {
      const response = await f.client.orgHandoff.options(
        { sessionID, requestID: "recipient-inspection", targetRuntimeID: target.registration.runtimeID },
        { headers: target.headers },
      )
      expect(response.response.status).toBe(403)
      expect(response.error).toMatchObject({ code: "PERMISSION_DENIED" })
    }
    const handoffID = "native-to-cloud"
    const mapping = {
      kind: "organization-object" as const,
      moveID: "native-to-cloud-files",
      source: { workspaceID: native.workspaceID, generation: native.generation },
      target: {
        resourceID: resource.resourceID,
        workspaceID: before.workspaceID,
        generation: before.generation,
        path: "received",
        expectedRevision: before.revision,
      },
      acceptedDiffHash: null,
    }
    const prepare = {
      handoffID,
      targetRuntimeID: target.registration.runtimeID,
      expectedBindingEpoch: 1,
      expectedControlRevision: 0,
      mappingPlanRevision: 1,
      workspaceMapping: mapping,
    }
    const prepared = await f.client.orgHandoff.prepare(
      { sessionID, orgHandoffPrepare: prepare },
      { headers: f.headers },
    )
    expect(prepared.response.status).toBe(200)
    const view = prepared.data
    if (!view || !("mappingHash" in view) || typeof view.mappingHash !== "string")
      throw new Error("Missing concrete mapping consent hash")
    const accept = { mappingPlanRevision: 1, mappingHash: view.mappingHash }
    await f.client.orgHandoff.accept(
      { handoffID, orgHandoffAccept: accept },
      { headers: target.headers, throwOnError: true },
    )
    const drive = async (operation: Handoff.Drive["operation"]) =>
      Handoff.MachineResult.parse(
        (
          await f.client.orgHandoff.drive(
            { handoffID, orgHandoffDrive: { operation, requestID: crypto.randomUUID() } },
            {
              headers: Handoff.machineRole(operation) === "target" ? target.headers : source.headers,
              throwOnError: true,
            },
          )
        ).data,
      )
    if (scenario === "grant-revoked") {
      await f.client.orgResourceGrants.set(
        {
          resourceID: resource.resourceID,
          kind: "account",
          subjectID: f.identity.accountID,
          orgResourceGrantChange: { expectedRevision: 1, enabled: false },
        },
        options,
      )
      await expect(drive("prepare-source")).rejects.toBeDefined()
      await f.client.orgResourceGrants.set(
        {
          resourceID: resource.resourceID,
          kind: "account",
          subjectID: f.identity.accountID,
          orgResourceGrantChange: { expectedRevision: 2, enabled: true },
        },
        options,
      )
      expect((await f.client.orgCloudWorkspaces.get({ workspaceID: cloud.workspaceID }, options)).data.manifest).toBe(
        before.manifest,
      )
      return
    }
    let publishes = 0
    if (scenario === "lost-publish") {
      let lose = true
      f.interceptHTTP(async (request) => {
        if (new URL(request.url).pathname !== "/runtime/v1/handoffs/workspace") return
        const body = Cloud.HandoffWorkspaceRequest.parse(await request.clone().json())
        if (body.proof.operation.action !== "publish") return
        publishes++
        const response = await f.service.fetch(request)
        if (lose && response.status === 200) {
          lose = false
          return Response.json(
            {
              code: "SERVICE_UNAVAILABLE",
              message: "Lost original publish acknowledgement",
              outcome: "unknown",
              retryable: false,
            },
            { status: 503 },
          )
        }
        return response
      })
      await expect(drive("prepare-source")).rejects.toMatchObject({ outcome: "unknown" })
      expect((await f.client.orgCloudWorkspaces.get({ workspaceID: cloud.workspaceID }, options)).data.revision).toBe(
        before.revision + 1,
      )
    }
    const frozen = (await drive("prepare-source")).facts[0]?.proof
    if (scenario === "lost-publish") expect(publishes).toBe(1)
    if (frozen?.purpose !== "source-frozen") throw new Error("Missing frozen source")
    expect(frozen.workspaceMoveReceiptHash).toMatch(/^[a-f0-9]{64}$/)
    const after = (await f.client.orgCloudWorkspaces.get({ workspaceID: cloud.workspaceID }, options)).data
    expect(after.revision).toBe(before.revision + 1)
    expect(
      Buffer.from(
        (
          await f.client.orgCloudWorkspaces.read(
            {
              workspaceID: cloud.workspaceID,
              orgCloudWorkspaceRead: { path: "received/private.bin", offset: 0, length: bytes.length },
            },
            options,
          )
        ).data.data,
        "base64",
      ),
    ).toEqual(Buffer.from(bytes))
    expect(
      Buffer.from(
        (
          await f.client.orgCloudWorkspaces.read(
            { workspaceID: cloud.workspaceID, orgCloudWorkspaceRead: { path: "keep.txt", offset: 0, length: 4 } },
            options,
          )
        ).data.data,
        "base64",
      ).toString(),
    ).toBe("keep")
    const destination = (await drive("prepare-target")).facts[0]?.proof
    expect(destination).toMatchObject({
      purpose: "target-prepared",
      workspaceMoveReceiptHash: frozen.workspaceMoveReceiptHash,
    })
    const receipt = await target.runtime.run(async () => {
      const context = await Staging.context({
        ownerID: "organization-runtime",
        session: original,
        rootSessionID: sessionID,
        handoffID,
        mapping: {},
        signal: new AbortController().signal,
      })
      const header = await context.staged.record(["organization-session-transfer", handoffID, sessionID, "header"])
      return z.object({ workspaceMoveReceipt: WorkspaceMove.Receipt }).parse(header?.value).workspaceMoveReceipt
    })
    expect(WorkspaceMove.receiptHash(receipt)).toBe(frozen.workspaceMoveReceiptHash!)
    expect(receipt).toMatchObject({
      id: mapping.moveID,
      mappingRevision: 1,
      source: { workspaceID: native.workspaceID, generation: native.generation },
      target: {
        workspaceID: cloud.workspaceID,
        path: "received",
        before: { manifest: before.manifest },
        after: { manifest: after.manifest },
        mount: null,
      },
    })
    if (scenario === "cancel") {
      await f.client.orgHandoff.cancel({ handoffID, body: {} }, options)
      expect((await drive("cancel-source")).facts[0]?.proof.purpose).toBe("source-cancelled")
      expect((await f.client.orgHandoff.get({ handoffID }, options)).data.phase).toBe("cancelled")
      expect((await f.client.orgCloudWorkspaces.get({ workspaceID: cloud.workspaceID }, options)).data.manifest).toBe(
        after.manifest,
      )
      expect(await Bun.file(path.join(directory, "private.bin")).bytes()).toEqual(bytes)
      return
    }
    await f.client.orgHandoff.permit({ handoffID, orgHandoffPermitRequest: { purpose: "handoff-surrender" } }, options)
    expect((await drive("surrender-source")).facts[0]?.proof.purpose).toBe("source-surrendered")
    if (scenario === "retire") {
      expect((await drive("retire-target")).facts[0]?.proof).toMatchObject({
        purpose: "target-never-activate",
        tombstonePersisted: true,
      })
      expect((await f.client.orgHandoff.get({ handoffID }, options)).data.phase).toBe("retired")
      expect((await f.client.orgCloudWorkspaces.get({ workspaceID: cloud.workspaceID }, options)).data.manifest).toBe(
        after.manifest,
      )
      await expect(target.runtime.run(() => Session.get(sessionID))).rejects.toThrow()
      return
    }
    await f.client.orgHandoff.commit({ handoffID, body: {} }, options)
    await f.client.orgHandoff.permit(
      { handoffID, orgHandoffPermitRequest: { purpose: "handoff-activation" } },
      { headers: target.headers, throwOnError: true },
    )
    expect((await drive("activate-target")).facts[0]?.proof.purpose).toBe("target-activated")
    await target.runtime.run(async () => {
      const session = await Session.get(sessionID)
      expect(session.paused).toBeDefined()
      expect(session.organization).toMatchObject({ driverRuntimeID: target.registration.runtimeID, bindingEpoch: 2 })
      const selected = await WorkspaceCatalog.get(session.workspaceID!, project.projectID)
      expect(selected).toMatchObject({
        backend: {
          provider: "organization",
          spec: {
            resourceID: resource.resourceID,
            workspaceID: cloud.workspaceID,
            path: "received",
            workspaceMoveReceiptHash: frozen.workspaceMoveReceiptHash,
          },
        },
        binding: { path: null },
      })
      expect(selected.content).toBeUndefined()
    })
    expect(
      (await f.client.orgSessionResources.get({ sessionID }, options)).data.selection?.infrastructure.workspace,
    ).toEqual({ resourceID: resource.resourceID, workspaceID: cloud.workspaceID })
    expect((await f.client.orgHandoff.get({ handoffID }, options)).data.phase).toBe("completed")
    expect(await Bun.file(path.join(directory, "private.bin")).bytes()).toEqual(bytes)
    expect(allocations).toBe(0)
    if (scenario === "recipient") {
      const response = await f.client.orgHandoff.options(
        { sessionID, requestID: "shared-driver-inspection", targetRuntimeID: source.registration.runtimeID },
        { headers: target.headers },
      )
      expect(response.response.status, JSON.stringify(response.error)).toBe(200)
      const selected = Handoff.Options.parse(response.data)
      expect(selected).toMatchObject({
        sourceRuntimeID: target.registration.runtimeID,
        source: { kind: "organization" },
        native: {
          reference: { workspaceID: native.workspaceID, generation: native.generation },
          label: "Project directory",
        },
      })
      expect(JSON.stringify(selected)).not.toContain(directory)
      expect(
        (
          await f.client.orgHandoff.options(
            { sessionID, requestID: "old-driver-inspection", targetRuntimeID: source.registration.runtimeID },
            { headers: source.headers },
          )
        ).response.status,
      ).toBe(403)
    }
    if (scenario === "return-cloud") {
      const changedBytes = new Uint8Array([255, 0, 99, 100, 10, 128])
      const head = (await f.client.orgCloudWorkspaces.get({ workspaceID: cloud.workspaceID }, options)).data
      const version = "sha256:" + new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
      const changed = (
        await f.client.orgCloudWorkspaces.write(
          {
            workspaceID: cloud.workspaceID,
            orgCloudWorkspaceWrite: {
              operationID: "cloud-current-before-return",
              expectedRevision: head.revision,
              path: "received/private.bin",
              data: Buffer.from(changedBytes).toString("base64"),
              expectedVersion: version,
            },
          },
          options,
        )
      ).data
      const returningID = "return-" + handoffID
      const remoteSource = await target.runtime.run(async () => {
        const current = await Session.get(sessionID)
        const workspace = await WorkspaceCatalog.get(current.workspaceID!, project.projectID)
        return { workspaceID: workspace.id, generation: workspace.binding.generation }
      })
      const response = await f.client.orgHandoff.options(
        { sessionID, requestID: "return-inspection", targetRuntimeID: source.registration.runtimeID },
        { headers: target.headers },
      )
      expect(response.response.status, JSON.stringify(response.error)).toBe(200)
      const inspected = Handoff.Options.parse(response.data)
      const nativeCatalog = await source.runtime.run(() => WorkspaceCatalog.get(native.workspaceID, project.projectID))
      expect(inspected).toMatchObject({
        controlRevision: 3,
        bindingEpoch: 2,
        source: {
          reference: remoteSource,
          kind: "organization",
          resource: {
            resourceID: resource.resourceID,
            workspaceID: cloud.workspaceID,
            generation: cloud.generation,
            path: "received",
          },
        },
        native: {
          reference: {
            workspaceID: native.workspaceID,
            generation: native.generation,
            revision: nativeCatalog.revision,
          },
          projectRevision: (
            await source.client.orgLocalProject.get({ projectID: project.projectID }, { throwOnError: true })
          ).data.revision,
        },
        choices: [{ kind: "organization-live", requiresDifference: false }],
      })
      expect(JSON.stringify(inspected)).not.toContain(directory)
      const returning = await f.client.orgHandoff.prepare(
        {
          sessionID,
          orgHandoffPrepare: {
            handoffID: returningID,
            targetRuntimeID: source.registration.runtimeID,
            expectedBindingEpoch: 2,
            expectedControlRevision: 3,
            mappingPlanRevision: 1,
            workspaceMapping: {
              kind: "organization-live",
              source: remoteSource,
              resource: {
                resourceID: resource.resourceID,
                workspaceID: cloud.workspaceID,
                generation: cloud.generation,
                path: "received",
              },
            },
          },
        },
        options,
      )
      await f.client.orgHandoff.accept(
        {
          handoffID: returningID,
          orgHandoffAccept: {
            mappingPlanRevision: 1,
            mappingHash: returning.data.mappingHash,
          },
        },
        options,
      )
      const back = async (operation: Handoff.Drive["operation"]) =>
        Handoff.MachineResult.parse(
          (
            await f.client.orgHandoff.drive(
              {
                handoffID: returningID,
                orgHandoffDrive: { operation, requestID: crypto.randomUUID() },
              },
              options,
            )
          ).data,
        )
      const returnedFrozen = (await back("prepare-source")).facts[0]?.proof
      expect(returnedFrozen?.purpose).toBe("source-frozen")
      const captured = await target.runtime.run(async () => {
        const binding = {
          sessionID,
          scopeID: project.projectID,
          handoffID: returningID,
          sourceID: target.registration.runtimeID,
          targetID: source.registration.runtimeID,
          fromEpoch: 2,
          toEpoch: 3,
        }
        const snapshot = await Transfer.workspaceSource(binding)
        expect(snapshot).toMatchObject({
          workspaceID: cloud.workspaceID,
          revision: changed.revision,
          head: changed.manifest,
          path: "received",
        })
        expect(returnedFrozen?.purpose === "source-frozen" ? returnedFrozen.workspaceSourceHash : null).toBe(
          WorkspaceArchive.subtreeHash(snapshot!),
        )
        return Files.withCaptured(
          { binding, ...remoteSource, signal: new AbortController().signal },
          async (capture) => {
            const cache = path.join(objects, "captured-return")
            await fs.mkdir(cache)
            await using tree = await WorkspacePortableTree.open({
              root: capture.captured.files,
              store: capture.store,
              directory: cache,
            })
            const chunks: Uint8Array[] = []
            for await (const chunk of tree.read("private.bin")) chunks.push(chunk)
            return Buffer.concat(chunks)
          },
        )
      })
      expect(captured).toEqual(Buffer.from(changedBytes))
      let validations = 0
      f.interceptHTTP(async (request) => {
        if (new URL(request.url).pathname !== "/runtime/v1/handoffs/workspace") return
        const body = Cloud.HandoffWorkspaceRequest.parse(await request.clone().json())
        if (body.proof.handoffID !== returningID || body.proof.operation.action !== "source-validate") return
        const response = await f.service.fetch(request)
        if (++validations !== 2 || response.status !== 200) return response
        return Response.json(
          {
            code: "SERVICE_UNAVAILABLE",
            message: "Lost validation after private Workspace preparation",
            outcome: "unknown",
            retryable: false,
          },
          { status: 503 },
        )
      })
      await expect(back("prepare-target")).rejects.toMatchObject({ outcome: "unknown" })
      expect((await back("prepare-target")).facts[0]?.proof.purpose).toBe("target-prepared")
      await f.client.orgHandoff.permit(
        { handoffID: returningID, orgHandoffPermitRequest: { purpose: "handoff-surrender" } },
        options,
      )
      expect((await back("surrender-source")).facts[0]?.proof.purpose).toBe("source-surrendered")
      await f.client.orgHandoff.commit({ handoffID: returningID, body: {} }, options)
      await f.client.orgHandoff.permit(
        { handoffID: returningID, orgHandoffPermitRequest: { purpose: "handoff-activation" } },
        options,
      )
      expect((await back("activate-target")).facts[0]?.proof.purpose).toBe("target-activated")
      await source.runtime.run(async () => {
        const restored = await Session.get(sessionID)
        expect(restored.organization).toMatchObject({ driverRuntimeID: source.registration.runtimeID, bindingEpoch: 3 })
        expect(restored.paused).toBeDefined()
        const locator = await WorkspaceCatalog.get(restored.workspaceID!, project.projectID)
        expect(locator.backend).toMatchObject({
          provider: "organization",
          spec: { workspaceID: cloud.workspaceID, path: "received" },
        })
        expect(locator.content).toBeUndefined()
      })
      expect((await f.client.orgCloudWorkspaces.get({ workspaceID: cloud.workspaceID }, options)).data).toEqual(changed)
      expect(await Bun.file(path.join(directory, "private.bin")).bytes()).toEqual(bytes)
    }
  }, 30_000)
