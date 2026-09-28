import fs from "node:fs/promises"
import path from "node:path"
import { ResourceProfiles } from "@ericsanchezok/synergy-local-runtime/environment/profiles"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInputStatus } from "@ericsanchezok/synergy-harness/session/input-status"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { acceptanceRuntime, until } from "./runtime"
import { atomicJSON, digest, sealEvidence } from "./evidence"
import { readRequests } from "./provider"
import { productWindow } from "./product-window"
import { configureRemote } from "./resources"
import { docker, RemoteSettings } from "./remote"
import type { Settings } from "./settings"
import type { Driver } from "./runner"

export function desktopRemote(input: Settings): Driver {
  const settings = RemoteSettings.parse(input)
  return async (context) => {
    if (!settings.artifacts?.web) throw new Error("Desktop acceptance requires a frozen Web artifact")
    const agent = context.scenario.agent
    if (agent !== "synergy") throw new Error("Remote Desktop acceptance requires the declared synergy primary")
    await using host = await acceptanceRuntime(context.directory, settings, {
      http: true,
      webAppDirectory: settings.artifacts.web,
    })
    return await host.runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          await configureRemote(settings.remote)
          const workspace = await ResourceProfiles.createWorkspace({
            scopeID: "home",
            profile: "files",
            name: "Remote Desktop files",
          })
          const selection = { scopeID: "home", workspaceID: workspace.id }
          const marker = crypto.randomUUID().replaceAll("-", "")
          await WorkspaceContent.write(selection, {
            path: "record.txt",
            data: Buffer.from(marker),
            expectedVersion: null,
          })
          const session = await Session.create({
            title: "Desktop remote acceptance",
            workspaceID: null,
            environmentID: null,
            agentOverride: agent,
            controlProfile: "full_access",
          })
          const url = `http://127.0.0.1:${host.runtime.server!.port}/aG9tZQ/session/${session.id}`
          const ui = await productWindow(path.join(context.directory, "ui"), url, settings, true)
          const { page } = ui
          const snapshots: Record<string, unknown> = {}
          const barriers: string[] = []
          const samples: Array<{ stage: string; containers: string[]; environment: Environment.Info }> = []
          let environmentID: string | undefined
          async function observe(stage: string) {
            if (!environmentID) throw new Error("No Environment was selected through the product")
            const containers = (
              await docker(settings.remote, ["ps", "-aq", "--filter", `label=io.synergy.environment=${environmentID}`])
            )
              .trim()
              .split("\n")
              .filter(Boolean)
            const environment = await Environment.get(environmentID, "home")
            const sample = { stage, containers, environment }
            samples.push(sample)
            return sample
          }
          async function checkpoint(name: string) {
            await ui.snapshot(name)
            snapshots[name] = {
              session: await Session.get(session.id),
              messages: await Session.messages({ sessionID: session.id }),
              environment: environmentID ? await Environment.get(environmentID, "home") : null,
            }
            await context.checkpoint(name, [
              { path: `ui/${name}.json`, kind: "product" },
              { path: `ui/${name}.png`, kind: "external" },
            ])
            barriers.push(name)
          }
          async function dialog(kind: "Workspace" | "Environment") {
            await page.getByRole("button", { name: /^Working location:/ }).click()
            await page.getByText(`Choose ${kind}`, { exact: true }).click()
            return page.getByRole("dialog")
          }
          try {
            const files = await dialog("Workspace")
            await files.getByRole("button", { name: "Remote Desktop files", exact: true }).click()
            await files.getByRole("button", { name: "Use Workspace", exact: true }).click()
            await until(
              () => Session.get(session.id),
              (value) => value.workspaceID === workspace.id,
              settings.deadlineMs,
            )
            const compute = await dialog("Environment")
            await compute.getByRole("button", { name: "remote", exact: true }).click()
            const environment = (
              await until(
                () => Environment.list("home"),
                (value) => value.some((item) => item.provider === "docker"),
                settings.deadlineMs,
              )
            ).find((item) => item.provider === "docker")!
            environmentID = environment.id
            const selected = compute.getByRole("button", { name: new RegExp(`docker · ${environmentID.slice(-8)}`) })
            await until(
              () => selected.getAttribute("aria-pressed"),
              (value) => value === "true",
              settings.deadlineMs,
            )
            await compute.getByRole("button", { name: "Use Environment", exact: true }).click()
            await until(
              () => Session.get(session.id),
              (value) => value.environmentID === environmentID,
              settings.deadlineMs,
            )
            const idle = await observe("selected")
            if (idle.containers.length || idle.environment.allocation || idle.environment.state !== "idle")
              throw new Error("Selecting remote compute allocated before a system operation")
            await checkpoint("selected-idle")
            const before = new Set((await Session.messages({ sessionID: session.id })).map((item) => item.info.id))
            await page
              .locator('[contenteditable="true"]')
              .fill(
                "Run this exact Bash command once: <command>cat record.txt | tee result.txt; printf x >> effects.txt</command> " +
                  "Return the complete file identifier from its output. Do not delegate or run extra commands.",
              )
            await page.locator(".prompt-input-submit").click()
            const sent = (await until(
              async () =>
                (await Session.messages({ sessionID: session.id })).find(
                  (message) => message.info.role === "user" && !before.has(message.info.id),
                ),
              Boolean,
              settings.deadlineMs,
            ))!
            if (sent.info.role !== "user" || sent.info.agent !== agent)
              throw new Error("Desktop did not submit the declared primary")
            const state = await until(
              () => SessionInputStatus.get({ sessionID: session.id, messageID: sent.info.id }),
              (value) => ["completed", "cancelled", "failed"].includes(value.state),
              settings.deadlineMs,
            )
            if (state.state !== "completed") throw new Error(`Remote Desktop input ended as ${state.state}`)
            const answer = (await Session.messages({ sessionID: session.id }))
              .filter((message) => message.info.role === "assistant" && message.info.parentID === sent.info.id)
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n")
            const active = await observe("completed")
            if (active.containers.length !== 1 || !active.environment.allocation)
              throw new Error("Desktop Bash did not allocate exactly one remote container")
            async function physical(file: string) {
              return docker(settings.remote, [
                "exec",
                active.containers[0]!,
                "find",
                "/workspaces",
                "-name",
                file,
                "-type",
                "f",
                "-exec",
                "cat",
                "{}",
                ";",
              ])
            }
            const remote = await physical("result.txt")
            const effects = await physical("effects.txt")
            if (remote !== marker || effects !== "x" || !answer.includes(marker))
              throw new Error("Remote physical files or model result differ from the requested single execution")
            await checkpoint("remote-task-completed")
            await page.reload()
            await page.locator(".prompt-input-submit").waitFor()
            const restoredFiles = await dialog("Workspace")
            const chosenFiles = restoredFiles.getByRole("button", { name: "Remote Desktop files", exact: true })
            await until(
              () => chosenFiles.getAttribute("aria-pressed"),
              (value) => value === "true",
              settings.deadlineMs,
            )
            await restoredFiles.getByRole("button", { name: "Use Workspace", exact: true }).click()
            const restoredCompute = await dialog("Environment")
            const chosenCompute = restoredCompute.getByRole("button", {
              name: new RegExp(`docker · ${environmentID.slice(-8)}`),
            })
            await until(
              () => chosenCompute.getAttribute("aria-pressed"),
              (value) => value === "true",
              settings.deadlineMs,
            )
            const persisted = await Session.get(session.id)
            if (persisted.workspaceID !== workspace.id || persisted.environmentID !== environmentID)
              throw new Error("Reloaded product resource selection diverges from persistence")
            await checkpoint("reloaded")
            await restoredCompute.getByRole("button", { name: "Save and release compute", exact: true }).click()
            await until(
              () => Environment.get(environmentID!, "home"),
              (value) => value.state === "idle" && !value.allocation,
              settings.deadlineMs,
            )
            const reclaimed = await observe("released")
            const saved = await WorkspaceContent.read(selection, "result.txt")
            const savedEffects = await WorkspaceContent.read(selection, "effects.txt")
            const original = await WorkspaceContent.read(selection, "record.txt")
            if (
              reclaimed.containers.length ||
              digest(saved) !== digest(remote) ||
              Buffer.from(savedEffects).toString() !== "x" ||
              Buffer.from(original).toString() !== marker
            )
              throw new Error("Product release lost saved bytes or retained remote compute")
            await until(
              () => chosenCompute.innerText(),
              (value) => value.includes("Not allocated"),
              settings.deadlineMs,
            )
            await checkpoint("reclaimed")
            await atomicJSON(path.join(context.directory, "physical.json"), {
              samples,
              effects,
              remoteHash: digest(remote),
              savedHash: digest(saved),
              originalHash: digest(original),
            })
            await atomicJSON(path.join(context.directory, "observations.json"), {
              idleAllocations: idle.containers.length,
              taskAllocations: active.containers.length,
              markerRecovered: answer.includes(marker),
              selectionPreserved: true,
              effects: savedEffects.byteLength,
              savedBytesPreserved: digest(saved) === digest(remote),
              remainingAllocations: reclaimed.containers.length,
            })
          } catch (error) {
            await ui.snapshot("failure").catch(() => {})
            throw error
          } finally {
            await SessionInvoke.cancel(session.id)
            await ui[Symbol.asyncDispose]()
            await atomicJSON(path.join(context.directory, "product.json"), snapshots)
            if (environmentID) await Environment.deallocate(environmentID, { scopeID: "home" })
          }
          const files = (await fs.readdir(path.join(context.directory, "ui"))).filter(
            (file) => file.endsWith(".json") || file.endsWith(".png"),
          )
          return {
            status: "passed",
            model: "passed",
            barriers,
            requests: await readRequests(context.directory),
            evidence: await Promise.all([
              sealEvidence(context.directory, "observations.json", "product"),
              sealEvidence(context.directory, "product.json", "product"),
              sealEvidence(context.directory, "physical.json", "external"),
              ...files.map((file) =>
                sealEvidence(context.directory, `ui/${file}`, file === "transport.json" ? "transport" : "external"),
              ),
            ]),
          }
        },
      }),
    )
  }
}
