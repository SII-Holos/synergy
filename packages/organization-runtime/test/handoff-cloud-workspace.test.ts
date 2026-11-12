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
  SessionTransferEpochs as Epochs,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { WorkspacePortableTree } from "@ericsanchezok/synergy-harness/workspace/portable-tree"
import { WorkspaceArchive } from "@ericsanchezok/synergy-harness/workspace/archive"
import { OrganizationSessionTransfer as Transfer } from "../src/session-transfer"
import { testResources } from "@ericsanchezok/synergy-testing/resources"
import { prepareMemberHome } from "../src/home"
import { enrollMemberRuntime } from "../src/enrollment"
import { openMemberRuntime } from "../src/runtime"
import { fixture } from "./support/organization"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"

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
  "return-adopt",
  "return-adopt-late-preview",
  "return-adopt-late-prepare",
  "return-adopt-prepared-cancel",
  "return-adopt-prepared-cancel-shared",
  "return-adopt-unshare-cleanup",
  "return-adopt-role-cleanup",
] as const)
  test(`consented native files complete one cross-Realm receipt (${scenario})`, async () => {
    const adopting = scenario.startsWith("return-adopt")
    const restrictedRecipient = scenario === "return-adopt-unshare-cleanup" || scenario === "return-adopt-role-cleanup"
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
    if (scenario === "recipient" || restrictedRecipient) {
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
    const workspaceCoordinator = new WorkspaceCoordinator({ directory: path.join(f.root, "workspace-coordinator") })
    type NativeBarrier = {
      kind: "preview" | "prepare"
      root: string
      entered: PromiseWithResolvers<void>
      resume: PromiseWithResolvers<void>
      aborting: PromiseWithResolvers<void>
      rescued: boolean
    }
    let nativeBarrier: NativeBarrier | undefined
    const acquire = workspaceCoordinator.acquire.bind(workspaceCoordinator)
    using claims = spyOn(workspaceCoordinator, "acquire").mockImplementation(async (input) => {
      const claim = await acquire(input),
        selected = nativeBarrier
      if (
        selected &&
        input.roots?.includes(selected.root) &&
        (selected.kind === "prepare"
          ? input.id.startsWith("workspace-move:")
          : input.kind === "exclusive" && !input.durable)
      ) {
        nativeBarrier = undefined
        const aborted = () => selected.aborting.resolve()
        input.signal?.addEventListener("abort", aborted, { once: true })
        if (input.signal?.aborted) aborted()
        const rescue = setTimeout(() => {
          selected.rescued = true
          selected.resume.resolve()
        }, 5000)
        selected.entered.resolve()
        try {
          await selected.resume.promise
        } finally {
          clearTimeout(rescue)
          input.signal?.removeEventListener("abort", aborted)
        }
      }
      return claim
    })
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
      const input = {
        home: home.home,
        identity: home.identity,
        ca: f.ca,
        listen: listener,
        handoff: true as const,
        workspaceCoordinator,
      }
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
      return { runtime, client, registration, headers: account.headers, sockets }
    }
    const source = await member("native-source", "a".repeat(64))
    const target = await member("cloud-target", "b".repeat(64), recipient)
    f.interceptFrames(undefined)
    const directory = path.join(f.root, "source-directory")
    await fs.mkdir(directory)
    const physicalDirectory = await fs.realpath(directory)
    const bytes = new Uint8Array([0, 255, 37, 128, 10])
    await Bun.write(path.join(directory, "private.bin"), bytes)
    await Bun.write(path.join(directory, ".gitignore"), "ignored.txt\n")
    await Bun.write(path.join(directory, "ignored.txt"), "retained ignored bytes")
    const git = async (args: string[]) => {
      const config = path.join(f.root, "fixture-gitconfig")
      const hooks = path.join(f.root, "fixture-hooks")
      await Bun.write(config, "")
      await fs.mkdir(hooks, { recursive: true })
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
      )
      const child = Bun.spawn(
        [
          "git",
          "-c",
          "core.fsmonitor=false",
          "-c",
          `core.hooksPath=${hooks}`,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          ...args,
        ],
        {
          cwd: directory,
          env: {
            ...env,
            GIT_CONFIG_GLOBAL: config,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_TERMINAL_PROMPT: "0",
            GIT_OPTIONAL_LOCKS: "0",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (exit) throw new Error("Fixture Git failed: " + stderr)
      return stdout
    }
    if (adopting) {
      await Bun.write(path.join(directory, "tracked.txt"), "original tracked bytes")
      await Bun.write(path.join(directory, "deleted-on-native.txt"), "source retained file")
      await fs.symlink("tracked.txt", path.join(directory, "selected-link"))
      await git(["init", "--template="])
      await git(["add", "."])
      await git(["commit", "-m", "Fixture source"])
    }
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
    if (scenario === "recipient" || scenario === "return-adopt-prepared-cancel-shared" || restrictedRecipient)
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
    let publishedReceipt: WorkspaceMove.Receipt | undefined
    if (scenario === "lost-publish") {
      let lose = true
      const observer = new AbortController()
      const entered = Promise.withResolvers<void>()
      const permit = Promise.withResolvers<void>()
      const committed = Promise.withResolvers<WorkspaceMove.Receipt>()
      const finished = Promise.withResolvers<Extract<Runtime.ClientFrame, { type: "receipt" }>["reply"]>()
      let observe = true
      f.interceptFrames((socket, raw) => {
        const frame = Runtime.ClientFrame.parse(JSON.parse(String(raw)))
        if (source.sockets.has(socket) && frame.type === "receipt") finished.resolve(frame.reply)
        return false
      })
      resources.defer("release original publication observer", async () => {
        permit.resolve()
        observer.abort()
        f.interceptFrames(undefined)
      })
      f.interceptHTTP(async (request) => {
        const route = new URL(request.url).pathname
        if (route === `/org/v1/handoffs/${handoffID}/drive` && observe) {
          observe = false
          return f.service.fetch(new Request(request, { signal: observer.signal }))
        }
        if (route !== "/runtime/v1/handoffs/workspace") return
        const body = Cloud.HandoffWorkspaceRequest.parse(await request.clone().json())
        if (body.proof.operation.action !== "publish") return
        publishes++
        entered.resolve()
        await permit.promise
        const response = await f.service.fetch(request)
        if (lose && response.status === 200) {
          const result = Cloud.HandoffWorkspaceResult.parse(await response.clone().json())
          if (result.action !== "publish") throw new Error("Publication returned another operation")
          publishedReceipt = WorkspaceMove.Receipt.parse(result.receipt)
          committed.resolve(publishedReceipt)
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
      const publication = Promise.race([
        committed.promise,
        finished.promise.then((reply) => {
          if (!publishedReceipt)
            throw reply.kind === "error"
              ? reply.error
              : new Error("Native source settled without a publication receipt")
          return publishedReceipt
        }),
      ])
      void publication.catch(() => {})
      let firstError: unknown
      const first = drive("prepare-source").then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => {
          firstError = error
          return { value: undefined, error }
        },
      )
      const bounded = async <T>(producer: Promise<T>, stage: string): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          return await Promise.race([
            producer,
            first.then((settled) => {
              if (settled.value) throw new Error("Source completed without the injected acknowledgement loss")
              if (!z.object({ outcome: z.literal("unknown") }).safeParse(settled.error).success) throw settled.error
              return producer
            }),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error(`Original publication did not reach ${stage}`)), 10_000)
            }),
          ])
        } catch (error) {
          if (firstError !== undefined && firstError !== error)
            throw new AggregateError([firstError, error], `Original publication failed during ${stage}`)
          throw error
        } finally {
          clearTimeout(timer)
        }
      }
      try {
        await bounded(entered.promise, "native dispatch")
        observer.abort()
        expect((await first).error).toMatchObject({ outcome: "unknown" })
        expect((await f.client.orgCloudWorkspaces.get({ workspaceID: cloud.workspaceID }, options)).data.revision).toBe(
          before.revision,
        )
      } finally {
        permit.resolve()
        publishedReceipt = await bounded(publication, "committed receipt")
        expect(await bounded(finished.promise, "original native completion")).toMatchObject({
          kind: "error",
          error: { outcome: "unknown" },
        })
        f.interceptFrames(undefined)
      }
      expect(publishes).toBe(1)
      expect(publishedReceipt).toMatchObject({
        id: mapping.moveID,
        target: { workspaceID: cloud.workspaceID, path: mapping.target.path, revision: before.revision + 1 },
      })
      expect((await f.client.orgCloudWorkspaces.get({ workspaceID: cloud.workspaceID }, options)).data.revision).toBe(
        publishedReceipt.target.revision,
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
    if (scenario === "lost-publish") expect(receipt).toEqual(publishedReceipt!)
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
      expect((await f.client.orgHandoff.get({ handoffID }, options)).data).toMatchObject({
        phase: "prepared",
        cancelRequested: false,
      })
      f.interceptHTTP(async (request) => {
        if (new URL(request.url).pathname !== `/org/v1/handoffs/${handoffID}/cancel`) return
        const response = await f.service.fetch(request)
        if (response.status !== 200) return response
        return Response.json(
          {
            code: "SERVICE_UNAVAILABLE",
            message: "Lost committed cancellation acknowledgement",
            outcome: "unknown",
            retryable: false,
          },
          { status: 503 },
        )
      })
      const cancelled = await f.client.orgHandoff.cancel({ handoffID, body: {} }, { headers: f.headers })
      expect(cancelled.response.status).toBe(503)
      expect(cancelled.error).toMatchObject({ outcome: "unknown" })
      f.interceptHTTP(undefined)
      expect((await f.client.orgHandoff.get({ handoffID }, options)).data).toMatchObject({
        phase: "prepared",
        cancelRequested: true,
      })
      expect((await drive("cancel-source")).facts[0]?.proof.purpose).toBe("source-cancelled")
      expect((await f.client.orgHandoff.get({ handoffID }, options)).data).toMatchObject({
        phase: "cancelled",
        cancelRequested: true,
      })
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
    if (scenario === "return-cloud" || adopting) {
      const changedBytes = new Uint8Array([255, 0, 99, 100, 10, 128])
      const head = (await f.client.orgCloudWorkspaces.get({ workspaceID: cloud.workspaceID }, options)).data
      const version = "sha256:" + new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
      let changed = (
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
      if (adopting) {
        await Bun.write(path.join(directory, "tracked.txt"), "selected native dirty bytes")
        await Bun.write(path.join(directory, "ignored.txt"), "selected native ignored bytes")
        await Bun.write(path.join(directory, "native-untracked.txt"), "selected native untracked bytes")
        await fs.rm(path.join(directory, "deleted-on-native.txt"))
        await fs.chmod(path.join(directory, "tracked.txt"), 0o755)
        await fs.unlink(path.join(directory, "selected-link"))
        await fs.symlink("native-untracked.txt", path.join(directory, "selected-link"))
        await git(["branch", "-m", "native-return"])
        changed = (
          await f.client.orgCloudWorkspaces.write(
            {
              workspaceID: cloud.workspaceID,
              orgCloudWorkspaceWrite: {
                operationID: "cloud-untracked-before-return",
                expectedRevision: changed.revision,
                path: "received/source-untracked.txt",
                data: Buffer.from("cloud untracked bytes").toString("base64"),
                expectedVersion: null,
              },
            },
            options,
          )
        ).data
      }
      let receiver = source,
        receiverNative = native,
        receiverAccountID = f.identity.accountID
      let receiverDirectory = physicalDirectory
      if (restrictedRecipient) {
        const invite = (await f.client.orgInvites.create({ orgInviteCreate: { role: "member" } }, options)).data
        const account = (
          await f.client.orgInvites.consume(
            {
              orgInviteConsume: {
                token: invite.token,
                requestID: "native-receiver",
                loginName: "native-receiver",
                displayName: "Native receiver",
                password: "native receiver integration password",
              },
            },
            { throwOnError: true },
          )
        ).data
        const login = await f.client.orgAuth.login(
          { orgLoginInput: { loginName: "native-receiver", password: "native receiver integration password" } },
          { throwOnError: true },
        )
        const headers = {
          cookie: login.response.headers.get("set-cookie")!.split(";")[0],
          "x-csrf-token": login.data.csrfToken,
        }
        const current = (await f.client.orgProjects.get({ projectID: project.projectID }, options)).data
        await f.client.orgProjects.member(
          {
            projectID: project.projectID,
            accountID: account.accountID,
            orgProjectMemberChange: { expectedRevision: current.revision, role: "collaborator" },
          },
          options,
        )
        receiver = await member("native-receiver", "c".repeat(64), { accountID: account.accountID, headers })
        receiverAccountID = account.accountID
        const existing = path.join(f.root, "receiver-existing")
        await fs.cp(directory, existing, { recursive: true, verbatimSymlinks: true })
        receiverDirectory = await fs.realpath(existing)
        const initial = (
          await receiver.client.orgLocalProject.get({ projectID: project.projectID }, { throwOnError: true })
        ).data
        receiverNative = (
          await receiver.client.orgLocalProject.bind(
            {
              projectID: project.projectID,
              orgLocalProjectBind: {
                requestID: "existing-receiver-directory",
                expectedRevision: initial.revision,
                directory: existing,
              },
            },
            { throwOnError: true },
          )
        ).data.binding!
      }
      const sourceOptions = { headers: target.headers, throwOnError: true as const }
      const receiverOptions = { headers: receiver.headers, throwOnError: true as const }
      const returningID = "return-" + handoffID
      const remoteSource = await target.runtime.run(async () => {
        const current = await Session.get(sessionID)
        const workspace = await WorkspaceCatalog.get(current.workspaceID!, project.projectID)
        return { workspaceID: workspace.id, generation: workspace.binding.generation }
      })
      const response = await f.client.orgHandoff.options(
        { sessionID, requestID: "return-inspection", targetRuntimeID: receiver.registration.runtimeID },
        { headers: target.headers },
      )
      expect(response.response.status, JSON.stringify(response.error)).toBe(200)
      const inspected = Handoff.Options.parse(response.data)
      const nativeCatalog = await receiver.runtime.run(() =>
        WorkspaceCatalog.get(receiverNative.workspaceID, project.projectID),
      )
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
            workspaceID: receiverNative.workspaceID,
            generation: receiverNative.generation,
            revision: nativeCatalog.revision,
          },
          projectRevision: (
            await receiver.client.orgLocalProject.get({ projectID: project.projectID }, { throwOnError: true })
          ).data.revision,
        },
        choices: [
          { kind: "organization-live", requiresDifference: false },
          { kind: "organization-native", requiresDifference: true },
        ],
      })
      expect(JSON.stringify(inspected)).not.toContain(directory)
      const nativeRequest = {
        handoffID: returningID,
        targetRuntimeID: receiver.registration.runtimeID,
        expectedBindingEpoch: 2,
        expectedControlRevision: 3,
        mappingPlanRevision: 1,
        workspaceMapping: {
          kind: "organization-native",
          moveID: "return-existing-native",
          source: remoteSource,
          resource: {
            resourceID: resource.resourceID,
            workspaceID: cloud.workspaceID,
            generation: cloud.generation,
            path: "received",
          },
          target: {
            kind: "existing",
            workspaceID: receiverNative.workspaceID,
            generation: receiverNative.generation,
            expectedRevision: nativeCatalog.revision,
            projectRevision: inspected.native?.projectRevision,
          },
        },
      }
      const nativeAction = async (operation: "accept" | "drive", body: unknown, status = 200) => {
        const response =
          operation === "accept"
            ? await f.client.orgHandoff.accept(
                { handoffID: returningID, orgHandoffAccept: Handoff.Accept.parse(body) },
                { headers: receiver.headers, throwOnError: false },
              )
            : await f.client.orgHandoff.drive(
                { handoffID: returningID, orgHandoffDrive: Handoff.Drive.parse(body) },
                { headers: receiver.headers, throwOnError: false },
              )
        const result = response.response.status === 200 ? response.data : response.error
        expect(response.response.status, JSON.stringify(result)).toBe(status)
        return result
      }
      const returning = adopting
        ? await f.client.orgHandoff.prepare(
            { sessionID, orgHandoffPrepare: Handoff.Prepare.parse(nativeRequest) },
            sourceOptions,
          )
        : await f.client.orgHandoff.prepare(
            {
              sessionID,
              orgHandoffPrepare: {
                handoffID: returningID,
                targetRuntimeID: receiver.registration.runtimeID,
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
        receiverOptions,
      )
      const back = async (operation: Handoff.Drive["operation"]) =>
        Handoff.MachineResult.parse(
          (
            await f.client.orgHandoff.drive(
              {
                handoffID: returningID,
                orgHandoffDrive: { operation, requestID: crypto.randomUUID() },
              },
              Handoff.machineRole(operation) === "source" ? sourceOptions : receiverOptions,
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
          targetID: receiver.registration.runtimeID,
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
      if (adopting) {
        expect(claims.mock.calls.length).toBeGreaterThan(0)
        const held: NativeBarrier = {
          kind: "preview",
          root: receiverDirectory,
          entered: Promise.withResolvers<void>(),
          resume: Promise.withResolvers<void>(),
          aborting: Promise.withResolvers<void>(),
          rescued: false,
        }
        const { entered, resume, aborting } = held
        const cancelled = async (knownPrepared: boolean, pending?: Promise<unknown>) => {
          await f.client.orgHandoff.cancel({ handoffID: returningID, body: {} }, sourceOptions)
          expect((await back("cancel-source")).facts[0]?.proof.purpose).toBe("source-cancelled")
          if (knownPrepared && !restrictedRecipient)
            expect(
              (
                await f.client.orgProjects.update(
                  {
                    projectID: project.projectID,
                    orgProjectChange: { expectedRevision: project.revision, state: "archived" },
                  },
                  options,
                )
              ).data.state,
            ).toBe("archived")
          if (restrictedRecipient) {
            if (scenario === "return-adopt-unshare-cleanup") {
              const inspected = Handoff.Options.parse(
                (
                  await f.client.orgHandoff.options(
                    {
                      sessionID,
                      requestID: "creator-return-before-unshare",
                      targetRuntimeID: source.registration.runtimeID,
                    },
                    sourceOptions,
                  )
                ).data,
              )
              if (inspected.source?.kind !== "organization" || !inspected.source.resource)
                throw new Error("Creator return requires its current service Workspace")
              const handoffID = "creator-return-before-unshare"
              const prepared = (
                await f.client.orgHandoff.prepare(
                  {
                    sessionID,
                    orgHandoffPrepare: {
                      handoffID,
                      targetRuntimeID: source.registration.runtimeID,
                      expectedBindingEpoch: inspected.bindingEpoch,
                      expectedControlRevision: inspected.controlRevision,
                      mappingPlanRevision: 1,
                      workspaceMapping: {
                        kind: "organization-live",
                        source: {
                          workspaceID: inspected.source.reference.workspaceID,
                          generation: inspected.source.reference.generation,
                        },
                        resource: inspected.source.resource,
                      },
                    },
                  },
                  sourceOptions,
                )
              ).data
              await f.client.orgHandoff.accept(
                { handoffID, orgHandoffAccept: { mappingPlanRevision: 1, mappingHash: prepared.mappingHash } },
                options,
              )
              const drive = async (operation: Handoff.Drive["operation"]) =>
                Handoff.MachineResult.parse(
                  (
                    await f.client.orgHandoff.drive(
                      { handoffID, orgHandoffDrive: { operation, requestID: crypto.randomUUID() } },
                      Handoff.machineRole(operation) === "source" ? sourceOptions : options,
                    )
                  ).data,
                )
              await drive("prepare-source")
              await drive("prepare-target")
              await f.client.orgHandoff.permit(
                { handoffID, orgHandoffPermitRequest: { purpose: "handoff-surrender" } },
                sourceOptions,
              )
              await drive("surrender-source")
              await f.client.orgHandoff.commit({ handoffID, body: {} }, sourceOptions)
              await f.client.orgHandoff.permit(
                { handoffID, orgHandoffPermitRequest: { purpose: "handoff-activation" } },
                options,
              )
              await drive("activate-target")
              await f.client.orgSessions.unshare(
                { sessionID, orgShareChange: { expectedShareGeneration: returning.data.shareGeneration } },
                options,
              )
            } else {
              const current = (await f.client.orgProjects.get({ projectID: project.projectID }, options)).data
              await f.client.orgProjects.member(
                {
                  projectID: project.projectID,
                  accountID: receiverAccountID,
                  orgProjectMemberChange: { expectedRevision: current.revision, role: null },
                },
                options,
              )
              expect(
                (await f.client.orgProjects.get({ projectID: project.projectID }, { headers: receiver.headers }))
                  .response.status,
              ).toBe(404)
            }
            expect(
              (await f.client.orgHandoff.get({ handoffID: returningID }, { headers: receiver.headers })).response
                .status,
            ).toBe(404)
            await expect(
              f.client.orgHandoff.drive(
                {
                  handoffID: returningID,
                  orgHandoffDrive: { operation: "retire-target", requestID: "administrator-cannot-borrow-target" },
                },
                options,
              ),
            ).rejects.toMatchObject({ code: "PERMISSION_DENIED" })
            await expect(
              f.client.orgHandoff.drive(
                {
                  handoffID: returningID,
                  orgHandoffDrive: { operation: "retire-target", requestID: "another-account-cannot-borrow-target" },
                },
                sourceOptions,
              ),
            ).rejects.toMatchObject({ code: "NOT_FOUND" })
          }
          const lostCleanup = scenario === "return-adopt-unshare-cleanup" || scenario === "return-adopt-late-preview"
          let cleanupPosts = 0
          if (lostCleanup)
            f.interceptHTTP(async (request) => {
              if (new URL(request.url).pathname !== `/org/v1/handoffs/${returningID}/drive`) return
              const body = Handoff.Drive.parse(await request.clone().json())
              if (body.operation !== "retire-target") return
              cleanupPosts++
              const response = await f.service.fetch(request)
              if (response.status !== 200) return response
              return Response.json(
                {
                  code: "SERVICE_UNAVAILABLE",
                  message: "Lost committed native cleanup acknowledgement",
                  outcome: "unknown",
                  retryable: false,
                },
                { status: 503 },
              )
            })
          using releases = spyOn(WorkspaceMove, "release")
          let settled = false
          const retiring = back("retire-target").then((value) => {
            settled = true
            return value
          })
          void retiring.catch(() => {})
          try {
            if (pending) {
              await Promise.race([aborting.promise, retiring])
              expect(settled).toBe(false)
              resume.resolve()
              await expect(pending).rejects.toThrow()
            }
            let outcome: Handoff.MachineResult
            if (lostCleanup) {
              await expect(retiring).rejects.toMatchObject({ outcome: "unknown" })
              f.interceptHTTP(undefined)
              const released = releases.mock.calls.length
              outcome = await back("inspect-target")
              expect(releases.mock.calls.length).toBe(released)
              expect(cleanupPosts).toBe(1)
              expect(outcome.workspaceDifference).toBeUndefined()
              expect(outcome.differencePage).toBeUndefined()
              expect(outcome.object).toBeUndefined()
            } else outcome = await retiring
            expect(outcome.facts[0]?.proof.purpose).toBe(
              knownPrepared ? "target-never-activate" : "target-preview-released",
            )
            await receiver.runtime.run(async () => {
              const selected = {
                sessionID,
                scopeID: project.projectID,
                handoffID: returningID,
                sourceID: target.registration.runtimeID,
                targetID: receiver.registration.runtimeID,
                fromEpoch: 2,
                toEpoch: 3,
              }
              expect(await Epochs.inspect(selected)).toMatchObject({ role: "target", phase: "never_activate" })
              const original = z
                .object({ request: WorkspaceMove.NativeRequest })
                .parse(await Storage.read(["workspace_move", project.projectID, "return-existing-native"]))
              expect(await WorkspaceMove.inspect(original.request)).toMatchObject({
                state: knownPrepared ? "retired" : "cancelled",
                nativeRequested: false,
              })
              expect(
                (await workspaceCoordinator.inspect()).some(
                  (claim) => claim.roots?.some((root) => root.path === receiverDirectory) && claim.state === "active",
                ),
              ).toBe(false)
            })
            expect(held.rescued).toBe(false)
            const current = (await f.client.orgSessions.get({ sessionID }, options)).data
            expect(current.driverRuntimeID).toBe(
              scenario === "return-adopt-unshare-cleanup"
                ? source.registration.runtimeID
                : target.registration.runtimeID,
            )
            expect(current.bindingEpoch).toBe(scenario === "return-adopt-unshare-cleanup" ? 4 : 2)
            expect(await Bun.file(path.join(directory, "tracked.txt")).text()).toBe("selected native dirty bytes")
            if (restrictedRecipient) {
              expect(
                (await f.client.orgHandoff.get({ handoffID: returningID }, { headers: receiver.headers })).response
                  .status,
              ).toBe(404)
              const current = (
                await f.client.orgRuntime.get({ runtimeID: receiver.registration.runtimeID }, receiverOptions)
              ).data
              await f.client.orgRuntime.revoke(
                {
                  runtimeID: receiver.registration.runtimeID,
                  orgRuntimeRevoke: { expectedRevision: current.revision },
                },
                options,
              )
              await expect(back("inspect-target")).rejects.toMatchObject({ code: "PERMISSION_DENIED" })
            }
          } finally {
            resume.resolve()
            await Promise.allSettled([retiring, ...(pending ? [pending] : [])])
          }
        }
        await expect(back("prepare-target")).rejects.toMatchObject({ code: "HANDOFF_BLOCKED" })
        if (scenario === "return-adopt-late-preview") {
          nativeBarrier = held
          const pending = nativeAction("drive", { operation: "preview-target", requestID: "held-native-preview" })
          void pending.catch(() => {})
          try {
            await Promise.race([
              entered.promise,
              pending.then(() => {
                throw new Error("Native preview completed before its actual claim barrier")
              }),
            ])
            await cancelled(false, pending)
          } finally {
            resume.resolve()
            await pending.catch(() => {})
          }
          return
        }
        const preview = Handoff.MachineResult.parse(
          await nativeAction("drive", { operation: "preview-target", requestID: "preview-existing-native" }),
        )
        const fact = preview.facts.find((fact) => fact.proof.purpose === "target-difference")?.proof
        if (fact?.purpose !== "target-difference") throw new Error("Missing actual native target difference")
        expect(fact.difference.sourceSnapshotHash).toBe(
          Handoff.Hash.parse(returnedFrozen?.purpose === "source-frozen" ? returnedFrozen.workspaceSourceHash : null),
        )
        const paths: string[] = []
        let cursor: string | undefined
        do {
          const page = Handoff.MachineResult.parse(
            await nativeAction("drive", {
              operation: "inspect-target",
              requestID: crypto.randomUUID(),
              expectedRevision: fact.difference.diffHash,
              cursor,
            }),
          ).differencePage
          if (!page) throw new Error("Missing exact difference page")
          paths.push(...page.items.map((item) => item.path))
          cursor = page.cursor
        } while (cursor)
        expect(paths).toContain("tracked.txt")
        expect(paths).toContain("ignored.txt")
        expect(paths).toContain("native-untracked.txt")
        expect(paths).toContain("source-untracked.txt")
        expect(paths).toContain("deleted-on-native.txt")
        expect(paths).toContain(".git/HEAD")
        expect(paths).toContain("selected-link")
        const consent = Handoff.DifferenceConsent.strip().parse(fact.difference)
        if (scenario === "return-adopt") {
          for (const field of ["sourceSnapshotHash", "targetDigest", "diffHash"] as const) {
            expect(
              await nativeAction(
                "accept",
                {
                  mappingPlanRevision: 1,
                  mappingHash: returning.data.mappingHash,
                  workspaceDifference: { ...consent, [field]: "0".repeat(64) },
                },
                409,
              ),
            ).toMatchObject({ code: "REVISION_CONFLICT" })
          }
          expect(
            await nativeAction(
              "accept",
              { mappingPlanRevision: 2, mappingHash: returning.data.mappingHash, workspaceDifference: consent },
              409,
            ),
          ).toMatchObject({ code: "REVISION_CONFLICT" })
          expect(
            await nativeAction(
              "drive",
              { operation: "inspect-target", requestID: "old-difference-cursor", expectedRevision: "0".repeat(64) },
              409,
            ),
          ).toMatchObject({ code: "REVISION_CONFLICT" })
          expect(
            Handoff.View.parse((await f.client.orgHandoff.get({ handoffID: returningID }, options)).data)
              .workspaceDifferenceAccepted,
          ).toBe(false)
        }
        const accepted = Handoff.View.parse(
          await nativeAction("accept", {
            mappingPlanRevision: 1,
            mappingHash: returning.data.mappingHash,
            workspaceDifference: consent,
          }),
        )
        expect(accepted.workspaceDifferenceAccepted).toBe(true)
        if (scenario === "return-adopt-late-prepare") {
          held.kind = "prepare"
          nativeBarrier = held
          const pending = back("prepare-target")
          void pending.catch(() => {})
          try {
            await Promise.race([
              entered.promise,
              pending.then(() => {
                throw new Error("Native preparation completed before its actual claim barrier")
              }),
            ])
            await cancelled(false, pending)
          } finally {
            resume.resolve()
            await pending.catch(() => {})
          }
          return
        }
        const prepared = (await back("prepare-target")).facts[0]?.proof
        expect(prepared).toMatchObject({ purpose: "target-prepared", workspaceDifferenceHash: consent.diffHash })
        expect(prepared?.purpose === "target-prepared" ? prepared.workspaceNativeReceiptHash : undefined).toMatch(
          /^[a-f0-9]{64}$/,
        )
        if (scenario.startsWith("return-adopt-prepared-cancel") || restrictedRecipient) {
          await expect(back("retire-target")).rejects.toMatchObject({ code: "HANDOFF_BLOCKED" })
          await f.client.orgCloudWorkspaces.write(
            {
              workspaceID: cloud.workspaceID,
              orgCloudWorkspaceWrite: {
                operationID: "source-changed-after-native-consent",
                expectedRevision: changed.revision,
                path: "received/changed-after-native-consent",
                data: Buffer.from("new source bytes after native consent").toString("base64"),
                expectedVersion: null,
              },
            },
            options,
          )
          await expect(
            f.client.orgHandoff.permit(
              { handoffID: returningID, orgHandoffPermitRequest: { purpose: "handoff-surrender" } },
              sourceOptions,
            ),
          ).rejects.toMatchObject({ code: "REVISION_CONFLICT" })
          await cancelled(true)
          return
        }
      } else {
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
      }
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
      await receiver.runtime.run(async () => {
        const restored = await Session.get(sessionID)
        expect(restored.organization).toMatchObject({
          driverRuntimeID: receiver.registration.runtimeID,
          bindingEpoch: 3,
        })
        expect(restored.paused).toBeDefined()
        const locator = await WorkspaceCatalog.get(restored.workspaceID!, project.projectID)
        if (adopting) {
          expect(restored.workspaceID).toBe(receiverNative.workspaceID)
          expect(locator).toEqual(nativeCatalog)
          const retained = z
            .object({ request: WorkspaceMove.NativeRequest })
            .parse(await Storage.read(["workspace_move", project.projectID, "return-existing-native"]))
          const move = await WorkspaceMove.inspect(retained.request)
          expect(move).toMatchObject({ state: "activated", nativeRequested: false })
          return
        }
        expect(locator.backend).toMatchObject({
          provider: "organization",
          spec: { workspaceID: cloud.workspaceID, path: "received" },
        })
        expect(locator.content).toBeUndefined()
      })
      expect((await f.client.orgCloudWorkspaces.get({ workspaceID: cloud.workspaceID }, options)).data).toEqual(changed)
      expect(await Bun.file(path.join(directory, "private.bin")).bytes()).toEqual(bytes)
      expect(allocations).toBe(0)
      if (adopting) {
        expect(await Bun.file(path.join(directory, "tracked.txt")).text()).toBe("selected native dirty bytes")
        expect(await Bun.file(path.join(directory, "ignored.txt")).text()).toBe("selected native ignored bytes")
        expect(await Bun.file(path.join(directory, "native-untracked.txt")).text()).toBe(
          "selected native untracked bytes",
        )
        expect(await Bun.file(path.join(directory, "source-untracked.txt")).exists()).toBe(false)
        expect(await Bun.file(path.join(directory, "deleted-on-native.txt")).exists()).toBe(false)
        expect((await git(["branch", "--show-current"])).trim()).toBe("native-return")
        expect((await fs.stat(path.join(directory, "tracked.txt"))).mode & 0o777).toBe(0o755)
        expect(await fs.readlink(path.join(directory, "selected-link"))).toBe("native-untracked.txt")
        expect(
          (await f.client.orgSessionResources.get({ sessionID }, options)).data.selection?.infrastructure.workspace,
        ).toBeNull()
      }
    }
  }, 30_000)
