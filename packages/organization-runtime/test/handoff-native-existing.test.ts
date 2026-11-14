import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import {
  OrganizationCommandProtocol as Command,
  OrganizationHandoffProtocol as Handoff,
} from "@ericsanchezok/synergy-organization-protocol"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionTransferWorkspaces as Files } from "@ericsanchezok/synergy-harness/session/transfer"
import { WorkspacePortableTree } from "@ericsanchezok/synergy-harness/workspace/portable-tree"
import { WorkspaceArchive } from "@ericsanchezok/synergy-harness/workspace/archive"
import { WorkspaceMove } from "@ericsanchezok/synergy-harness/workspace/move"
import { OrganizationHandoffObjects } from "../src/handoff-objects"
import { readCommandControlVersion } from "../src/command-intake"
import { cloudExecutionFixture } from "./support/cloud-execution"
import { createHandoffCompletion } from "./support/handoff-completion"

type Fixture = Awaited<ReturnType<typeof cloudExecutionFixture>>
type Scenario = "complete" | "target-changed" | "source-replaced"
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const command = (value: string) => [process.execPath, "-e", value].map(quote).join(" ")

async function git(directory: string, args: string[], root: string) {
  const config = path.join(root, "git-fixture-config")
  const hooks = path.join(root, "git-fixture-hooks")
  await Bun.write(config, "")
  await fs.mkdir(hooks, { recursive: true })
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")))
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
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error("Isolated fixture Git failed: " + stderr)
  return stdout
}

async function execute(scenario: Scenario) {
  const fixture = await cloudExecutionFixture()
  const failures: unknown[] = []
  try {
    await adopted(fixture, scenario)
  } catch (error) {
    failures.push(error)
  }
  try {
    await fixture[Symbol.asyncDispose]()
  } catch (error) {
    failures.push(error)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, "Native directory adoption and original cleanup failed")
}

async function adopted(fixture: Fixture, scenario: Scenario) {
  const sourceDirectory = path.join(fixture.directory, "existing-adoption-source")
  const targetDirectory = path.join(fixture.directory, "existing-adoption-target")
  await Promise.all([fs.mkdir(sourceDirectory), fs.mkdir(targetDirectory)])
  const sourceBytes = new Uint8Array([0, 255, 37, 128, 10, 231, 42])
  const finalSourceBytes = new Uint8Array([8, 0, 255, 37, 128, 10, 231, 42])
  const targetBytes = new Uint8Array([42, 231, 10, 128, 37, 255, 0])
  await Promise.all([
    Bun.write(path.join(sourceDirectory, "different.bin"), sourceBytes),
    Bun.write(path.join(targetDirectory, "different.bin"), targetBytes),
    Bun.write(path.join(sourceDirectory, "source-only.txt"), "retain the original source\n"),
    Bun.write(path.join(targetDirectory, "target-only.txt"), "continue with the accepted destination version\n"),
  ])
  if (scenario === "complete") {
    for (const [directory, branch] of [
      [sourceDirectory, "source-history"],
      [targetDirectory, "target-version"],
    ] as const) {
      await Bun.write(path.join(directory, ".gitignore"), "ignored.txt\n")
      await Bun.write(path.join(directory, "tracked.txt"), branch)
      await Bun.write(path.join(directory, "deleted.txt"), "tracked original\n")
      await git(directory, ["init", "--template=", "--initial-branch=" + branch], fixture.directory)
      await git(directory, ["add", "."], fixture.directory)
      await git(directory, ["commit", "-m", "Original fixture files"], fixture.directory)
      await Bun.write(path.join(directory, "ignored.txt"), branch + " ignored\n")
      await Bun.write(path.join(directory, "untracked.txt"), branch + " untracked\n")
    }
    await Bun.write(path.join(targetDirectory, "tracked.txt"), "accepted target dirty bytes\n")
    await git(targetDirectory, ["rm", "deleted.txt"], fixture.directory)
  }
  const source = await fixture.member("native-existing-source", { handoff: true, nativeDirectory: sourceDirectory })
  const target = await fixture.member("native-existing-target", { handoff: true, nativeDirectory: targetDirectory })
  let targetRuntime = target.runtime
  const originalRun = await source.bash("printf 'native-existing-source-ready\\n'")
  if (originalRun.result.metadata.processId)
    expect(
      (
        await source.process({
          action: "poll",
          processId: originalRun.result.metadata.processId,
          block: true,
          timeoutSeconds: 5,
        })
      ).metadata.status,
    ).toBe("completed")
  const nativeHistory = await source.runtime.run(() =>
    EnvironmentExecution.get(originalRun.executionID, fixture.project.projectID),
  )
  expect(nativeHistory.state).toBe("completed")
  const originalMessages = await source.runtime.run(() => Session.messages({ sessionID: source.sessionID, raw: true }))
  const [original, destination] = await Promise.all([
    source.runtime.run(() => Session.get(source.sessionID)),
    targetRuntime.run(() => Session.get(target.sessionID)),
  ])
  const sourceWorkspaceID = original.workspaceID
  const targetWorkspaceID = destination.workspaceID
  if (typeof sourceWorkspaceID !== "string" || typeof targetWorkspaceID !== "string")
    throw new Error("Both enrolled members must retain their actual native Workspace")
  expect(original.workspace?.path).toBe(await fs.realpath(sourceDirectory))
  expect(destination.workspace?.path).toBe(await fs.realpath(targetDirectory))
  expect(await Bun.file(path.join(sourceDirectory, "different.bin")).bytes()).toEqual(sourceBytes)
  expect(await Bun.file(path.join(targetDirectory, "different.bin")).bytes()).toEqual(targetBytes)
  const options = { headers: fixture.service.headers, throwOnError: true as const }
  const inspected = Handoff.Options.parse(
    (
      await fixture.service.client.orgHandoff.options(
        {
          sessionID: source.sessionID,
          targetRuntimeID: target.registration.runtimeID,
          requestID: "inspect-native-existing-directory",
        },
        options,
      )
    ).data,
  )
  expect(inspected.source?.kind).toBe("native")
  expect(inspected.source?.reference.workspaceID).toBe(sourceWorkspaceID)
  expect(inspected.native?.reference.workspaceID).toBe(targetWorkspaceID)
  expect(fixture.allocations()).toBe(0)
  expect(fixture.nativeStarts()).toBe(0)
  expect(inspected.choices.some((choice) => choice.kind === "native-existing" && choice.requiresDifference)).toBe(true)
  if (!inspected.source || !inspected.native || !inspected.environment?.native)
    throw new Error("Native adoption has no actual inspected participants")
  const sourceGeneration = inspected.source.reference.generation
  const handoffID = "native-existing-" + scenario
  const mapping = Handoff.WorkspaceMapping.parse({
    kind: "native-existing",
    moveID: "existing-directory-move",
    source: { workspaceID: sourceWorkspaceID, generation: inspected.source.reference.generation },
    target: {
      kind: "existing",
      workspaceID: targetWorkspaceID,
      generation: inspected.native.reference.generation,
      expectedRevision: inspected.native.reference.revision,
      projectRevision: inspected.native.projectRevision,
    },
  })
  if (mapping.kind !== "native-existing") throw new Error("The native adoption mapping has another kind")
  const nativeMapping = mapping
  const environmentMapping = Handoff.EnvironmentMapping.parse({
    version: 1,
    expectedSelectionRevision: inspected.environment.expectedSelectionRevision,
    source: inspected.environment.source,
    target: inspected.environment.native,
  })
  const requested = Handoff.View.parse(
    (
      await fixture.service.client.orgHandoff.prepare(
        {
          sessionID: source.sessionID,
          orgHandoffPrepare: {
            handoffID,
            targetRuntimeID: target.registration.runtimeID,
            expectedBindingEpoch: inspected.bindingEpoch,
            expectedControlRevision: inspected.controlRevision,
            mappingPlanRevision: 1,
            workspaceMapping: mapping,
            environmentMapping,
          },
        },
        options,
      )
    ).data,
  )
  expect(requested.mappingHash).toBe(await Handoff.planHash(mapping, environmentMapping))
  await fixture.service.client.orgHandoff.accept(
    { handoffID, orgHandoffAccept: { mappingPlanRevision: 1, mappingHash: requested.mappingHash } },
    options,
  )
  expect((await fixture.service.client.orgHandoff.get({ handoffID }, options)).data.workspaceDifferenceAccepted).toBe(
    false,
  )
  await Bun.write(path.join(sourceDirectory, "different.bin"), finalSourceBytes)
  async function raw(
    operation: Handoff.Drive["operation"],
    extra: Pick<Handoff.Drive, "expectedRevision" | "cursor"> = {},
    requestID: string = crypto.randomUUID(),
  ) {
    return fixture.service.client.orgHandoff.drive(
      { handoffID, orgHandoffDrive: { operation, requestID, ...extra } },
      { headers: fixture.service.headers },
    )
  }
  const drive = createHandoffCompletion({
    binding: Handoff.Binding.strip().parse(requested),
    source: { runtimeID: source.registration.runtimeID, publicKey: source.home.publicKey },
    target: { runtimeID: target.registration.runtimeID, publicKey: target.home.publicKey },
    async invoke(operation, requestID) {
      const result = await raw(operation, {}, requestID)
      if (!result.response.ok) throw result.error
      return Handoff.MachineResult.parse(result.data)
    },
  })
  const frozen = (await drive("prepare-source")).facts[0]?.proof
  if (frozen?.purpose !== "source-frozen" || !frozen.workspaceSourceHash || !frozen.fileClosureHash)
    throw new Error("Native adoption did not retain its complete actual source")
  const fileClosureHash = frozen.fileClosureHash
  expect(frozen.workspaceMoveReceiptHash).toBe(null)
  expect((await raw("prepare-target")).response.status).toBe(409)
  const difference = (await drive("preview-target")).facts.find(
    (fact) => fact.proof.purpose === "target-difference",
  )?.proof
  if (difference?.purpose !== "target-difference")
    throw new Error("Native adoption did not expose its complete difference")
  expect(difference.difference.sourceSnapshotHash).toBe(frozen.workspaceSourceHash)
  const entries: z.infer<typeof Handoff.DifferencePage>["items"] = []
  let cursor: string | undefined
  do {
    const response = await raw("inspect-target", { expectedRevision: difference.difference.diffHash, cursor })
    if (!response.response.ok) throw response.error
    const page = Handoff.MachineResult.parse(response.data)
    if (!page.differencePage) throw new Error("The original difference has no canonical page")
    entries.push(...page.differencePage.items)
    cursor = page.differencePage.cursor
  } while (cursor)
  expect(entries.length).toBe(difference.difference.entries)
  for (const name of ["different.bin", "source-only.txt", "target-only.txt"])
    expect(entries.some((entry) => entry.path === name)).toBe(true)
  expect(entries.find((entry) => entry.path === "different.bin")?.source?.kind).toBe("file")
  const binary = entries.find((entry) => entry.path === "different.bin")?.source
  if (binary?.kind !== "file") throw new Error("The final source binary is absent from the difference")
  expect(binary.hash).toBe(createHash("sha256").update(finalSourceBytes).digest("hex"))
  if (scenario === "complete")
    for (const name of ["tracked.txt", "ignored.txt", "untracked.txt", "deleted.txt", ".git/HEAD"])
      expect(entries.some((entry) => entry.path === name)).toBe(true)
  const consent = Handoff.DifferenceConsent.strip().parse(difference.difference)
  if (scenario === "complete") {
    for (const key of ["sourceSnapshotHash", "targetDigest", "diffHash"] as const) {
      const wrong = await fixture.service.client.orgHandoff.accept(
        {
          handoffID,
          orgHandoffAccept: {
            mappingPlanRevision: 1,
            mappingHash: requested.mappingHash,
            workspaceDifference: { ...consent, [key]: "0".repeat(64) },
          },
        },
        { headers: fixture.service.headers },
      )
      expect(wrong.response.status).toBe(409)
    }
    const wrongRevision = await fixture.service.client.orgHandoff.accept(
      {
        handoffID,
        orgHandoffAccept: { mappingPlanRevision: 2, mappingHash: requested.mappingHash, workspaceDifference: consent },
      },
      { headers: fixture.service.headers },
    )
    expect(wrongRevision.response.status).toBe(409)
    expect((await fixture.service.client.orgHandoff.get({ handoffID }, options)).data.workspaceDifferenceAccepted).toBe(
      false,
    )
  }
  await fixture.service.client.orgHandoff.accept(
    {
      handoffID,
      orgHandoffAccept: { mappingPlanRevision: 1, mappingHash: requested.mappingHash, workspaceDifference: consent },
    },
    options,
  )
  expect((await fixture.service.client.orgHandoff.get({ handoffID }, options)).data.workspaceDifferenceAccepted).toBe(
    true,
  )
  if (scenario === "complete") {
    await target.close()
    expect(target.runtime.status).toBe("closed")
    targetRuntime = await target.reopen()
    expect(targetRuntime.status).toBe("ready")
    const recovered = await drive("inspect-target")
    expect(recovered.workspaceDifference?.diffHash).toBe(consent.diffHash)
    expect((await fixture.service.client.orgHandoff.get({ handoffID }, options)).data.workspaceDifferenceAccepted).toBe(
      true,
    )
    expect(await Bun.file(path.join(targetDirectory, "different.bin")).bytes()).toEqual(targetBytes)
  }
  const cancel = async () => {
    await fixture.service.client.orgHandoff.cancel({ handoffID, body: {} }, options)
    expect((await drive("cancel-source")).facts.some((fact) => fact.proof.purpose === "source-cancelled")).toBe(true)
    expect(
      (await drive("retire-target", ["target-never-activate", "target-preview-released"])).facts.some(
        (fact) => fact.proof.purpose === "target-never-activate" || fact.proof.purpose === "target-preview-released",
      ),
    ).toBe(true)
  }
  if (scenario === "target-changed") {
    const changed = new Uint8Array([11, 22, 33])
    await Bun.write(path.join(targetDirectory, "different.bin"), changed)
    expect((await raw("prepare-target")).response.status).toBe(409)
    expect((await drive("inspect-target")).facts.some((fact) => fact.proof.purpose === "target-prepared")).toBe(false)
    expect(
      (await fixture.service.client.orgHandoff.get({ handoffID }, options)).data.workspaceDifference?.diffHash,
    ).toBe(consent.diffHash)
    expect(await Bun.file(path.join(targetDirectory, "different.bin")).bytes()).toEqual(changed)
    await cancel()
    return
  }
  const prepared = (await drive("prepare-target")).facts[0]?.proof
  if (prepared?.purpose !== "target-prepared") throw new Error("The exact adopted target did not prepare")
  expect(prepared.workspaceDifferenceHash).toBe(consent.diffHash)
  const nativeReceiptHash = prepared.workspaceNativeReceiptHash
  if (typeof nativeReceiptHash !== "string") throw new Error("The actual prepared native receipt is absent")
  expect(typeof nativeReceiptHash).toBe("string")
  expect(await Bun.file(path.join(targetDirectory, "different.bin")).bytes()).toEqual(targetBytes)
  const historical = await targetRuntime.run(() =>
    Files.withTargetCaptured(
      {
        binding: {
          sessionID: source.sessionID,
          scopeID: fixture.project.projectID,
          handoffID,
          sourceID: source.registration.runtimeID,
          targetID: target.registration.runtimeID,
          fromEpoch: inspected.bindingEpoch,
          toEpoch: inspected.bindingEpoch + 1,
        },
        expectedReceiptHash: fileClosureHash,
        workspaceID: sourceWorkspaceID,
        generation: sourceGeneration,
        signal: new AbortController().signal,
      },
      async (capture) => {
        await using tree = await WorkspacePortableTree.open({
          root: capture.captured.files,
          store: capture.store,
          directory: fixture.directory,
        })
        const chunks: Uint8Array[] = []
        for await (const chunk of tree.read("different.bin")) chunks.push(chunk)
        return Buffer.concat(chunks)
      },
    ),
  )
  expect(new Uint8Array(historical)).toEqual(finalSourceBytes)
  await fixture.service.client.orgHandoff.permit(
    { handoffID, orgHandoffPermitRequest: { purpose: "handoff-surrender" } },
    options,
  )
  if (scenario === "source-replaced") {
    const retained = sourceDirectory + "-original"
    await fs.rename(sourceDirectory, retained)
    await fs.cp(retained, sourceDirectory, { recursive: true, verbatimSymlinks: true })
    try {
      expect((await raw("surrender-source")).response.ok).toBe(false)
      expect((await fixture.service.client.orgHandoff.get({ handoffID }, options)).data.phase).toBe("prepared")
    } finally {
      await fs.rm(sourceDirectory, { recursive: true, force: true })
      await fs.rename(retained, sourceDirectory)
      await cancel()
    }
    return
  }
  expect((await drive("surrender-source")).facts[0]?.proof.purpose).toBe("source-surrendered")
  const committed = (await fixture.service.client.orgHandoff.commit({ handoffID, body: {} }, options)).data
  expect(committed.currentDriver).toBe(target.registration.runtimeID)
  await fixture.service.client.orgHandoff.permit(
    { handoffID, orgHandoffPermitRequest: { purpose: "handoff-activation" } },
    options,
  )
  expect((await drive("activate-target")).facts[0]?.proof.purpose).toBe("target-activated")
  const published = await targetRuntime.run(() => Session.get(source.sessionID))
  expect(published.workspaceID).toBe(targetWorkspaceID)
  expect(published.workspace?.path).toBe(await fs.realpath(targetDirectory))
  expect(published.paused !== undefined).toBe(true)
  const receivedMessages = await targetRuntime.run(() => Session.messages({ sessionID: source.sessionID, raw: true }))
  expect(receivedMessages.map(({ info }) => info.id)).toEqual(originalMessages.map(({ info }) => info.id))
  expect(receivedMessages.map(({ parts }) => parts)).toEqual(originalMessages.map(({ parts }) => parts))
  expect(
    (await targetRuntime.run(() => EnvironmentExecution.get(originalRun.executionID, fixture.project.projectID)))
      .digest,
  ).toBe(nativeHistory.digest)
  const publishedHistory = await targetRuntime.run(async () => {
    const request = await WorkspaceMove.requestForTarget({
      id: nativeMapping.moveID,
      workspaceID: targetWorkspaceID,
      scopeID: fixture.project.projectID,
    })
    if (!request || !("kind" in request) || request.kind !== "native-adoption")
      throw new Error("The activated directory has no original native adoption request")
    const retained = await WorkspaceMove.inspect(request)
    if (!retained || !("snapshot" in retained) || !retained.snapshot || !retained.nativeReceipt)
      throw new Error("The activated directory lost its original source snapshot and native receipt")
    expect(retained.state).toBe("activated")
    expect(WorkspaceMove.nativeReceiptHash(retained.nativeReceipt)).toBe(nativeReceiptHash)
    expect(WorkspaceArchive.subtreeHash(retained.snapshot)).toBe(consent.sourceSnapshotHash)
    const objects = await OrganizationHandoffObjects.open(
      {
        orgID: frozen.orgID,
        deploymentIncarnation: frozen.deploymentIncarnation,
        role: "target",
        binding: {
          sessionID: frozen.sessionID,
          scopeID: request.source.scopeID,
          handoffID: frozen.handoffID,
          sourceID: frozen.sourceRuntimeID,
          targetID: frozen.targetRuntimeID,
          fromEpoch: frozen.fromEpoch,
          toEpoch: frozen.toEpoch,
        },
      },
      new AbortController().signal,
    )
    await using tree = await WorkspacePortableTree.open({
      root: retained.snapshot.files,
      store: objects.store,
      directory: fixture.directory,
    })
    const chunks: Uint8Array[] = []
    for await (const chunk of tree.read("different.bin")) chunks.push(chunk)
    return new Uint8Array(Buffer.concat(chunks))
  })
  expect(publishedHistory).toEqual(finalSourceBytes)
  const control = await targetRuntime.run(async () => ({
    paused: (await Session.get(source.sessionID)).paused,
    version: await readCommandControlVersion(fixture.service.identity.orgID, source.sessionID),
  }))
  const paused = control.paused
  if (!paused) throw new Error("Adoption must require an independent Continue")
  const continued = Command.ControlAccepted.parse(
    (
      await fixture.service.client.orgCommands.control(
        {
          sessionID: source.sessionID,
          orgCommandControlRequest: {
            schemaVersion: 1,
            orgID: fixture.service.identity.orgID,
            projectID: fixture.project.projectID,
            sessionID: source.sessionID,
            runtimeID: target.registration.runtimeID,
            requestID: "continue-adopted-directory",
            control: { operation: "continue", pausedSince: paused.since, controlVersion: control.version },
          },
        },
        options,
      )
    ).data,
  )
  expect(continued.effect.operation).toBe("continue")
  const resumed = await target.attach(source.sessionID, source.accepted)
  const checked = await resumed.bash(
    command(
      "const data = await Bun.file('different.bin').bytes(); if(Buffer.from(data).toString('hex') !== '" +
        Buffer.from(targetBytes).toString("hex") +
        "') throw new Error('Wrong adopted bytes'); if(await Bun.file('source-only.txt').exists()) throw new Error('Source was silently copied'); if(!(await Bun.file('target-only.txt').text()).includes('destination version')) throw new Error('Missing destination file'); process.stdout.write('NATIVE_ADOPTION_CONTINUED\\n')",
    ),
  )
  if (checked.result.metadata.processId)
    expect(
      (
        await resumed.process({
          action: "poll",
          processId: checked.result.metadata.processId,
          block: true,
          timeoutSeconds: 5,
        })
      ).metadata.status,
    ).toBe("completed")
  expect(
    (await targetRuntime.run(() => EnvironmentExecution.get(checked.executionID, fixture.project.projectID))).state,
  ).toBe("completed")
  expect(await Bun.file(path.join(sourceDirectory, "different.bin")).bytes()).toEqual(finalSourceBytes)
  expect(await Bun.file(path.join(targetDirectory, "different.bin")).bytes()).toEqual(targetBytes)
  expect((await fixture.service.client.orgHandoff.get({ handoffID }, options)).data.phase).toBe("completed")
  expect(fixture.allocations()).toBe(0)
  expect(fixture.nativeStarts()).toBe(0)
}

for (const scenario of ["complete", "target-changed", "source-replaced"] as const)
  test.skipIf(process.platform === "win32")(
    scenario === "complete"
      ? "a native source offers explicit adoption of the destination member's existing directory"
      : `native existing-directory adoption rejects ${scenario} after exact difference consent`,
    () => execute(scenario),
    45000,
  )
