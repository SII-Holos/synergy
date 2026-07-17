import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { Identifier } from "../../src/id/id"
import { migrations } from "../../src/session/migration"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { SnapshotSchema } from "../../src/session/snapshot-schema"
import { SessionBounds } from "../../src/session/bounds"
import { Worktree } from "../../src/project/worktree"

const projectRoot = path.join(__dirname, "../..")

async function addUserMessage(sessionID: string) {
  return Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    agent: "test",
    model: { providerID: "test-provider", modelID: "test-model" },
    time: { created: Date.now() },
  })
}

async function addTerminalAssistantMessage(sessionID: string, parentID: string) {
  return Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "assistant",
    parentID,
    time: { created: Date.now(), completed: Date.now() },
    modelID: "test-model",
    providerID: "test-provider",
    path: { cwd: projectRoot, root: projectRoot },
    mode: "test",
    agent: "test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  })
}

describe("session migrations", () => {
  test("builds child session indexes from existing session info files", async () => {
    await using tmp = await tmpdir({ git: true })
    const tmpScope = await tmp.scope()

    await ScopeContext.provide({
      scope: tmpScope,
      fn: async () => {
        const parent = await Session.create({ title: "Parent" })
        const childA = await Session.create({ title: "Child A", parentID: parent.id })
        const childB = await Session.create({ title: "Child B", parentID: parent.id })
        const scope = Identifier.asScopeID(tmpScope.id)

        await Storage.removeTree(StoragePath.sessionChildIndexRoot(scope))
        expect((await Session.readChildIndex(tmpScope.id, parent.id)).entries).toEqual([])

        const migration = migrations.find((entry) => entry.id === "20260702-session-child-index")
        expect(migration).toBeDefined()
        await migration!.up(() => {})

        const index = await Session.readChildIndex(tmpScope.id, parent.id)
        expect(index.scopeID).toBe(tmpScope.id)
        expect(index.parentID).toBe(parent.id)
        expect(index.entries.map((entry) => entry.id).sort()).toEqual([childA.id, childB.id].sort())
        expect(index.entries.find((entry) => entry.id === childA.id)?.title).toBe("Child A")

        await Session.remove(parent.id)
      },
    })
  })

  test("migrates legacy route-directory worktree sessions to workspace metadata", async () => {
    await using tmp = await tmpdir({ git: true })
    const tmpScope = await tmp.scope()

    await ScopeContext.provide({
      scope: tmpScope,
      fn: async () => {
        const session = await Session.create({ title: "Legacy Worktree Session" })
        const worktree = await Worktree.create({ name: "legacy-migration", bind: false, baseRef: "current" })
        const scope = Identifier.asScopeID(tmpScope.id)
        const sid = Identifier.asSessionID(session.id)
        const legacyScope = {
          ...(session.scope as any),
          directory: worktree.path,
          worktree: tmpScope.worktree,
          sandboxes: [worktree.path],
        }
        await Storage.write(StoragePath.sessionInfo(scope, sid), {
          ...session,
          scope: legacyScope,
          workspace: { type: "main", path: worktree.path, scopeID: tmpScope.id },
        })
        await Storage.write(StoragePath.sessionIndex(sid), {
          sessionID: session.id,
          scopeID: tmpScope.id,
          directory: worktree.path,
        })

        const migration = migrations.find((entry) => entry.id === "20260703-session-worktree-workspace")
        expect(migration).toBeDefined()
        await migration!.up(() => {})

        const migrated = await Storage.read<any>(StoragePath.sessionInfo(scope, sid))
        expect(migrated.scope.directory).toBe(tmpScope.worktree)
        expect(migrated.workspace.type).toBe("git_worktree")
        expect(migrated.workspace.path).toBe(worktree.path)
        expect(migrated.workspace.worktreeID).toBe(worktree.id)
        expect(migrated.workspace.name).toBe(worktree.name)
        expect(migrated.workspace.originalCheckout).toBe(tmpScope.worktree)

        const index = await Storage.read<any>(StoragePath.sessionIndex(sid))
        expect(index.directory).toBe(tmpScope.worktree)

        await Worktree.remove({ sessionID: session.id, target: worktree.id, force: true })
        await Session.remove(session.id)
      },
    })
  })

  test("repairs stale pendingReply flags without clearing genuinely pending sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const completed = await Session.create({})
        const completedUser = await addUserMessage(completed.id)
        await addTerminalAssistantMessage(completed.id, completedUser.id)
        await Session.update(completed.id, (draft) => {
          draft.pendingReply = true
        })

        const pending = await Session.create({})
        await addUserMessage(pending.id)
        await Session.update(pending.id, (draft) => {
          draft.pendingReply = true
        })

        const migration = migrations.find((entry) => entry.id === "20260619-session-repair-stale-pending-reply")
        expect(migration).toBeDefined()
        await migration!.up(() => {})

        const completedAfter = await SessionManager.getSession(completed.id)
        const pendingAfter = await SessionManager.getSession(pending.id)

        expect(completedAfter?.pendingReply).toBeUndefined()
        expect(pendingAfter?.pendingReply).toBe(true)
      },
    })
  })

  test("recomputes pendingReply from assistant parent links and skips archived sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const swallowed = await Session.create({})
        const swallowedFirstUser = await addUserMessage(swallowed.id)
        await addTerminalAssistantMessage(swallowed.id, swallowedFirstUser.id)
        await addUserMessage(swallowed.id)
        await addTerminalAssistantMessage(swallowed.id, swallowedFirstUser.id)

        const completed = await Session.create({})
        const completedUser = await addUserMessage(completed.id)
        await addTerminalAssistantMessage(completed.id, completedUser.id)
        await Session.update(completed.id, (draft) => {
          draft.pendingReply = true
        })

        const archived = await Session.create({})
        await addUserMessage(archived.id)
        await Session.update(archived.id, (draft) => {
          draft.pendingReply = undefined
          draft.time.archived = Date.now()
        })

        const migration = migrations.find((entry) => entry.id === "20260703-session-parent-pending-reply")
        expect(migration).toBeDefined()
        await migration!.up(() => {})

        const swallowedAfter = await SessionManager.getSession(swallowed.id)
        const completedAfter = await SessionManager.getSession(completed.id)
        const archivedAfter = await SessionManager.getSession(archived.id)

        expect(swallowedAfter?.pendingReply).toBe(true)
        expect(completedAfter?.pendingReply).toBeUndefined()
        expect(archivedAfter?.pendingReply).toBeUndefined()
      },
    })
  })

  test("normalizes completion notices and rebuilds nav entries", async () => {
    await using tmp = await tmpdir({ git: true })
    const tmpScope = await tmp.scope()

    await ScopeContext.provide({
      scope: tmpScope,
      fn: async () => {
        const legacy = await Session.create({ title: "Legacy Notice" })
        const preserved = await Session.create({ title: "Preserved Notice" })
        const silent = await Session.create({ title: "Silent Notice" })
        const scope = Identifier.asScopeID(tmpScope.id)

        const legacyKey = StoragePath.sessionInfo(scope, Identifier.asSessionID(legacy.id))
        const legacyInfo = await Storage.read<any>(legacyKey)
        delete legacyInfo.completionNotice
        await Storage.write(legacyKey, legacyInfo)

        const preservedKey = StoragePath.sessionInfo(scope, Identifier.asSessionID(preserved.id))
        await Storage.write(preservedKey, {
          ...(await Storage.read<any>(preservedKey)),
          completionNotice: { unread: true, silent: false },
        })

        const silentKey = StoragePath.sessionInfo(scope, Identifier.asSessionID(silent.id))
        await Storage.write(silentKey, {
          ...(await Storage.read<any>(silentKey)),
          completionNotice: { unread: true, silent: true },
        })

        await Storage.write(StoragePath.sessionNavIndex(scope), {
          version: 1,
          scopeID: tmpScope.id,
          updatedAt: Date.now(),
          entries: [
            {
              id: legacy.id,
              scopeID: tmpScope.id,
              scopeType: "project",
              title: legacy.title,
              category: "project",
              lastActivityAt: legacy.time.updated,
              pinned: 0,
              archived: false,
            },
          ],
        })

        const migration = migrations.find((entry) => entry.id === "20260703-session-completion-notice")
        expect(migration).toBeDefined()
        await migration!.up(() => {})

        expect((await Storage.read<any>(legacyKey)).completionNotice).toEqual({ unread: false, silent: false })
        expect((await Storage.read<any>(preservedKey)).completionNotice).toEqual({ unread: true, silent: false })
        expect((await Storage.read<any>(silentKey)).completionNotice).toEqual({ unread: false, silent: true })

        const nav = await Storage.read<any>(StoragePath.sessionNavIndex(scope))
        expect(nav.entries.find((entry: any) => entry.id === legacy.id).completionNotice).toEqual({ unread: false })
        expect(nav.entries.find((entry: any) => entry.id === preserved.id).completionNotice).toEqual({ unread: true })

        await Session.remove(legacy.id)
        await Session.remove(preserved.id)
        await Session.remove(silent.id)
      },
    })
  })

  test("migrates legacy file parts and artifact-only tool metadata to attachments", async () => {
    await using tmp = await tmpdir({ git: true })
    const tmpScope = await tmp.scope()
    await ScopeContext.provide({
      scope: tmpScope,
      fn: async () => {
        const session = await Session.create({})
        const user = await addUserMessage(session.id)
        const assistant = await addTerminalAssistantMessage(session.id, user.id)
        const scope = Identifier.asScopeID(tmpScope.id)
        const sid = Identifier.asSessionID(session.id)
        const userMessage = Identifier.asMessageID(user.id)
        const assistantMessage = Identifier.asMessageID(assistant.id)

        await Storage.write(StoragePath.messagePart(scope, sid, userMessage, Identifier.asPartID("part_file")), {
          id: "part_file",
          sessionID: session.id,
          messageID: user.id,
          type: "file",
          mime: "image/png",
          filename: "old.png",
          url: "data:image/png;base64,AAAA",
          metadata: { kind: "artifact", artifact: { sourcePath: "/tmp/old.png", size: 4 } },
        })

        await Storage.write(StoragePath.messagePart(scope, sid, assistantMessage, Identifier.asPartID("part_tool")), {
          id: "part_tool",
          sessionID: session.id,
          messageID: assistant.id,
          type: "tool",
          callID: "call_1",
          tool: "plugin_test",
          state: {
            status: "completed",
            input: {},
            output: "",
            title: "Plugin",
            metadata: {
              display: {
                visibility: "media",
                presentation: "artifact-only",
                primaryAttachmentIds: ["tool_file"],
              },
            },
            time: { start: 1, end: 2 },
            attachments: [
              {
                id: "tool_file",
                sessionID: session.id,
                messageID: assistant.id,
                type: "file",
                mime: "image/png",
                filename: "tool.png",
                url: "asset://tool.png",
                metadata: { kind: "artifact", artifact: { originTool: "plugin_test", size: 12 } },
              },
              {
                id: "secondary_file",
                sessionID: session.id,
                messageID: assistant.id,
                type: "file",
                mime: "text/plain",
                filename: "notes.txt",
                url: "asset://notes.txt",
              },
            ],
          },
        })

        const migration = migrations.find((entry) => entry.id === "20260630-session-attachment-parts")
        expect(migration).toBeDefined()
        await migration!.up(() => {})

        const userPart = await Storage.read<any>(
          StoragePath.messagePart(scope, sid, userMessage, Identifier.asPartID("part_file")),
        )
        expect(userPart.type).toBe("attachment")
        expect(userPart.presentation).toBeUndefined()
        expect(userPart.model).toEqual({ mode: "provider-file", summary: "old.png (image/png)" })
        expect(userPart.metadata).toEqual({
          kind: "attachment",
          attachment: { sourcePath: "/tmp/old.png", size: 4 },
        })

        const toolPart = await Storage.read<any>(
          StoragePath.messagePart(scope, sid, assistantMessage, Identifier.asPartID("part_tool")),
        )
        expect(toolPart.state.metadata.display).toEqual({
          kind: "media-generation",
          toolCard: "hidden",
        })
        expect(toolPart.state.attachments[0].type).toBe("attachment")
        expect(toolPart.state.attachments[0].presentation).toBeUndefined()
        expect(toolPart.state.attachments[0].model).toEqual({
          mode: "summary",
          summary: "tool.png (image/png)",
        })
        expect(toolPart.state.attachments[0].metadata).toEqual({
          kind: "attachment",
          attachment: { originTool: "plugin_test", size: 12 },
        })
        expect(toolPart.state.attachments[1].type).toBe("attachment")
        expect(toolPart.state.attachments[1].presentation).toEqual({ hidden: true })
      },
    })
  })

  test("migrates media display visibility into explicit hidden tool card policy", async () => {
    await using tmp = await tmpdir({ git: true })
    const tmpScope = await tmp.scope()
    await ScopeContext.provide({
      scope: tmpScope,
      fn: async () => {
        const session = await Session.create({})
        const user = await addUserMessage(session.id)
        const assistant = await addTerminalAssistantMessage(session.id, user.id)
        const scope = Identifier.asScopeID(tmpScope.id)
        const sid = Identifier.asSessionID(session.id)
        const assistantMessage = Identifier.asMessageID(assistant.id)

        await Storage.write(StoragePath.messagePart(scope, sid, assistantMessage, Identifier.asPartID("part_tool")), {
          id: "part_tool",
          sessionID: session.id,
          messageID: assistant.id,
          type: "tool",
          callID: "call_1",
          tool: "plugin_test",
          state: {
            status: "completed",
            input: {},
            output: "",
            title: "Plugin",
            metadata: { display: { visibility: "media", presentation: "attachment-only" } },
            time: { start: 1, end: 2 },
            attachments: [],
          },
        })

        const migration = migrations.find((entry) => entry.id === "20260630-session-tool-card-display")
        expect(migration).toBeDefined()
        await migration!.up(() => {})

        const toolPart = await Storage.read<any>(
          StoragePath.messagePart(scope, sid, assistantMessage, Identifier.asPartID("part_tool")),
        )
        expect(toolPart.state.metadata.display).toEqual({
          kind: "media-generation",
          toolCard: "hidden",
        })
      },
    })
  })

  test("normalizes legacy attachment presentation fields after earlier migrations have run", async () => {
    await using tmp = await tmpdir({ git: true })
    const tmpScope = await tmp.scope()
    await ScopeContext.provide({
      scope: tmpScope,
      fn: async () => {
        const session = await Session.create({})
        const user = await addUserMessage(session.id)
        const assistant = await addTerminalAssistantMessage(session.id, user.id)
        const scope = Identifier.asScopeID(tmpScope.id)
        const sid = Identifier.asSessionID(session.id)
        const assistantMessage = Identifier.asMessageID(assistant.id)

        await Storage.write(StoragePath.messagePart(scope, sid, assistantMessage, Identifier.asPartID("part_tool")), {
          id: "part_tool",
          sessionID: session.id,
          messageID: assistant.id,
          type: "tool",
          callID: "call_1",
          tool: "plugin_test",
          state: {
            status: "completed",
            input: {},
            output: "",
            title: "Plugin",
            metadata: {
              display: { presentation: "attachment-only", primaryAttachmentIds: ["primary"] },
              primaryAttachmentIds: ["primary"],
            },
            time: { start: 1, end: 2 },
            attachments: [
              {
                id: "primary",
                sessionID: session.id,
                messageID: assistant.id,
                type: "attachment",
                mime: "image/png",
                filename: "primary.png",
                url: "asset://primary.png",
                presentation: { mode: "inline", primary: true },
              },
              {
                id: "secondary",
                sessionID: session.id,
                messageID: assistant.id,
                type: "attachment",
                mime: "image/png",
                filename: "secondary.png",
                url: "asset://secondary.png",
                presentation: { mode: "card" },
              },
            ],
          },
        })

        const migration = migrations.find((entry) => entry.id === "20260701-attachment-presentation-v2")
        expect(migration).toBeDefined()
        await migration!.up(() => {})

        const toolPart = await Storage.read<any>(
          StoragePath.messagePart(scope, sid, assistantMessage, Identifier.asPartID("part_tool")),
        )

        expect(toolPart.state.metadata).toEqual({ display: { toolCard: "hidden" } })
        expect(toolPart.state.attachments[0].presentation).toBeUndefined()
        expect(toolPart.state.attachments[1].presentation).toEqual({ hidden: true })
      },
    })
  })

  test("canonicalizes unbounded session output and diffs without retaining legacy fields", async () => {
    await using tmp = await tmpdir({ git: true })
    const tmpScope = await tmp.scope()
    await ScopeContext.provide({
      scope: tmpScope,
      fn: async () => {
        const session = await Session.create({})
        const user = await addUserMessage(session.id)
        const assistant = await addTerminalAssistantMessage(session.id, user.id)
        const scope = Identifier.asScopeID(tmpScope.id)
        const sid = Identifier.asSessionID(session.id)
        const userMessage = Identifier.asMessageID(user.id)
        const assistantMessage = Identifier.asMessageID(assistant.id)
        const longOutput = "x".repeat(SessionBounds.TOOL_OUTPUT_MAX_CHARS + 4_000)

        await Storage.write(StoragePath.sessionSummary(scope, sid), [
          {
            file: "summary.txt",
            before: "old summary\n",
            after: "new summary\n",
            additions: 1,
            deletions: 1,
          },
        ])

        await Storage.update<any>(StoragePath.messageInfo(scope, sid, userMessage), (draft) => {
          draft.summary = {
            text: "legacy summary",
            diffs: [
              {
                file: "message.txt",
                before: "old message\n",
                after: "new message\n",
                additions: 1,
                deletions: 1,
              },
            ],
          }
        })

        await Storage.write(StoragePath.messagePart(scope, sid, assistantMessage, Identifier.asPartID("part_tool")), {
          id: "part_tool",
          sessionID: session.id,
          messageID: assistant.id,
          type: "tool",
          callID: "call_1",
          tool: "read",
          state: {
            status: "completed",
            input: {},
            output: longOutput,
            title: "Read",
            metadata: {
              filediff: {
                file: "tool.txt",
                before: "old tool\n",
                after: "new tool\n",
                additions: 1,
                deletions: 1,
              },
            },
            time: { start: 1, end: 2 },
          },
        })

        const migration = migrations.find((entry) => entry.id === "20260701-bounded-session-data")
        expect(migration).toBeDefined()
        await migration!.up(() => {})

        const firstPart = await Storage.read<any>(
          StoragePath.messagePart(scope, sid, assistantMessage, Identifier.asPartID("part_tool")),
        )
        const firstSummary = await Storage.read<any>(StoragePath.sessionSummary(scope, sid))
        const firstMessage = await Storage.read<any>(StoragePath.messageInfo(scope, sid, userMessage))

        expect(firstPart.state.output.length).toBeLessThanOrEqual(SessionBounds.TOOL_OUTPUT_MAX_CHARS)
        expect(firstPart.state.outputBytes).toBe(Buffer.byteLength(longOutput, "utf8"))
        expect(firstPart.state.outputTruncated).toBe(true)
        expect(firstPart.state.metadata.filediff.before).toBeUndefined()
        expect(firstPart.state.metadata.filediff.after).toBeUndefined()
        expect(firstPart.state.metadata.filediff.beforeBytes).toBe("old tool\n".length)
        expect(firstPart.state.metadata.filediff.afterBytes).toBe("new tool\n".length)
        expect(firstPart.state.metadata.filediff.preview).toContain("new tool")

        expect(firstSummary[0].before).toBeUndefined()
        expect(firstSummary[0].after).toBeUndefined()
        expect(firstSummary[0].preview).toContain("new summary")
        expect(firstMessage.summary.diffs[0].before).toBeUndefined()
        expect(firstMessage.summary.diffs[0].after).toBeUndefined()
        expect(firstMessage.summary.diffs[0].preview).toContain("new message")
        expect(SnapshotSchema.FileDiff.safeParse({ file: "x", additions: 1, deletions: 0, before: "a" }).success).toBe(
          false,
        )

        const serialized = JSON.stringify({ part: firstPart, summary: firstSummary, message: firstMessage })
        expect(serialized).not.toContain('"before":')
        expect(serialized).not.toContain('"after":')

        await migration!.up(() => {})
        const secondPart = await Storage.read<any>(
          StoragePath.messagePart(scope, sid, assistantMessage, Identifier.asPartID("part_tool")),
        )
        const secondSummary = await Storage.read<any>(StoragePath.sessionSummary(scope, sid))
        const secondMessage = await Storage.read<any>(StoragePath.messageInfo(scope, sid, userMessage))
        expect(JSON.stringify({ part: secondPart, summary: secondSummary, message: secondMessage })).toBe(serialized)
      },
    })
  })

  test("bounds aggregate diff previews in persisted session and message summaries", async () => {
    await using tmp = await tmpdir({ git: true })
    const tmpScope = await tmp.scope()

    await ScopeContext.provide({
      scope: tmpScope,
      fn: async () => {
        const session = await Session.create({})
        const user = await addUserMessage(session.id)
        const scope = Identifier.asScopeID(tmpScope.id)
        const sid = Identifier.asSessionID(session.id)
        const userMessage = Identifier.asMessageID(user.id)
        const diffs = Array.from({ length: 50 }, (_, index) => ({
          file: `file-${index}.txt`,
          additions: index + 1,
          deletions: index,
          preview: "界".repeat(SessionBounds.DIFF_PREVIEW_MAX_CHARS),
          beforeBytes: index,
          afterBytes: index + 1,
        }))

        await Storage.write(StoragePath.sessionSummary(scope, sid), diffs)
        await Storage.update<any>(StoragePath.messageInfo(scope, sid, userMessage), (draft) => {
          draft.summary = { text: "legacy summary", diffs }
        })

        const migration = migrations.find((entry) => entry.id === "20260716-bounded-diff-aggregate-preview")
        expect(migration).toBeDefined()
        await migration!.up(() => {})

        const firstSummary = await Storage.read<any[]>(StoragePath.sessionSummary(scope, sid))
        const firstMessage = await Storage.read<any>(StoragePath.messageInfo(scope, sid, userMessage))
        for (const migrated of [firstSummary, firstMessage.summary.diffs]) {
          expect(migrated).toHaveLength(diffs.length)
          expect(
            migrated.reduce(
              (total: number, diff: SnapshotSchema.FileDiff) =>
                total + (diff.preview ? SessionBounds.byteLength(diff.preview) : 0),
              0,
            ),
          ).toBeLessThanOrEqual(SessionBounds.DIFF_AGGREGATE_PREVIEW_MAX_BYTES)
          expect(migrated.some((diff: SnapshotSchema.FileDiff) => !diff.preview && diff.truncated)).toBe(true)
          expect(migrated.at(-1)).toMatchObject({
            file: "file-49.txt",
            additions: 50,
            deletions: 49,
            beforeBytes: 49,
            afterBytes: 50,
            truncated: true,
          })
        }

        const serialized = JSON.stringify({ summary: firstSummary, message: firstMessage })
        await migration!.up(() => {})
        expect(
          JSON.stringify({
            summary: await Storage.read<any[]>(StoragePath.sessionSummary(scope, sid)),
            message: await Storage.read<any>(StoragePath.messageInfo(scope, sid, userMessage)),
          }),
        ).toBe(serialized)
      },
    })
  })

  test("migrates legacy cortex output contract fields", async () => {
    await using tmp = await tmpdir({ git: true })
    const tmpScope = await tmp.scope()

    await ScopeContext.provide({
      scope: tmpScope,
      fn: async () => {
        const summary = await Session.create({ title: "Legacy Cortex Summary" })
        const structured = await Session.create({ title: "Legacy Cortex Structured" })
        const invalid = await Session.create({ title: "Legacy Cortex Invalid" })
        const scope = Identifier.asScopeID(tmpScope.id)
        const summaryKey = StoragePath.sessionInfo(scope, Identifier.asSessionID(summary.id))
        const structuredKey = StoragePath.sessionInfo(scope, Identifier.asSessionID(structured.id))
        const invalidKey = StoragePath.sessionInfo(scope, Identifier.asSessionID(invalid.id))

        await Storage.write(summaryKey, {
          ...summary,
          cortex: {
            parentSessionID: "ses_parent",
            parentMessageID: "msg_parent",
            description: "legacy summary",
            agent: "developer",
            startedAt: 1,
            completedAt: 2,
            status: "completed",
            result: "legacy summary text",
            output: { mode: "summary" },
          },
        })
        await Storage.write(structuredKey, {
          ...structured,
          cortex: {
            parentSessionID: "ses_parent",
            parentMessageID: "msg_parent",
            description: "legacy structured",
            agent: "developer",
            startedAt: 1,
            completedAt: 2,
            status: "completed",
            output: { mode: "structured", schema: { type: "array", items: { type: "string" } } },
            outputResult: { mode: "structured", status: "valid", data: ["a", "b"] },
          },
        })
        await Storage.write(invalidKey, {
          ...invalid,
          cortex: {
            parentSessionID: "ses_parent",
            parentMessageID: "msg_parent",
            description: "legacy invalid",
            agent: "developer",
            startedAt: 1,
            completedAt: 2,
            status: "completed",
            outputResult: {
              mode: "structured",
              status: "invalid",
              error: "expected string",
            },
          },
        })

        const migration = migrations.find((entry) => entry.id === "20260707-cortex-task-output-contract")
        expect(migration).toBeDefined()
        await migration!.up(() => {})

        const migratedSummary = await Storage.read<any>(summaryKey)
        const migratedStructured = await Storage.read<any>(structuredKey)
        const migratedInvalid = await Storage.read<any>(invalidKey)

        expect(migratedSummary.cortex.outputConfig).toEqual({ mode: "summary" })
        expect(migratedSummary.cortex.output).toEqual({ mode: "summary", value: "legacy summary text" })
        expect(migratedStructured.cortex.outputConfig).toEqual({
          mode: "structured",
          schema: { type: "array", items: { type: "string" } },
        })
        expect(migratedStructured.cortex.output).toEqual({ mode: "structured", value: ["a", "b"] })
        expect(migratedInvalid.cortex.status).toBe("error")
        expect(migratedInvalid.cortex.error).toBe("expected string")
        expect(migratedInvalid.cortex.output).toBeUndefined()

        const serialized = JSON.stringify({ migratedSummary, migratedStructured, migratedInvalid })
        expect(serialized).not.toContain("outputResult")
        expect(serialized).not.toContain('"result"')

        await migration!.up(() => {})
        expect(JSON.stringify(await Storage.read<any>(summaryKey))).toBe(JSON.stringify(migratedSummary))
        expect(JSON.stringify(await Storage.read<any>(structuredKey))).toBe(JSON.stringify(migratedStructured))
        expect(JSON.stringify(await Storage.read<any>(invalidKey))).toBe(JSON.stringify(migratedInvalid))
      },
    })
  })

  test("backfills a durable Cortex task identity with a valid idempotent ID", async () => {
    await using tmp = await tmpdir({ git: true })
    const tmpScope = await tmp.scope()

    await ScopeContext.provide({
      scope: tmpScope,
      fn: async () => {
        const parent = await Session.create({ title: "Parent" })
        const child = await Session.create({
          title: "Delegated child",
          parentID: parent.id,
          cortex: {
            taskID: "ctx_original",
            parentSessionID: parent.id,
            parentMessageID: Identifier.ascending("message"),
            description: "Legacy delegated task",
            agent: "developer",
            startedAt: 1,
            status: "completed",
          },
        })
        const scope = Identifier.asScopeID(tmpScope.id)
        const key = StoragePath.sessionInfo(scope, Identifier.asSessionID(child.id))
        const legacy = await Storage.read<any>(key)
        delete legacy.cortex.taskID
        await Storage.write(key, legacy)

        const migration = migrations.find((entry) => entry.id === "20260711-cortex-task-identity")
        expect(migration).toBeDefined()
        await migration!.up(() => {})

        const first = await Storage.read<any>(key)
        expect(first.cortex.taskID).toBe(`ctx_migrated_${child.id}`)
        expect((await Session.get(child.id))?.cortex?.taskID).toBe(first.cortex.taskID)

        await migration!.up(() => {})
        expect(await Storage.read<any>(key)).toEqual(first)
      },
    })
  })

  test("migrates legacy workflow session fields and message metadata", async () => {
    await using tmp = await tmpdir({ git: true })
    const tmpScope = await tmp.scope()

    await ScopeContext.provide({
      scope: tmpScope,
      fn: async () => {
        const latticeSession = await Session.create({ title: "Legacy Lattice" })
        const lightloopSession = await Session.create({ title: "Legacy Light Loop" })
        const planSession = await Session.create({ title: "Legacy Plan" })
        const conflictSession = await Session.create({ title: "Legacy Conflict" })
        const scope = Identifier.asScopeID(tmpScope.id)

        await Storage.write(StoragePath.sessionInfo(scope, Identifier.asSessionID(latticeSession.id)), {
          ...latticeSession,
          planMode: true,
          lightLoop: { active: true, taskDescription: "ignored" },
          lattice: { runID: "ltr_legacy", mode: "auto", firstBlueprintStarted: true },
        })
        await Storage.write(StoragePath.sessionInfo(scope, Identifier.asSessionID(lightloopSession.id)), {
          ...lightloopSession,
          lightLoop: { active: true, taskDescription: "Keep going" },
        })
        await Storage.write(StoragePath.sessionInfo(scope, Identifier.asSessionID(planSession.id)), {
          ...planSession,
          planMode: true,
        })

        const loopID = Identifier.ascending("blueprint_loop")
        await Storage.write(StoragePath.blueprintLoop(scope, loopID), {
          id: loopID,
          noteID: "note_conflict",
          title: "Conflict Loop",
          sessionID: conflictSession.id,
          scopeID: scope,
          status: "running",
          source: "user",
          time: { created: Date.now(), updated: Date.now() },
        })
        await Storage.write(StoragePath.sessionInfo(scope, Identifier.asSessionID(conflictSession.id)), {
          ...conflictSession,
          blueprint: { loopID },
          planMode: true,
          lightLoop: { active: true, taskDescription: "conflict" },
        })

        const planMessageID = Identifier.ascending("message")
        await Storage.write(StoragePath.messageInfo(scope, Identifier.asSessionID(planSession.id), planMessageID), {
          id: planMessageID,
          sessionID: planSession.id,
          role: "user",
          metadata: {
            planModeRequest: true,
            planModeAgent: "synergy",
            planModeWrapperVersion: 1,
            keep: "value",
          },
        })

        const lightloopMessageID = Identifier.ascending("message")
        await Storage.write(
          StoragePath.messageInfo(scope, Identifier.asSessionID(lightloopSession.id), lightloopMessageID),
          {
            id: lightloopMessageID,
            sessionID: lightloopSession.id,
            role: "user",
            metadata: {
              workflowMode: "light_loop",
              workflowModeAgent: "synergy-max",
              workflowModeVersion: 1,
            },
          },
        )

        const migration = migrations.find((entry) => entry.id === "20260708-session-workflow-field")
        expect(migration).toBeDefined()
        await migration!.up(() => {})

        const migratedLattice = await Storage.read<any>(
          StoragePath.sessionInfo(scope, Identifier.asSessionID(latticeSession.id)),
        )
        const migratedLightloop = await Storage.read<any>(
          StoragePath.sessionInfo(scope, Identifier.asSessionID(lightloopSession.id)),
        )
        const migratedPlan = await Storage.read<any>(
          StoragePath.sessionInfo(scope, Identifier.asSessionID(planSession.id)),
        )
        const migratedConflict = await Storage.read<any>(
          StoragePath.sessionInfo(scope, Identifier.asSessionID(conflictSession.id)),
        )

        expect(migratedLattice.workflow).toEqual({
          kind: "lattice",
          runID: "ltr_legacy",
          mode: "auto",
          firstBlueprintStarted: true,
        })
        expect(migratedLightloop.workflow).toEqual({ kind: "lightloop", taskDescription: "Keep going" })
        expect(migratedPlan.workflow).toEqual({ kind: "plan" })
        expect(migratedConflict.workflow).toBeUndefined()

        for (const migrated of [migratedLattice, migratedLightloop, migratedPlan, migratedConflict]) {
          expect("planMode" in migrated).toBe(false)
          expect("lightLoop" in migrated).toBe(false)
          expect("lattice" in migrated).toBe(false)
        }

        const migratedPlanMessage = await Storage.read<any>(
          StoragePath.messageInfo(scope, Identifier.asSessionID(planSession.id), planMessageID),
        )
        expect(migratedPlanMessage.metadata).toEqual({
          workflow: "plan",
          workflowAgent: "synergy",
          workflowVersion: 1,
          keep: "value",
        })

        const migratedLightloopMessage = await Storage.read<any>(
          StoragePath.messageInfo(scope, Identifier.asSessionID(lightloopSession.id), lightloopMessageID),
        )
        expect(migratedLightloopMessage.metadata).toEqual({
          workflow: "lightloop",
          workflowAgent: "synergy-max",
          workflowVersion: 1,
        })
      },
    })
  })
  test("migrates retired intent-analyst DAG assignments to self", async () => {
    await using tmp = await tmpdir({ git: true })
    const tmpScope = await tmp.scope()

    await ScopeContext.provide({
      scope: tmpScope,
      fn: async () => {
        const session = await Session.create({ title: "Legacy Intent DAG" })
        const scope = Identifier.asScopeID(tmpScope.id)
        const key = StoragePath.sessionDag(scope, Identifier.asSessionID(session.id))
        await Storage.write(key, [
          {
            id: "classify",
            content: "Classify the request",
            status: "completed",
            deps: [],
            assign: "intent-analyst",
          },
          {
            id: "research",
            content: "Research the request",
            status: "pending",
            deps: ["classify"],
            assign: "scout",
          },
        ])

        const migration = migrations.find((entry) => entry.id === "20260715-retired-intent-analyst-dag-assign")
        expect(migration).toBeDefined()
        await migration!.up(() => {})

        const migrated = await Storage.read<any[]>(key)
        expect(migrated[0].assign).toBe("self")
        expect(migrated[1].assign).toBe("scout")

        await migration!.up(() => {})
        expect(await Storage.read<any[]>(key)).toEqual(migrated)
      },
    })
  })
})
