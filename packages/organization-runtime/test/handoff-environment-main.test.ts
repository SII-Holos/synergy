import { expect, test } from "bun:test"
import { z } from "zod"
import fs from "node:fs/promises"
import path from "node:path"
import {
  OrganizationCommandProtocol as Command,
  OrganizationHandoffProtocol as Handoff,
} from "@ericsanchezok/synergy-organization-protocol"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { readCommandControlVersion } from "../src/command-intake"
import { cloudExecutionFixture } from "./support/cloud-execution"

type Fixture = Awaited<ReturnType<typeof cloudExecutionFixture>>
type Machine = Awaited<ReturnType<Fixture["member"]>> | Awaited<ReturnType<Fixture["hosted"]>>

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const command = (program: string) => [process.execPath, "-e", program].map(quote).join(" ")

async function stage<T>(name: string, body: () => Promise<T>) {
  try {
    return await body()
  } catch (cause) {
    throw new Error("Environment mapping stage failed: " + name, { cause })
  }
}

function failureMetadata(error: unknown, depth = 0): unknown {
  if (typeof error !== "object" || error === null || depth > 12) return { name: "Unavailable error metadata" }
  const properties = Object.getOwnPropertyDescriptors(error)
  const field = (name: string): unknown => properties[name]?.value
  const data = field("data")
  const details: Record<string, PropertyDescriptor> =
    typeof data === "object" && data !== null ? Object.getOwnPropertyDescriptors(data) : {}
  const text = (value: unknown) => (typeof value === "string" ? value : undefined)
  const errors = field("errors")
  return {
    name: error instanceof Error ? error.name : text(field("name")),
    message: error instanceof Error ? error.message : text(field("message")),
    code: text(details.code?.value) ?? text(field("code")),
    detailMessage: text(details.message?.value),
    outcome: text(details.outcome?.value) ?? text(field("outcome")),
    ...(field("cause") !== undefined ? { cause: failureMetadata(field("cause"), depth + 1) } : {}),
    ...(Array.isArray(errors) ? { errors: errors.slice(0, 16).map((value) => failureMetadata(value, depth + 1)) } : {}),
  }
}

async function handoff(
  fixture: Fixture,
  sessionID: string,
  source: Machine,
  target: Machine,
  id: string,
  selections: (options: Handoff.Options) => {
    workspace: Handoff.WorkspaceMapping
    environment: Handoff.EnvironmentTargetSelection
  },
) {
  const options = { headers: fixture.service.headers, throwOnError: true as const }
  const inspected = Handoff.Options.parse(
    (
      await fixture.service.client.orgHandoff.options(
        { sessionID, targetRuntimeID: target.registration.runtimeID, requestID: id + "-inspect" },
        options,
      )
    ).data,
  )
  if (!inspected.environment) throw new Error("The enrolled participants did not expose their Environment mapping")
  const selected = selections(inspected)
  const environmentMapping = Handoff.EnvironmentMapping.parse({
    version: 1,
    expectedSelectionRevision: inspected.environment.expectedSelectionRevision,
    source: inspected.environment.source,
    target: selected.environment,
  })
  const environmentHash = await Handoff.environmentMappingHash(environmentMapping)
  const prepared = (
    await fixture.service.client.orgHandoff.prepare(
      {
        sessionID,
        orgHandoffPrepare: {
          handoffID: id,
          targetRuntimeID: target.registration.runtimeID,
          expectedBindingEpoch: inspected.bindingEpoch,
          expectedControlRevision: inspected.controlRevision,
          mappingPlanRevision: 1,
          workspaceMapping: selected.workspace,
          environmentMapping,
        },
      },
      options,
    )
  ).data
  expect(prepared.mappingHash).toBe(await Handoff.planHash(selected.workspace, environmentMapping))
  if (!prepared.targetAccepted)
    await fixture.service.client.orgHandoff.accept(
      { handoffID: id, orgHandoffAccept: { mappingPlanRevision: 1, mappingHash: prepared.mappingHash } },
      options,
    )
  expect((await fixture.service.client.orgHandoff.get({ handoffID: id }, options)).data.targetAccepted).toBe(true)
  async function drive(operation: Handoff.Drive["operation"]) {
    return stage(id + ":" + operation, async () => {
      try {
        return Handoff.MachineResult.parse(
          (
            await fixture.service.client.orgHandoff.drive(
              { handoffID: id, orgHandoffDrive: { operation, requestID: crypto.randomUUID() } },
              options,
            )
          ).data,
        )
      } catch (error) {
        if (
          operation === "prepare-target" &&
          z.object({ code: z.literal("COMMAND_OUTCOME_UNKNOWN"), outcome: z.literal("unknown") }).safeParse(error)
            .success
        ) {
          const deadline = Date.now() + 5000
          try {
            while (Date.now() < deadline) {
              const inspected = Handoff.MachineResult.parse(
                (
                  await fixture.service.client.orgHandoff.drive(
                    {
                      handoffID: id,
                      orgHandoffDrive: { operation: "inspect-target", requestID: crypto.randomUUID() },
                    },
                    options,
                  )
                ).data,
              )
              if (
                inspected.state === "complete" &&
                inspected.facts.some((fact) => fact.proof.purpose === "target-prepared")
              )
                return inspected
              if (inspected.state !== "working") break
              await Bun.sleep(25)
            }
          } catch (inspection) {
            throw new AggregateError([error, inspection], "Original Target dispatch and receipt inspection failed")
          }
        }
        throw error
      }
    })
  }
  const frozen = (await drive("prepare-source")).facts[0]?.proof
  expect(frozen?.purpose).toBe("source-frozen")
  if (frozen?.purpose !== "source-frozen") throw new Error("The original Source did not freeze")
  expect(frozen.environmentMappingHash).toBe(environmentHash)
  const destination = (await drive("prepare-target")).facts[0]?.proof
  expect(destination?.purpose).toBe("target-prepared")
  if (destination?.purpose !== "target-prepared") throw new Error("The original Target did not prepare")
  expect(destination.environmentMappingHash).toBe(environmentHash)
  await fixture.service.client.orgHandoff.permit(
    { handoffID: id, orgHandoffPermitRequest: { purpose: "handoff-surrender" } },
    options,
  )
  expect((await drive("surrender-source")).facts[0]?.proof.purpose).toBe("source-surrendered")
  const committed = (await fixture.service.client.orgHandoff.commit({ handoffID: id, body: {} }, options)).data
  expect(committed.currentDriver).toBe(target.registration.runtimeID)
  await fixture.service.client.orgHandoff.permit(
    { handoffID: id, orgHandoffPermitRequest: { purpose: "handoff-activation" } },
    options,
  )
  expect((await drive("activate-target")).facts[0]?.proof.purpose).toBe("target-activated")
  const published = await target.runtime.run(() => Session.get(sessionID))
  expect(published.organization?.bindingEpoch).toBe(inspected.bindingEpoch + 1)
  expect(published.organization?.driverRuntimeID).toBe(target.registration.runtimeID)
  expect(published.paused !== undefined).toBe(true)
  expect((await fixture.service.client.orgHandoff.get({ handoffID: id }, options)).data.phase).toBe("completed")
  return published
}

async function continueTask(fixture: Fixture, target: Machine, sessionID: string, accepted: Command.InputAccepted) {
  const current = await target.runtime.run(async () => ({
    session: await Session.get(sessionID),
    controlVersion: await readCommandControlVersion(fixture.service.identity.orgID, sessionID),
  }))
  const paused = current.session.paused
  if (!paused) throw new Error("The transferred task was not left paused for independent Continue")
  const continued = Command.ControlAccepted.parse(
    await stage(
      "independent-continue",
      async () =>
        (
          await fixture.service.client.orgCommands.control(
            {
              sessionID,
              orgCommandControlRequest: {
                schemaVersion: 1,
                orgID: fixture.service.identity.orgID,
                projectID: fixture.project.projectID,
                sessionID,
                runtimeID: target.registration.runtimeID,
                requestID: "continue-" + crypto.randomUUID(),
                control: {
                  operation: "continue",
                  pausedSince: paused.since,
                  controlVersion: current.controlVersion,
                },
              },
            },
            { headers: fixture.service.headers, throwOnError: true },
          )
        ).data,
    ),
  )
  expect(continued.effect.operation).toBe("continue")
  if (continued.effect.operation !== "continue") throw new Error("Independent Continue returned another receipt")
  expect(continued.effect.rootID).toBe(accepted.effect.messageID)
  return target.attach(sessionID, accepted)
}

async function mappedExecution(returnToNative: boolean) {
  const fixture = await cloudExecutionFixture()
  const failures: unknown[] = []
  try {
    await mappedTask(fixture, returnToNative)
  } catch (error) {
    failures.push(error)
  }
  try {
    await fixture[Symbol.asyncDispose]()
  } catch (error) {
    failures.push(error)
  }
  if (!failures.length) return
  for (const error of failures)
    console.error("Environment mapping main failure", JSON.stringify(failureMetadata(error)))
  if (failures.length === 1) throw failures[0]
  throw new AggregateError(failures, "Environment mapping task and original cleanup failed")
}

async function mappedTask(fixture: Fixture, returnToNative: boolean) {
  const headers = { headers: fixture.service.headers, throwOnError: true as const }
  const directory = path.join(fixture.directory, "original-native")
  await fs.mkdir(directory)
  const originalBytes = new Uint8Array([0, 255, 37, 128, 10, 231, 42])
  await Bun.write(path.join(directory, "native.bin"), originalBytes)
  await Bun.write(path.join(directory, "unicode.txt"), "原机器保存的文件\n")
  const source = await fixture.member("mapping-native", { handoff: true, nativeDirectory: directory })
  const target = await fixture.hosted("mapping-hosted")
  const initial = await source.bash(
    command(
      [
        "process.stdout.write('NATIVE_READY\\n');",
        "const input = await new Promise(resolve => process.stdin.once('data', resolve));",
        "if (Buffer.from(input).toString() !== 'finish\\n') throw new Error('Wrong original native process input');",
        "process.stdin.destroy();",
        "await Bun.write('native-marker.txt', 'completed on the original native executor\\n');",
      ].join("\n"),
    ),
  )
  expect(initial.result.metadata.background).toBe(true)
  const nativeProcessID = initial.result.metadata.processId
  if (!nativeProcessID) throw new Error("The original native ordinary Bash did not retain its actual process")
  expect(
    (await source.runtime.run(() => EnvironmentExecution.get(initial.executionID, fixture.project.projectID))).state,
  ).toBe("running")
  await source.process({ action: "write", processId: nativeProcessID, data: "finish\n" })
  expect(
    (
      await source.process({
        action: "poll",
        processId: nativeProcessID,
        block: true,
        timeoutSeconds: 5,
      })
    ).metadata.status,
  ).toBe("completed")
  const originalExecution = await source.runtime.run(() =>
    EnvironmentExecution.get(initial.executionID, fixture.project.projectID),
  )
  expect(originalExecution.state).toBe("completed")
  const original = await source.runtime.run(() => Session.get(source.sessionID))
  expect(original.environmentID !== null).toBe(true)
  expect(fixture.allocations()).toBe(0)
  const cloudBefore = await fixture.head()
  const cloud = {
    kind: "organization" as const,
    resourceID: fixture.compute.resourceID,
    resourceRevision: fixture.compute.revision,
    environmentID: fixture.environment.environmentID,
  }
  const first = await handoff(fixture, source.sessionID, source, target, "native-to-hosted-environment", (options) => {
    if (options.source?.kind !== "native" || options.environment?.source.kind !== "native")
      throw new Error("The real native Source was not inspected")
    return {
      workspace: {
        kind: "organization-object",
        moveID: "native-working-to-cloud",
        source: {
          workspaceID: options.source.reference.workspaceID,
          generation: options.source.reference.generation,
        },
        target: {
          resourceID: fixture.storage.resourceID,
          workspaceID: cloudBefore.workspaceID,
          generation: cloudBefore.generation,
          expectedRevision: cloudBefore.revision,
          path: "received",
        },
        acceptedDiffHash: null,
      },
      environment: cloud,
    }
  })
  expect(first.environmentID).toBeNull()
  expect(fixture.allocations()).toBe(0)
  expect(fixture.nativeStarts()).toBe(0)
  expect(
    (await fixture.service.client.orgSessionResources.get({ sessionID: source.sessionID }, headers)).data.selection
      ?.infrastructure.environment,
  ).toEqual({ resourceID: fixture.compute.resourceID, environmentID: fixture.environment.environmentID })
  const active = await continueTask(fixture, target, source.sessionID, source.accepted)
  const program = [
    "if (Buffer.from(await Bun.file('native.bin').arrayBuffer()).toString('base64') !== '" +
      Buffer.from(originalBytes).toString("base64") +
      "') throw new Error('Lost original native bytes');",
    "if (await Bun.file('unicode.txt').text() !== '原机器保存的文件\\n') throw new Error('Lost original Unicode bytes');",
    "await Bun.write('live.bin', new Uint8Array([0,255,37,128,10,42]));",
    "process.stdout.write('CLOUD_READY\\n');",
    "const input = await new Promise(resolve => process.stdin.once('data', resolve));",
    "if (Buffer.from(input).toString() !== 'finish\\n') throw new Error('Unexpected original process input');",
    "process.stdin.destroy();",
    "await Bun.write('finished.txt', 'saved after independent Continue\\n');",
    "process.stdout.write('CLOUD_SAVED\\n');",
  ].join("\n")
  const started = await active.bash(command(program))
  expect(started.result.metadata.background).toBe(true)
  const processId = started.result.metadata.processId
  if (!processId) throw new Error("The continued ordinary Bash did not retain its original process")
  await fixture.waitForOutput(started.executionID, "CLOUD_READY")
  expect((await fixture.physical(started.executionID)).execution.state).toBe("running")
  const bobMachine = await fixture.member("mapping-observer")
  const bob = await bobMachine.sibling({ environment: null })
  const live = await bob.files({ operation: { action: "describe" } })
  const read = await bob.files({
    reference: live.reference,
    operation: { action: "read", path: "received/live.bin", offset: 0, maximumBytes: 64 },
  })
  expect(read.result.action).toBe("read")
  if (read.result.action !== "read") throw new Error("The second Runtime did not read the original active mount")
  expect(read.result.data).toBe(Buffer.from([0, 255, 37, 128, 10, 42]).toString("base64"))
  await active.process({ action: "write", processId, data: "finish\n" })
  expect((await active.process({ action: "poll", processId, block: true, timeoutSeconds: 5 })).metadata.status).toBe(
    "completed",
  )
  const saved = await fixture.physical(started.executionID)
  expect(saved.execution.state).toBe("completed")
  expect(saved.uses.some((use) => use.ownership.kind === "execution")).toBe(false)
  const finalView = await bob.files({ operation: { action: "describe" } })
  const written = await bob.files({
    reference: finalView.reference,
    operation: {
      action: "write",
      id: "second-runtime-cas",
      path: "received/cas.txt",
      data: Buffer.from("second Runtime CAS\n").toString("base64"),
      expectedVersion: null,
    },
  })
  expect(written.result.action).toBe("write")
  const stale = await bob.filesResponse({
    reference: finalView.reference,
    operation: {
      action: "write",
      id: "stale-second-runtime-cas",
      path: "received/cas.txt",
      data: Buffer.from("stale").toString("base64"),
      expectedVersion: null,
    },
  })
  expect(stale.response.status).toBe(409)
  const receipt = await bob.files({
    reference: finalView.reference,
    operation: { action: "receipt", id: "second-runtime-cas" },
  })
  expect(receipt.result.action).toBe("receipt")
  if (receipt.result.action !== "receipt") throw new Error("The original CAS has no metadata receipt")
  expect(receipt.result.status?.state).toBe("saved")
  const acknowledged = await bob.files({
    reference: finalView.reference,
    operation: { action: "acknowledge", id: "second-runtime-cas" },
  })
  expect(acknowledged.result.action).toBe("acknowledge")
  expect(fixture.allocations()).toBe(1)
  expect(fixture.nativeStarts()).toBe(1)
  const returned = await handoff(fixture, source.sessionID, target, source, "cloud-environment-return", (options) => {
    if (options.source?.kind !== "organization" || !options.source.resource || !options.environment)
      throw new Error("The saved original cloud Working was not available for Handoff")
    let environment: Handoff.EnvironmentTargetSelection
    if (returnToNative) {
      if (!options.environment.native)
        throw new Error("The enrolled target did not expose its original borrowed native Environment")
      environment = options.environment.native
    } else {
      if (options.environment.source.kind !== "organization")
        throw new Error("The cloud Source did not preserve its actual logical Environment")
      environment = options.environment.source
    }
    return {
      workspace: returnToNative
        ? {
            kind: "organization-native",
            moveID: "cloud-working-private-native-copy",
            source: {
              workspaceID: options.source.reference.workspaceID,
              generation: options.source.reference.generation,
            },
            resource: options.source.resource,
            target: { kind: "private-copy" },
          }
        : {
            kind: "organization-live",
            source: {
              workspaceID: options.source.reference.workspaceID,
              generation: options.source.reference.generation,
            },
            resource: options.source.resource,
          },
      environment,
    }
  })
  expect(returned.environmentID === null).toBe(!returnToNative)
  expect(fixture.allocations()).toBe(1)
  expect(fixture.nativeStarts()).toBe(1)
  const contract = (await fixture.service.client.orgSessionResources.get({ sessionID: source.sessionID }, headers)).data
  expect(contract.selection?.infrastructure.environment).toEqual(
    returnToNative
      ? null
      : { resourceID: fixture.compute.resourceID, environmentID: fixture.environment.environmentID },
  )
  const resumed = await continueTask(fixture, source, source.sessionID, source.accepted)
  const verified = await resumed.bash(
    command(
      "if (await Bun.file('cas.txt').text() !== 'second Runtime CAS\\n') throw new Error('Lost current CAS bytes'); if (await Bun.file('finished.txt').text() !== 'saved after independent Continue\\n') throw new Error('Lost saved current bytes'); process.stdout.write('RETURN_VERIFIED\\n');",
    ),
  )
  if (verified.result.metadata.processId)
    expect(
      (
        await resumed.process({
          action: "poll",
          processId: verified.result.metadata.processId,
          block: true,
          timeoutSeconds: 5,
        })
      ).metadata.status,
    ).toBe("completed")
  expect(await Bun.file(path.join(directory, "native.bin")).bytes()).toEqual(originalBytes)
  expect(fixture.allocations()).toBe(1)
}

test.skipIf(process.platform === "win32")(
  "native to Hosted Environment handoff preserves live bytes and default cloud execution on return",
  () => mappedExecution(false),
  45000,
)

test.skipIf(process.platform === "win32")(
  "cloud Environment handoff explicitly selects the borrowed native target for a private current copy",
  () => mappedExecution(true),
  45000,
)
