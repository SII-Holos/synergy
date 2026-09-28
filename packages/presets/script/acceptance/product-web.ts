import fs from "node:fs/promises"
import path from "node:path"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionInputStatus } from "@ericsanchezok/synergy-harness/session/input-status"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { createUserMessage } from "@ericsanchezok/synergy-harness/session/input"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { Asset } from "@ericsanchezok/synergy-harness/asset/asset"
import { acceptanceRuntime, until } from "./runtime"
import { atomicJSON, digest, sealEvidence } from "./evidence"
import { readRequests } from "./provider"
import { productWindow } from "./product-window"
import type { Settings } from "./settings"
import type { Driver } from "./runner"

export function webReconnect(settings: Settings): Driver {
  return async (context) => {
    const agent = context.scenario.agent
    if (!agent) throw new Error("Product acceptance requires a declared primary agent")
    if (!settings.artifacts?.web) throw new Error("Web acceptance requires a frozen production artifact")
    await using host = await acceptanceRuntime(context.directory, settings, {
      http: true,
      webAppDirectory: settings.artifacts.web,
    })
    const project = path.join(context.directory, "project")
    await fs.mkdir(project)
    const marker = crypto.randomUUID().replaceAll("-", "")
    const draft = crypto.randomUUID().replaceAll("-", "")
    const firstReply = `Historical reply ${crypto.randomUUID()}`
    const badText = `Failed attachment ${crypto.randomUUID()}`
    await Bun.write(path.join(project, "record.txt"), marker)
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
            title: "Web recovery acceptance",
            controlProfile: "full_access",
            environmentID: environment.id,
          })
          for (let index = 0; index < 90; index++) {
            const user = await createUserMessage({
              sessionID: session.id,
              agent,
              model: host.model,
              parts: [{ type: "text", text: `Synthetic pagination fixture turn ${index}` }],
            })
            const id = Identifier.ascending("message")
            await Session.updateMessage({
              id,
              sessionID: session.id,
              role: "assistant",
              parentID: user.info.id,
              rootID: user.info.id,
              time: { created: Date.now(), completed: Date.now() },
              agent: agent,
              mode: agent,
              modelID: host.model.modelID,
              providerID: host.model.providerID,
              path: { cwd: project, root: project },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              finish: "stop",
            })
            await Session.updatePart({
              id: Identifier.ascending("part"),
              sessionID: session.id,
              messageID: id,
              type: "text",
              text: index === 0 ? firstReply : `Synthetic completed reply ${index}`,
            })
            await RolloutLedger.finishRun(RolloutLifecycle.owner(session), user.info.id, "completed")
          }
          const before = await Session.messages({ sessionID: session.id })
          const original = new Map(before.map((message) => [message.info.id, digest(JSON.stringify(message))]))
          const bad = await SessionInbox.enqueueUser({
            sessionID: session.id,
            agent: agent,
            model: host.model,
            parts: [
              { type: "text", text: badText },
              { type: "attachment", filename: "missing.txt", mime: "text/plain", url: "asset://0000000000000000.txt" },
            ],
          })
          await SessionManager.wake(session.id)
          await until(
            () => SessionInputStatus.get({ sessionID: session.id, messageID: bad.messageID }),
            (state) => state.state === "failed",
            settings.deadlineMs,
          )
          const url = `http://127.0.0.1:${host.runtime.server!.port}/${Buffer.from(scope.id).toString("base64url")}/session/${session.id}`
          const ui = await productWindow(path.join(context.directory, "ui"), url, settings, false)
          const { page } = ui
          const editor = page.locator('[contenteditable="true"]')
          const control = page.locator(".prompt-input-submit")
          const snapshots: Record<string, unknown> = { historyBefore: before }
          const barriers: string[] = []
          const checkpoint = async (name: string) => {
            await ui.snapshot(name)
            snapshots[name] = { session: await Session.get(session.id), inbox: await SessionInbox.list(session.id) }
            await context.checkpoint(name, [
              { path: `ui/${name}.json`, kind: "product" },
              { path: `ui/${name}.png`, kind: "external" },
            ])
            barriers.push(name)
          }
          async function submit(text: string) {
            const known = new Set((await Session.messages({ sessionID: session.id })).map((message) => message.info.id))
            await editor.fill(text)
            await control.click()
            const input = (await until(
              async () =>
                (await Session.messages({ sessionID: session.id })).find(
                  (message) => message.info.role === "user" && !known.has(message.info.id),
                ),
              Boolean,
              settings.deadlineMs,
            ))!
            if (input.info.role !== "user" || input.info.agent !== agent) throw new Error("Unexpected product agent")
            return input.info.id
          }
          async function complete(messageID: string) {
            const state = await until(
              () => SessionInputStatus.get({ sessionID: session.id, messageID }),
              (value) => ["completed", "failed", "cancelled"].includes(value.state),
              settings.deadlineMs,
            )
            if (state.state !== "completed") throw new Error(`Web input ended as ${state.state}`)
            return (await Session.messages({ sessionID: session.id }))
              .filter((message) => message.info.role === "assistant" && message.info.parentID === messageID)
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n")
          }
          let oldRepliesPreserved = false
          let pendingInputPreserved = false
          let draftPreserved = false
          let errorAttribution = false
          try {
            for (
              let attempt = 0;
              attempt < 8 && !(await page.getByText(firstReply, { exact: true }).count());
              attempt++
            ) {
              const button = page.getByRole("button", { name: "Load earlier messages", exact: true })
              await button.click()
              await until(
                async () =>
                  (await page.getByText(firstReply, { exact: true }).count()) > 0 ||
                  ((await button.count()) > 0 && (await button.isEnabled())),
                Boolean,
                settings.deadlineMs,
              )
            }
            await page.getByText(firstReply, { exact: true }).waitFor()
            const paged = ui.events.some(
              (event) =>
                event.type === "http" &&
                typeof event.value === "object" &&
                event.value !== null &&
                "url" in event.value &&
                String(event.value.url).includes("/message/page?") &&
                new URL(String(event.value.url)).searchParams.has("cursor"),
            )
            if (!paged) throw new Error("The Web scenario did not fetch an older history cursor")
            await checkpoint("history-paged")
            const command =
              "printf x >> effect.txt; printf '%s' \"$$\" > reconnect.pid; while [ ! -f reconnect.release ]; do sleep 0.1; done; cat record.txt"
            const pending = await submit(
              `Run this exact Bash command: <command>${command}</command> Wait for its completion, then return the full file identifier. Do not delegate or repeat the command.`,
            )
            const pid = Number(
              await until(
                async () =>
                  Bun.file(path.join(project, "reconnect.pid"))
                    .text()
                    .catch(() => ""),
                (value) => /^\d+$/.test(value),
                settings.deadlineMs,
              ),
            )
            await checkpoint("input-pending")
            const draftText = "Read the attached draft record and return its complete identifier. Do not run tools."
            await editor.fill(draftText)
            await page.locator('input[type="file"]').setInputFiles({
              name: "web-draft.txt",
              mimeType: "text/plain",
              buffer: Buffer.from(`Attachment record: ${draft}\n`),
            })
            await page.getByText("web-draft.txt", { exact: true }).waitFor()
            await until(
              () => page.evaluate(() => Object.values(localStorage).join("\n")),
              (value) => value.includes(draftText) && value.includes("web-draft.txt"),
              settings.deadlineMs,
            )
            await ui.disconnect()
            await checkpoint("disconnected")
            await page.reload()
            await editor.waitFor()
            await until(
              () => editor.innerText(),
              (value) => value === draftText,
              settings.deadlineMs,
            )
            await page.getByText("web-draft.txt", { exact: true }).waitFor()
            const pendingState = await SessionInputStatus.get({ sessionID: session.id, messageID: pending })
            if (["completed", "cancelled", "failed"].includes(pendingState.state))
              throw new Error("Pending input ended during disconnection")
            process.kill(pid, 0)
            await checkpoint("refreshed")
            const reconnectStart = ui.events.length
            ui.reconnect()
            await until(
              async () => ui.events.slice(reconnectStart).some((event) => event.type === "ws-server"),
              Boolean,
              settings.deadlineMs,
            )
            await page.getByText("Running", { exact: true }).first().waitFor()
            await checkpoint("reconnected")
            await Bun.write(path.join(project, "reconnect.release"), "continue")
            if (!(await complete(pending)).includes(marker)) throw new Error("Reconnected input lost its file result")
            await page.getByText(marker, { exact: true }).waitFor()
            pendingInputPreserved = (await Bun.file(path.join(project, "effect.txt")).text()) === "x"
            const failedRow = page.locator('[data-slot="pending-timeline-item"]').filter({ hasText: badText })
            const failed = (await SessionInbox.list(session.id)).find((item) => item.messageID === bad.messageID)
            if (!failed?.failReason) throw new Error("Failed attachment has no attributable reason")
            await failedRow.getByTitle(failed.failReason, { exact: true }).waitFor()
            const draftInput = await submit(draftText)
            if (!(await complete(draftInput)).includes(draft))
              throw new Error("Restored draft attachment did not reach the model")
            const messages = await Session.messages({ sessionID: session.id })
            const part = messages
              .find((message) => message.info.id === draftInput)
              ?.parts.find((part) => part.type === "attachment")
            if (!part || part.type !== "attachment" || !part.url.startsWith("asset://"))
              throw new Error("Restored draft is not a managed attachment")
            const bytes = await Asset.read(part.url.slice(8))
            draftPreserved = Boolean(bytes && (await bytes.text()).includes(draft))
            oldRepliesPreserved =
              original.size === 180 &&
              messages
                .filter((message) => original.has(message.info.id))
                .every((message) => original.get(message.info.id) === digest(JSON.stringify(message))) &&
              messages.filter((message) => original.has(message.info.id)).length === original.size
            const requests = await readRequests(context.directory)
            const transmitted = (
              await Promise.all(
                requests.map((request) =>
                  Bun.file(path.join(context.directory, "requests", request.id, "request.bin")).text(),
                ),
              )
            ).join("\n")
            errorAttribution =
              (await SessionInputStatus.get({ sessionID: session.id, messageID: bad.messageID })).state === "failed" &&
              (await SessionInputStatus.get({ sessionID: session.id, messageID: pending })).state === "completed" &&
              !transmitted.includes(badText)
            snapshots.historyAfter = messages
            await atomicJSON(path.join(context.directory, "physical.json"), {
              effects: (await Bun.file(path.join(project, "effect.txt")).text()).length,
              record: digest(await Bun.file(path.join(project, "record.txt")).text()),
              attachment: digest(await bytes!.bytes()),
              originalMessages: original.size,
            })
            await checkpoint("input-completed")
          } catch (error) {
            await ui.snapshot("failure").catch(() => {})
            throw error
          } finally {
            await SessionInvoke.cancel(session.id)
            await ui[Symbol.asyncDispose]()
            await atomicJSON(path.join(context.directory, "product.json"), snapshots)
          }
          await atomicJSON(path.join(context.directory, "observations.json"), {
            oldRepliesPreserved,
            pendingInputPreserved,
            draftPreserved,
            errorAttribution,
          })
          return {
            status: "passed",
            model: "passed",
            barriers,
            requests: await readRequests(context.directory),
            evidence: await Promise.all([
              sealEvidence(context.directory, "observations.json", "product"),
              sealEvidence(context.directory, "product.json", "product"),
              sealEvidence(context.directory, "physical.json", "external"),
              sealEvidence(context.directory, "ui/transport.json", "transport"),
              sealEvidence(context.directory, "ui/closed.json", "external"),
            ]),
          }
        },
      })
    })
  }
}
