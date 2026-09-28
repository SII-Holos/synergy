import fs from "node:fs/promises"
import path from "node:path"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInputStatus } from "@ericsanchezok/synergy-harness/session/input-status"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"
import { Asset } from "@ericsanchezok/synergy-harness/asset/asset"
import { acceptanceRuntime, until } from "./runtime"
import { atomicJSON, digest, sealEvidence } from "./evidence"
import { readRequests } from "./provider"
import { productWindow } from "./product-window"
import type { Settings } from "./settings"
import type { Driver } from "./runner"

export function uploadedContentReachedModel(inputs: Record<string, unknown>[], marker: string) {
  const foreground = inputs.filter((input) => Array.isArray(input.tools) && input.tools.length > 0)
  return foreground.length > 0 && foreground.every((input) => JSON.stringify(input).includes(marker))
}

export function desktopInput(settings: Settings): Driver {
  return async (context) => {
    const agent = context.scenario.agent
    if (!agent) throw new Error("Product acceptance requires a declared primary agent")
    if (!settings.artifacts?.web) throw new Error("Product acceptance requires an explicit frozen Web artifact")
    await using host = await acceptanceRuntime(context.directory, settings, {
      http: true,
      webAppDirectory: settings.artifacts.web,
    })
    const project = path.join(context.directory, "project")
    const next = path.join(context.directory, "next-workspace")
    await fs.mkdir(project)
    await fs.mkdir(next)
    const marker = crypto.randomUUID().replaceAll("-", "")
    const attachment = crypto.randomUUID().replaceAll("-", "")
    const draft = crypto.randomUUID().replaceAll("-", "")
    await Bun.write(path.join(project, "record.txt"), marker)
    await Bun.write(path.join(next, "record.txt"), "new Workspace")
    return await host.runtime.run(async () => {
      const { scope } = await Scope.fromDirectory(project)
      return ScopeContext.provide({
        scope,
        fn: async () => {
          const environment = await Environment.bind({
            scopeID: scope.id,
            ownerID: crypto.randomUUID(),
            provider: "native",
            spec: {},
          })
          const session = await Session.create({
            title: "Desktop input acceptance",
            controlProfile: "full_access",
            agentOverride: agent,
            environmentID: environment.id,
          })
          const binding = await WorkspaceBinding.register(scope.id, next)
          const url = `http://127.0.0.1:${host.runtime.server!.port}/${Buffer.from(scope.id).toString("base64url")}/session/${session.id}`
          const barriers: string[] = []
          const snapshots: Record<string, unknown> = {}
          const physical: Record<string, unknown> = {}
          let attachmentRead = false
          let draftPreserved = false
          let controlsCorrect = false
          let persistedStateMatches = false
          const ui = await productWindow(path.join(context.directory, "ui"), url, settings, true)
          const { page } = ui
          const editor = page.locator('[contenteditable="true"]')
          const control = page.locator(".prompt-input-submit")
          const snapshot = async (name: string) => {
            await ui.snapshot(name)
            snapshots[name] = {
              session: await Session.get(session.id),
              messages: await Session.messages({ sessionID: session.id }),
            }
          }
          const checkpoint = async (name: string, barrier: string) => {
            await snapshot(name)
            await context.checkpoint(barrier, [
              { path: `ui/${name}.json`, kind: "product" },
              { path: `ui/${name}.png`, kind: "external" },
            ])
            barriers.push(barrier)
          }
          async function submit(text: string) {
            const before = new Set(
              (await Session.messages({ sessionID: session.id })).map((message) => message.info.id),
            )
            await editor.fill(text)
            await control.click()
            const sent = (await until(
              async () =>
                (await Session.messages({ sessionID: session.id })).find(
                  (message) => message.info.role === "user" && !before.has(message.info.id),
                ),
              Boolean,
              settings.deadlineMs,
            ))!
            if (sent.info.role !== "user" || sent.info.agent !== agent)
              throw new Error("The composer did not submit the declared primary agent")
            return sent.info.id
          }
          async function completed(messageID: string) {
            const state = await until(
              () => SessionInputStatus.get({ sessionID: session.id, messageID }),
              (value) => ["completed", "cancelled", "failed"].includes(value.state),
              settings.deadlineMs,
            )
            if (state.state !== "completed") throw new Error(`Product input ended as ${state.state}`)
            return (await Session.messages({ sessionID: session.id }))
              .filter((message) => message.info.role === "assistant" && message.info.parentID === messageID)
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n")
          }
          async function upload(filename: string, bytes: string) {
            await page
              .locator('input[type="file"]')
              .setInputFiles({ name: filename, mimeType: "text/plain", buffer: Buffer.from(bytes) })
            await page.getByText(filename, { exact: true }).waitFor()
          }
          async function startWait(phase: string) {
            const command = `printf '%s' "$$" > ${phase}.pid; while [ ! -f ${phase}.release ]; do sleep 0.1; done; cat record.txt`
            const id = await submit(
              `Run this exact Bash command: <command>${command}</command> It waits for an external acceptance signal. Then return the complete file identifier. If paused, continue this same read after resuming. Do not delegate or run extra commands.`,
            )
            const pid = Number(
              await until(
                async () =>
                  Bun.file(path.join(project, `${phase}.pid`))
                    .text()
                    .catch(() => ""),
                (value) => /^\d+$/.test(value),
                settings.deadlineMs,
              ),
            )
            await until(
              () => control.getAttribute("aria-label"),
              (value) => value === "Pause",
              settings.deadlineMs,
            )
            return { id, pid }
          }
          const exited = async (pid: number) =>
            until(
              async () => {
                try {
                  process.kill(pid, 0)
                  return false
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
                  return true
                }
              },
              Boolean,
              settings.deadlineMs,
            )
          try {
            if (agent !== "synergy") {
              await page
                .locator(".prompt-input-toolbar-main")
                .getByRole("button", { name: "Synergy", exact: true })
                .click()
              const label = agent
                .split("-")
                .map((word) => word[0]!.toUpperCase() + word.slice(1))
                .join(" ")
              await page.getByText(label, { exact: true }).click()
            }
            await upload("desktop-record.txt", `Attachment record: ${attachment}\n`)
            const first = await submit(
              "Read the attached text and return its full record identifier. No tools are needed.",
            )
            const answer = await completed(first)
            const input = (await Session.messages({ sessionID: session.id })).find(
              (message) => message.info.id === first,
            )!
            const part = input.parts.find((part) => part.type === "attachment")
            if (!part || part.type !== "attachment" || !part.url.startsWith("asset://"))
              throw new Error("Desktop upload did not produce a managed attachment")
            const bytes = await Asset.read(part.url.slice("asset://".length))
            const inputs = await Promise.all(
              (await readRequests(context.directory)).map(
                async (request) =>
                  (await Bun.file(
                    path.join(context.directory, "requests", request.id, "request.bin"),
                  ).json()) as Record<string, unknown>,
              ),
            )
            attachmentRead =
              answer.includes(attachment) &&
              Boolean(bytes && (await bytes.text()).includes(attachment)) &&
              uploadedContentReachedModel(inputs, attachment)
            if (!attachmentRead) throw new Error("Model did not identify the actual Desktop attachment")
            physical.uploadHash = digest(await bytes!.bytes())
            await checkpoint("uploaded", "ui-uploaded")
            const paused = await startWait("pause")
            if (
              (await control.locator("svg rect").count()) !== 2 ||
              (await control.locator("svg circle").count()) !== 0
            )
              throw new Error("The active control does not use the plain pause glyph")
            await control.click()
            await until(
              () => Session.get(session.id),
              (value) => Boolean(value.paused),
              settings.deadlineMs,
            )
            await exited(paused.pid)
            await until(
              () => control.getAttribute("aria-label"),
              (value) => value === "Continue",
              settings.deadlineMs,
            )
            await checkpoint("paused", "paused")
            await editor.fill(`Draft ${draft}`)
            await upload("desktop-draft.txt", `Draft attachment ${draft}`)
            await until(
              () => page.evaluate(() => Object.values(localStorage).join("\n")),
              (value) => value.includes(draft),
              settings.deadlineMs,
            )
            await page.reload()
            await editor.waitFor()
            await until(
              () => editor.innerText(),
              (value) => value.includes(draft),
              settings.deadlineMs,
            )
            await page.getByText("desktop-draft.txt", { exact: true }).waitFor()
            draftPreserved = true
            await snapshot("draft-restored")
            await editor.fill("")
            await page.getByText("desktop-draft.txt", { exact: true }).hover()
            await page.getByRole("button", { name: "Remove desktop-draft.txt", exact: true }).click()
            await Bun.write(path.join(project, "pause.release"), "continue")
            await until(
              () => control.getAttribute("aria-label"),
              (value) => value === "Continue",
              settings.deadlineMs,
            )
            await control.click()
            await until(
              () => Session.get(session.id),
              (value) => !value.paused,
              settings.deadlineMs,
            )
            await until(
              async () =>
                (await Session.messages({ sessionID: session.id }))
                  .flatMap((message) => message.parts)
                  .some((part) => part.type === "text" && part.text.includes(marker)),
              Boolean,
              settings.deadlineMs,
            )
            await until(() => control.isDisabled(), Boolean, settings.deadlineMs)
            await checkpoint("continued", "continued")
            const cancelled = await startWait("cancel")
            const box = await control.boundingBox()
            if (!box) throw new Error("Cancel control is not visible")
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
            await page.mouse.down()
            try {
              await until(
                () => SessionInputStatus.get({ sessionID: session.id, messageID: cancelled.id }),
                (value) => value.state === "cancelled",
                settings.deadlineMs,
              )
            } finally {
              await page.mouse.up()
            }
            await exited(cancelled.pid)
            await checkpoint("cancelled", "cancelled")
            const final = await submit(
              "Return the complete identifier from the first uploaded desktop-record.txt attachment. Do not run tools or restart cancelled work.",
            )
            if (!(await completed(final)).includes(attachment))
              throw new Error("The normal input after cancellation did not complete correctly")
            await checkpoint("new-input", "new-input-completed")
            await page.getByRole("button", { name: /^Working location:/ }).click()
            await page.getByText("Choose Workspace", { exact: true }).click()
            await page.getByRole("dialog").getByRole("button", { name: binding.binding.path!, exact: true }).click()
            await page.getByRole("button", { name: "Use Workspace", exact: true }).click()
            await until(
              () => Session.get(session.id),
              (value) => value.workspaceID === binding.id,
              settings.deadlineMs,
            )
            await page.getByRole("button", { name: /^Working location:/ }).click()
            await page.getByText("Choose Environment", { exact: true }).click()
            await page
              .getByRole("dialog")
              .getByRole("button", { name: "No execution Environment", exact: true })
              .click()
            await page.getByRole("button", { name: "Use Environment", exact: true }).click()
            const selected = await until(
              () => Session.get(session.id),
              (value) => value.environmentID === null || value.environmentID === undefined,
              settings.deadlineMs,
            )
            await checkpoint("resources-switched", "resources-switched")
            controlsCorrect = true
            persistedStateMatches =
              selected.workspaceID === binding.id && !(await Bun.file(path.join(next, "cancel.pid")).exists())
            physical.pausedProcessExited = true
            physical.cancelledProcessExited = true
            physical.originalFile = digest(await Bun.file(path.join(project, "record.txt")).text())
            physical.newFile = digest(await Bun.file(path.join(next, "record.txt")).text())
          } catch (error) {
            await snapshot("failure").catch(() => {})
            throw error
          } finally {
            await SessionInvoke.cancel(session.id)
            await ui[Symbol.asyncDispose]()
            await atomicJSON(path.join(context.directory, "product.json"), snapshots)
          }
          const requests = await readRequests(context.directory)
          await atomicJSON(path.join(context.directory, "observations.json"), {
            attachmentRead,
            draftPreserved,
            controlsCorrect,
            persistedStateMatches,
          })
          await atomicJSON(path.join(context.directory, "physical.json"), physical)
          const uiFiles = (await fs.readdir(path.join(context.directory, "ui"))).filter(
            (file) => file.endsWith(".json") || file.endsWith(".png"),
          )
          return {
            status: "passed",
            model: "passed",
            barriers,
            requests,
            evidence: await Promise.all([
              sealEvidence(context.directory, "observations.json", "product"),
              sealEvidence(context.directory, "product.json", "product"),
              sealEvidence(context.directory, "physical.json", "external"),
              ...uiFiles.map((file) =>
                sealEvidence(context.directory, `ui/${file}`, file === "transport.json" ? "transport" : "external"),
              ),
            ]),
          }
        },
      })
    })
  }
}
