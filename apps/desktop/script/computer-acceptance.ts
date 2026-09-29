import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { createHash } from "node:crypto"
import { mkdir, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { z } from "zod"
import { assert, startFixture, stageManagerEnabled, stayedInBackground, type Check } from "./computer-fixture"

export async function runComputerAcceptance(options: {
  directory: string
  server: string
  home: string
  providerID: string
  modelID: string
}) {
  const directory = path.resolve(options.directory)
  await mkdir(directory, { recursive: true })
  const checks: Check[] = []
  const report = {
    version: 1,
    kind: "desktop-model",
    status: "blocked" as Check["status"],
    createdAt: new Date().toISOString(),
    sessionID: "",
    checks,
  }
  let fixture: Awaited<ReturnType<typeof startFixture>> | undefined
  let prompted = false
  try {
    const home = await realpath(options.home)
    assert(
      home !== (await realpath(os.homedir())) && home !== path.join(os.homedir(), ".synergy"),
      "Use an explicitly isolated SYNERGY_HOME",
    )
    const url = new URL(options.server)
    assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Acceptance requires a loopback isolated server")
    const client = createSynergyClient({ baseUrl: options.server, scopeID: "home", throwOnError: true })
    const serverPaths = (await client.path.get()).data!
    assert((await realpath(serverPaths.home)) === home, "The server is not using the selected isolated Home")
    const providers = (await client.provider.list()).data!
    const provider = providers.all.find((value) => value.id === options.providerID)
    assert(providers.connected.includes(options.providerID), "The isolated provider has no connected credentials")
    assert(provider?.models[options.modelID]?.capabilities.input.image, "The selected model does not accept images")
    fixture = await startFixture(directory)
    const { initial } = fixture
    const target = initial.windows[0]!
    const session = (
      await client.session.create({
        title: "Computer S1 visual grounding acceptance",
        controlProfile: "full_access",
        workspace: { mode: "none" },
      })
    ).data!
    report.sessionID = session.id
    prompted = true
    const result = (
      await client.session.prompt(
        {
          sessionID: session.id,
          agent: "synergy",
          model: { providerID: options.providerID, modelID: options.modelID },
          parts: [
            {
              type: "text",
              text: `Use only computer_observe and computer_action. Observe pid=${initial.pid}, windowId=${target.windowId} (${target.title}). Read the Canvas code from the image, then point at the blue CLICK circle once. Do not press Increment. Observe after the action and report the complete code and outcome. If an action fails, stop and report the error; do not retry.`,
            },
          ],
          tools: {
            bash: false,
            read: false,
            glob: false,
            grep: false,
            write: false,
            edit: false,
            computer_apps: false,
          },
        },
        { signal: AbortSignal.timeout(180_000) },
      )
    ).data!
    assert(!result.info.error, `Model run failed: ${JSON.stringify(result.info.error)}`)
    const messages = (await client.session.messages({ sessionID: session.id })).data!
    const tools = messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")
    const observes = tools.filter((part) => part.tool === "computer_observe" && part.state.status === "completed")
    const actions = tools.filter((part) => part.tool === "computer_action")
    const after = await fixture.command("refresh")
    const text = result.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
    await Bun.write(path.join(directory, "messages.json"), JSON.stringify(messages, null, 2))
    await Bun.write(path.join(directory, "model-result.json"), JSON.stringify(result, null, 2))
    function check(name: string, valid: boolean, detail: string) {
      checks.push({ name, status: valid ? "pass" : "fail", ...(valid ? {} : { detail }) })
    }
    check(
      "background execution without transient activation or Space changes",
      stayedInBackground(initial, after),
      "The fixture must stay inactive throughout observation and action; restoring foreground afterward is insufficient",
    )
    check(
      "canvas-only visual nonce",
      text.includes(target.nonce) &&
        observes.every((part) => part.state.status === "completed" && !part.state.output.includes(target.nonce)),
      "Code must be read from pixels and absent from AX/tool text",
    )
    check(
      "one model-selected point with independent oracle",
      actions.length === 1 &&
        actions[0]!.state.status === "completed" &&
        after.windows[0]!.hits === 1 &&
        after.windows[1]!.hits === 0 &&
        after.windows.every((window) => window.clicks === 0),
      "Exactly one point must land on the selected window; semantic counters must remain unchanged",
    )
    check(
      "tool isolation and post-action observation",
      tools.every((part) => ["computer_observe", "computer_action"].includes(part.tool)) &&
        tools.at(-1)?.tool === "computer_observe",
      "Only the two permitted tools may run, with an observation after the action",
    )
    const attachments = observes.flatMap((part) =>
      part.state.status === "completed" ? (part.state.attachments ?? []) : [],
    )
    check(
      "exact image bytes submitted to the model",
      attachments.some((part) => {
        const receipt = part.metadata?.imageInput
        const match = /^data:image\/[^;]+;base64,(.+)$/.exec(part.url)
        return (
          receipt?.stage === "submitted" &&
          match?.[1] !== undefined &&
          receipt.sha256 === createHash("sha256").update(Buffer.from(match[1], "base64")).digest("hex")
        )
      }),
      "An observed attachment must have a durable submitted receipt for the exact bytes",
    )
    const admission = z
      .object({ callID: z.string(), sha256: z.string(), observationId: z.string() })
      .safeParse(actions[0]?.state.status === "completed" ? actions[0].state.metadata?.imageAdmission : undefined)
    check(
      "point evidence identifies its selecting model call",
      admission.success &&
        observes.some(
          (part) =>
            part.state.status === "completed" &&
            part.state.metadata?.observationId === admission.data.observationId &&
            part.state.attachments?.some((attachment) => attachment.artifact?.sha256 === admission.data.sha256),
        ) &&
        messages.some((message) =>
          message.parts.some(
            (part) =>
              part.type === "step-finish" &&
              part.accounting?.kind === "rollout" &&
              part.accounting.callIDs.includes(admission.success ? admission.data.callID : ""),
          ),
        ),
      "The point must retain its observation hash and originating rollout call",
    )
    const stage = await stageManagerEnabled()
    await Bun.write(
      path.join(directory, "environment.json"),
      JSON.stringify({ stageManager: stage ?? "unknown", displays: initial.displays }, null, 2),
    )
    report.status = checks.some((check) => check.status === "fail") ? "fail" : "pass"
  } catch (error) {
    checks.push({
      name: prompted ? "model execution" : "acceptance prerequisites",
      status: prompted ? "fail" : "blocked",
      detail: error instanceof Error ? error.message : String(error),
    })
    report.status = prompted ? "fail" : "blocked"
  } finally {
    await fixture?.close()
    await Bun.write(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n")
  }
  return report
}

if (import.meta.main) {
  const directory =
    process.env.SYNERGY_COMPUTER_REPORT_DIR ??
    path.resolve(
      import.meta.dir,
      "../../../.artifacts/computer-acceptance",
      new Date().toISOString().replaceAll(":", "-"),
    )
  const report = await runComputerAcceptance({
    directory,
    server: process.env.SYNERGY_COMPUTER_SERVER_URL ?? "http://127.0.0.1:5147",
    home: process.env.SYNERGY_HOME ?? "",
    providerID: process.env.SYNERGY_COMPUTER_PROVIDER ?? "deepseek",
    modelID: process.env.SYNERGY_COMPUTER_MODEL ?? "deepseek-flash",
  })
  console.log(JSON.stringify({ ...report, directory }, null, 2))
  process.exitCode = report.status === "pass" ? 0 : report.status === "blocked" ? 2 : 1
}
