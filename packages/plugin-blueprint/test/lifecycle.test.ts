import { expect, test } from "bun:test"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { Cortex } from "@ericsanchezok/synergy-harness/cortex"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { NoteMarkdown, NoteStore } from "@ericsanchezok/synergy-note"
import { NoteReadTool } from "@ericsanchezok/synergy-note/tools/note-read"
import { hash as sha256 } from "@ericsanchezok/synergy-util/encode"
import { hasDeadlineTimer } from "@ericsanchezok/synergy-blueprint/blueprint/deadline"
import { LoopEvent } from "@ericsanchezok/synergy-blueprint/blueprint/event"
import { BlueprintLoopStore } from "@ericsanchezok/synergy-blueprint/blueprint/loop-store"
import { BlueprintLoopService } from "@ericsanchezok/synergy-blueprint/blueprint/service"
import { BlueprintPluginErrorCode, cancelBlueprint, getBlueprint, startBlueprint } from "../src/adapter"
import { auditAgent, executionAgent, generation, pluginID, withLifecycle } from "./support/lifecycle"

test(
  "starts one hidden execution against its frozen Note and cancels its resources",
  () =>
    withLifecycle(async ({ parent, input, boundary, receipts }) => {
      expect(Agent.pluginOwner((await Agent.get(executionAgent))!)).toEqual({
        pluginId: pluginID,
        pluginGeneration: generation,
      })
      const loop = await startBlueprint(input)
      const call = await boundary.started(loop.sessionID)
      const session = await Session.get(loop.sessionID)
      const note = await NoteStore.get(parent.scope.id, loop.noteID)
      const task = Cortex.get(session.cortex!.taskID)!
      expect(loop).toMatchObject({
        status: "running",
        title: "Release contract",
        description: "Independently reviewed release",
        source: "plugin",
        executionAgent,
        auditAgent,
        noteVersion: 1,
        sourceDigest: input.request.sourceDigest,
        pluginOwner: {
          pluginId: pluginID,
          pluginGeneration: generation,
          scopeId: parent.scope.id,
          correlationId: "release-one",
        },
        executionTools: input.request.executionTools,
        auditTools: input.request.auditTools,
      })
      expect(note.kind).toBe("blueprint")
      expect(NoteMarkdown.toMarkdown(note.content).trim()).toBe(input.request.markdown)
      expect(loop.sourceDigest).toBe(await sha256(NoteMarkdown.toMarkdown(note.content).trim()))
      const noteRead = await NoteReadTool.init()
      const firstRead = task.prompt.match(/note_read with (\w+)=(\[[^\]]+\])/)
      if (!firstRead) throw new Error("Execution prompt has no note_read call")
      const noteReadInput = noteRead.parameters.parse({ [firstRead[1]]: JSON.parse(firstRead[2]) })
      expect(noteReadInput.noteIds).toEqual([loop.noteID])
      const firstModelPrompt = call.messages
        .flatMap((message) =>
          typeof message.content === "string"
            ? [message.content]
            : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
        )
        .join("\n")
      expect(firstModelPrompt).toContain(task.prompt)
      const read = await noteRead.execute(noteReadInput, {
        sessionID: session.id,
        messageID: call.user.id,
        agent: executionAgent,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
      })
      expect(read.output).toContain(input.request.markdown)
      expect(session).toMatchObject({
        parentID: parent.id,
        workspace: parent.workspace,
        cortex: { visibility: "hidden", notifyParentOnComplete: false, status: "running", agent: executionAgent },
        blueprint: { loopID: loop.id, loopRole: "execution", phase: "running", source: "plugin" },
        completionNotice: { silent: true },
      })
      expect((await Session.children(parent.id)).map((child) => child.id)).toEqual([session.id])
      expect(task).toMatchObject({
        sessionID: session.id,
        parentSessionID: parent.id,
        parentMessageID: input.context.parentMessageID,
      })
      expect(task.prompt).toContain(loop.noteID)
      expect(task.prompt).toContain(loop.id)
      expect(task.prompt).not.toContain(input.request.markdown)
      expect(call.agent.name).toBe(executionAgent)
      const roots = (await Session.messages({ sessionID: session.id, raw: true })).filter(
        (message) => message.info.role === "user" && message.info.isRoot,
      )
      expect(roots).toHaveLength(1)
      expect(
        roots[0].parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      ).toContain(task.prompt)
      expect(hasDeadlineTimer(parent.scope.id, loop.id)).toBe(true)
      const access = { scopeId: parent.scope.id, loopID: loop.id, pluginId: pluginID, pluginGeneration: generation }
      expect(await getBlueprint(access)).toMatchObject({ id: loop.id, status: "running" })

      const cancelled = await cancelBlueprint(access)
      expect(call.abort.aborted).toBe(true)
      await Cortex.drain(task.id)
      expect(cancelled.status).toBe("cancelled")
      expect(Cortex.get(task.id)?.status).toBe("cancelled")
      expect((await Session.get(session.id)).time.archived).toBeNumber()
      expect((await Session.get(session.id)).blueprint?.loopID).toBeUndefined()
      expect((await NoteStore.get(parent.scope.id, note.id)).archived).toBe(true)
      expect((await NoteStore.list(parent.scope.id)).some((item) => item.id === note.id)).toBe(false)
      expect(hasDeadlineTimer(parent.scope.id, loop.id)).toBe(false)
      expect(await receipts()).toMatchObject([
        { loop: { id: loop.id, status: "cancelled" }, sessionId: session.id, generation },
      ])
      const terminal = await BlueprintLoopStore.get(parent.scope.id, loop.id)
      expect(terminal.terminalHookDeliveredAt).toBeNumber()
      await BlueprintLoopStore.deliverTerminalHook(parent.scope.id, loop.id)
      expect(await receipts()).toHaveLength(1)
      expect((await Session.get(parent.id)).time.archived).toBeUndefined()
    }),
  20000,
)

test(
  "the runtime budget fails a live plugin loop and reclaims its execution resources",
  () =>
    withLifecycle(async ({ parent, input, boundary, receipts }) => {
      const expired = Promise.withResolvers<void>()
      const unsubscribe = Bus.subscribe(LoopEvent.Updated, (event) => {
        if (event.properties.loop.status === "failed") expired.resolve()
      })
      try {
        const loop = await startBlueprint({
          ...input,
          request: { ...input.request, budget: { maxRuntimeMs: 1500, maxIterations: 3 } },
        })
        await boundary.started(loop.sessionID)
        const execution = await Session.get(loop.sessionID)
        await expired.promise
        await Cortex.drain(execution.cortex!.taskID)
        await BlueprintLoopStore.deliverTerminalHook(parent.scope.id, loop.id)
        expect(
          await getBlueprint({
            scopeId: parent.scope.id,
            loopID: loop.id,
            pluginId: pluginID,
            pluginGeneration: generation,
          }),
        ).toMatchObject({
          status: "failed",
          error: "timed_out: budget maxRuntimeMs exceeded",
        })
        const task = Cortex.get(execution.cortex!.taskID)
        if (!task) throw new Error("Execution task disappeared before disposal")
        expect(["cancelled", "error"]).toContain(task.status)
        expect((await Session.get(execution.id)).time.archived).toBeNumber()
        expect((await Session.get(execution.id)).blueprint?.loopID).toBeUndefined()
        expect((await NoteStore.get(parent.scope.id, loop.noteID)).archived).toBe(true)
        expect(hasDeadlineTimer(parent.scope.id, loop.id)).toBe(false)
        expect(await receipts()).toMatchObject([{ loop: { id: loop.id, status: "failed" } }])
        expect((await Session.get(parent.id)).time.archived).toBeUndefined()
      } finally {
        unsubscribe()
      }
    }),
  20000,
)

test(
  "cancel stops the audit task and rejects repeat cancellation after Session cleanup",
  () =>
    withLifecycle(async ({ parent, input, boundary, receipts }) => {
      const loop = await startBlueprint(input)
      await boundary.started(loop.sessionID)
      const execution = await Session.get(loop.sessionID)
      const audit = await Cortex.prepare({
        description: "Review the Blueprint",
        prompt: "Audit the execution evidence",
        agent: auditAgent,
        parentSessionID: execution.id,
        parentMessageID: Identifier.ascending("message"),
        model: input.request.executionModel,
        executionRole: "delegated_subagent",
        notifyParentOnComplete: false,
      })
      await BlueprintLoopService.bindSessionToLoop(audit.sessionID, loop.id, "audit")
      await BlueprintLoopStore.updateStatus(parent.scope.id, loop.id, {
        status: "auditing",
        auditSessionID: audit.sessionID,
        auditTaskID: audit.id,
      })
      await cancelBlueprint({
        scopeId: parent.scope.id,
        loopID: loop.id,
        pluginId: pluginID,
        pluginGeneration: generation,
      })
      await Cortex.drain(execution.cortex!.taskID)
      expect(Cortex.get(execution.cortex!.taskID)?.status).toBe("cancelled")
      expect(Cortex.get(audit.id)?.status).toBe("cancelled")
      expect((await Session.get(audit.sessionID)).cortex?.status).toBe("cancelled")
      expect((await Session.get(audit.sessionID)).blueprint?.loopID).toBeUndefined()
      expect((await Session.get(execution.id)).blueprint?.loopID).toBeUndefined()
      expect(await receipts()).toHaveLength(1)
      expect(hasDeadlineTimer(parent.scope.id, loop.id)).toBe(false)
      await Session.remove(execution.id)
      await expect(
        cancelBlueprint({
          scopeId: parent.scope.id,
          loopID: loop.id,
          pluginId: pluginID,
          pluginGeneration: generation,
        }),
      ).rejects.toMatchObject({ data: { from: "cancelled", to: "cancelled" } })
      expect(await receipts()).toHaveLength(1)
      expect((await Session.get(parent.id)).time.archived).toBeUndefined()
    }),
  20000,
)

test(
  "Cortex shutdown before admission rolls back the created Note, Session and loop",
  () =>
    withLifecycle(async ({ parent, input, boundary, receipts }) => {
      await Cortex.stop()
      await expect(startBlueprint(input)).rejects.toThrow("Cortex is stopping")
      const loops = await BlueprintLoopStore.list(parent.scope.id)
      expect(loops).toHaveLength(1)
      const loop = loops[0]
      expect(loop.status).toBe("cancelled")
      expect((await NoteStore.get(parent.scope.id, loop.noteID)).archived).toBe(true)
      expect(await NoteStore.list(parent.scope.id)).toEqual([])
      expect((await Session.get(loop.sessionID)).time.archived).toBeNumber()
      expect((await Session.get(loop.sessionID)).blueprint?.loopID).toBeUndefined()
      expect(Cortex.list()).toEqual([])
      expect(boundary.calls).toEqual([])
      expect(hasDeadlineTimer(parent.scope.id, loop.id)).toBe(false)
      expect(await receipts()).toMatchObject([{ loop: { id: loop.id, status: "cancelled" } }])
      expect((await Session.get(parent.id)).time.archived).toBeUndefined()
    }),
  20000,
)

test(
  "foreign plugin generations cannot inspect or cancel a live owned loop",
  () =>
    withLifecycle(async ({ parent, input, boundary }) => {
      const loop = await startBlueprint(input)
      await boundary.started(loop.sessionID)
      const access = { scopeId: parent.scope.id, loopID: loop.id, pluginId: pluginID, pluginGeneration: generation }
      for (const wrong of [
        { pluginId: "another-plugin" },
        { pluginGeneration: "generation-two" },
        { scopeId: "home" },
      ]) {
        await expect(getBlueprint({ ...access, ...wrong })).rejects.toMatchObject({
          code: BlueprintPluginErrorCode.NOT_FOUND,
        })
        await expect(cancelBlueprint({ ...access, ...wrong })).rejects.toMatchObject({
          code: BlueprintPluginErrorCode.NOT_FOUND,
        })
      }
      expect((await getBlueprint(access)).status).toBe("running")
      const session = await Session.get(loop.sessionID)
      expect(Cortex.get(session.cortex!.taskID)?.status).toBe("running")
      expect((await NoteStore.get(parent.scope.id, loop.noteID)).archived).not.toBe(true)
      await cancelBlueprint(access)
      await Cortex.drain(session.cortex!.taskID)
    }),
  20000,
)
