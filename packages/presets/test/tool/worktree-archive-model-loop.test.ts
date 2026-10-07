import { expect, test } from "bun:test"
import { $ } from "bun"
import fs from "node:fs/promises"
import path from "node:path"
import { openAgentRuntime } from "@ericsanchezok/synergy-agent-runtime"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { AgentTurn } from "@ericsanchezok/synergy-harness/session/agent-turn"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import type { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { SessionProgress } from "@ericsanchezok/synergy-harness/session/progress"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { runInProcessStream } from "@ericsanchezok/synergy-harness/test/support/internals"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import { Worktree } from "@ericsanchezok/synergy-local-runtime/workspace/worktree"
import { plugins } from "@ericsanchezok/synergy-plugin-host/component"
import { fullComponents } from "../../src/components"

type ProviderMessage = {
  role: string
  tool_call_id?: string
  content?: string | Array<{ type: string; text?: string }>
}

type ProviderRequest = {
  stream?: boolean
  messages: ProviderMessage[]
  tools?: Array<{ function: { name: string; parameters: { type?: string; required?: string[] } } }>
}

function text(message: ProviderMessage) {
  return typeof message.content === "string"
    ? message.content
    : (message.content?.map((part) => part.text ?? "").join("\n") ?? "")
}

function completion(message: Record<string, unknown>, stream: boolean, finishReason: string) {
  const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
  const envelope = { id: "archive-fixture", created: 0, model: "model" }
  if (!stream)
    return Response.json({
      ...envelope,
      object: "chat.completion",
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage,
    })
  return new Response(
    [
      { choices: [{ index: 0, delta: message, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage },
    ]
      .map((frame) => `data: ${JSON.stringify({ ...envelope, object: "chat.completion.chunk", ...frame })}\n\n`)
      .join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )
}

function toolCall(id: string, name: string, input: Record<string, unknown>) {
  return {
    role: "assistant",
    tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(input) } }],
  }
}

test("a model archives its running worktree and continues a real file write in the restored checkout", async () => {
  await using home = await runtimeHome()
  await using repository = await tmpdir({ git: true })
  const content = "The same turn continued in the main checkout.\n恢复后的文件字节。\n"
  const reason = "isolated work finished"
  const archiveCallID = "archive_current_worktree"
  const writeCallID = "write_after_archive"
  const failures: string[] = []
  const requests: ProviderRequest[] = []
  const observations: Array<{
    running: boolean
    session: Session.Info
    archive?: MessageV2.ToolPart
  }> = []
  let embeddings = 0
  let observe: (() => Promise<(typeof observations)[number]>) | undefined
  using provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      try {
        const pathname = new URL(request.url).pathname
        if (pathname === "/embeddings") {
          const input = (await request.json()) as { input: string[] }
          embeddings += input.input.length
          return Response.json({
            object: "list",
            model: "embedding",
            data: input.input.map((_, index) => ({
              object: "embedding",
              index,
              embedding: [1, ...Array(383).fill(0)],
            })),
            usage: { prompt_tokens: 1, total_tokens: 1 },
          })
        }
        if (pathname !== "/chat/completions") throw new Error(`Unexpected fixture route: ${pathname}`)
        const body = (await request.json()) as ProviderRequest
        const primary = body.tools?.some((tool) => tool.function.name === "worktree_archive")
        if (!primary)
          return completion({ role: "assistant", content: "Fixture auxiliary response" }, !!body.stream, "stop")
        if (!observe) throw new Error("A model request arrived before the fixture Session was created")
        const snapshot = await observe()
        observations.push(snapshot)
        requests.push(body)
        const archiveResult = body.messages.find(
          (message) => message.role === "tool" && message.tool_call_id === archiveCallID,
        )
        const writeResult = body.messages.find(
          (message) => message.role === "tool" && message.tool_call_id === writeCallID,
        )
        if (writeResult) {
          if (requests.length !== 3) throw new Error("The model did not complete archive, write, then reply in order")
          return completion(
            { role: "assistant", content: "Archive and continued write completed." },
            !!body.stream,
            "stop",
          )
        }
        if (archiveResult) {
          if (requests.length !== 2) throw new Error("The model replayed the archive result")
          const restored = text(archiveResult).match(/^Restored: (.+)$/m)?.[1]
          if (!restored) throw new Error("The model did not receive the restored checkout in the archive result")
          return completion(
            toolCall(writeCallID, "save_file", { filePath: path.join(restored, "continued.txt"), content }),
            !!body.stream,
            "tool_calls",
          )
        }
        if (requests.length !== 1) throw new Error("The archive tool result never reached the model")
        return completion(toolCall(archiveCallID, "worktree_archive", { reason }), !!body.stream, "tool_calls")
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push(message)
        return Response.json({ error: { message, type: "fixture_protocol_error" } }, { status: 400 })
      }
    },
  })
  const native = localRuntime({ workers: false })
  const host = {
    ...home.host,
    env: {
      ...home.host.env,
      SYNERGY_CONFIG_CONTENT: JSON.stringify({
        model: "fixture/model",
        nano_model: "fixture/model",
        mini_model: "fixture/model",
        controlProfile: "full_access",
        library: { autonomy: false },
        embedding: { apiKey: "fixture", baseURL: provider.url.toString(), model: "embedding" },
        provider: {
          fixture: {
            name: "Archive fixture",
            npm: "@ai-sdk/openai-compatible",
            env: [],
            models: { model: { name: "Fixture", tool_call: true, limit: { context: 128000, output: 4096 } } },
            options: { apiKey: "fixture", baseURL: provider.url.toString() },
          },
        },
      }),
    },
  }
  await using runtime = await openAgentRuntime({
    host,
    home: host.root,
    mode: "oneshot",
    listen: false,
    components: [
      {
        ...native,
        register() {
          registerLocalRuntime({
            workers: false,
            workspaceCoordinator: new WorkspaceCoordinator({ directory: path.join(host.root, "claims") }),
          })
          native.register()
        },
      },
      plugins(),
      ...fullComponents(),
    ],
  })
  runtime.run(() => AgentTurn.setInProcessStream(runInProcessStream))
  await runtime.run(async () => {
    await $`git update-ref refs/remotes/origin/main HEAD`.cwd(repository.path).quiet()
    const scope = await repository.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "Running worktree archive regression" })
        const tree = await Worktree.create({
          name: "model-archive-owner",
          baseRef: "current",
          sessionID: session.id,
          bind: true,
        })
        if (!tree.branch) throw new Error("Fixture worktree must have a branch to retain")
        observe = () =>
          runtime.run(() =>
            ScopeContext.provide({
              scope,
              fn: async () => ({
                running: SessionManager.isRunning(session.id),
                session: await Session.get(session.id),
                archive: (await Session.messages({ sessionID: session.id }))
                  .flatMap((message) => message.parts)
                  .find((part): part is MessageV2.ToolPart => part.type === "tool" && part.callID === archiveCallID),
              }),
            }),
          )
        const result = await SessionInvoke.invoke({
          sessionID: session.id,
          agent: PrimaryAgentIdentity.names.coding,
          model: { providerID: "fixture", modelID: "model" },
          tools: { "*": false, worktree_archive: true, save_file: true },
          parts: [
            {
              type: "text",
              text: "Archive this finished worktree, then save continued.txt in the restored checkout and finish.",
            },
          ],
        })
        expect(failures).toEqual([])
        expect(requests).toHaveLength(3)
        expect(requests.every((request) => request.stream)).toBe(true)
        const schema = requests[0].tools?.find((tool) => tool.function.name === "worktree_archive")?.function.parameters
        expect(schema?.type).toBe("object")
        expect(schema?.required ?? []).not.toContain("target")
        expect(observations[0]).toMatchObject({ running: true, session: { workspace: { path: tree.path } } })
        expect(observations.slice(1)).toHaveLength(2)
        for (const observation of observations.slice(1)) {
          expect(observation.running).toBe(true)
          expect(observation.session.workspace).toEqual(session.workspace)
          expect(observation.session.time.archived).toBeUndefined()
          expect(observation.archive?.state.status).toBe("completed")
        }
        const messages = await Session.messages({ sessionID: session.id })
        const tools = messages
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.ToolPart => part.type === "tool")
        expect(tools.map((part) => part.tool)).toEqual(["worktree_archive", "save_file"])
        const [archive, write] = tools
        expect(archive.callID).toBe(archiveCallID)
        expect(archive.state.status).toBe("completed")
        if (archive.state.status !== "completed") throw new Error("Archive ToolPart was not completed")
        expect(archive.state.input).toEqual({ reason })
        expect(archive.state.metadata).toMatchObject({
          action: "archived",
          worktree: { id: tree.id, path: tree.path, branch: tree.branch },
          restored: { type: "main", path: repository.path },
          cleanup: { performed: true },
          message: archive.state.output,
        })
        expect(archive.state.output).toContain("Checkout removed")
        expect(archive.state.output).toContain(tree.branch)
        const deliveredArchive = requests[1].messages.find((message) => message.tool_call_id === archiveCallID)
        expect(deliveredArchive && text(deliveredArchive)).toContain(archive.state.output)
        expect(write.callID).toBe(writeCallID)
        expect(write.state).toMatchObject({
          status: "completed",
          metadata: { filepath: path.join(repository.path, "continued.txt") },
        })
        const writeMessage = messages.find((message) => message.info.id === write.messageID)
        expect(writeMessage?.info.role === "assistant" && writeMessage.info.path.cwd).toBe(repository.path)
        expect(new Uint8Array(await Bun.file(path.join(repository.path, "continued.txt")).arrayBuffer())).toEqual(
          new TextEncoder().encode(content),
        )
        expect(await fs.stat(tree.path).catch((error: NodeJS.ErrnoException) => error.code)).toBe("ENOENT")
        expect(
          (await $`git rev-parse --verify refs/heads/${tree.branch}`.cwd(repository.path).quiet().nothrow()).exitCode,
        ).toBe(0)
        const persisted = await Session.get(session.id)
        expect(persisted.workspaceID).toBe(session.workspaceID)
        expect(persisted.workspace).toEqual(session.workspace)
        expect(persisted.time.archived).toBeUndefined()
        expect(result.info.role).toBe("assistant")
        if (result.info.role !== "assistant") throw new Error("The turn returned no assistant reply")
        expect(result.info.error).toBeUndefined()
        expect(result.info.time.completed).toBeDefined()
        expect(SessionProgress.isTerminalAssistant(result.info)).toBe(true)
        expect(SessionProgress.pendingReply(messages)).toBe(false)
        expect(SessionManager.isRunning(session.id)).toBe(false)
        expect(result.parts).toContainEqual(
          expect.objectContaining({ type: "text", text: "Archive and continued write completed." }),
        )
        expect(embeddings).toBeGreaterThan(0)
      },
    })
  })
}, 60_000)
