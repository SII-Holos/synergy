import { describe, expect, test } from "bun:test"
import { tmpdir } from "../support/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { RolloutArtifact } from "../../src/session/rollout/artifact"

describe("session fork artifact copy", () => {
  test("forks many tool outputs with byte-exact evidence and per-session ownership", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const source = await Session.create({})
        try {
          const root = await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: source.id,
            role: "user",
            agent: "test",
            model: { providerID: "test", modelID: "test" },
            time: { created: 0 },
          })
          const outputs: string[] = []
          for (let index = 0; index < 12; index++) {
            const output = `tool-${index}-${"x".repeat(200_000)}`
            outputs.push(output)
            const assistant = await Session.updateMessage({
              id: Identifier.ascending("message"),
              sessionID: source.id,
              role: "assistant",
              parentID: root.id,
              agent: "test",
              mode: "test",
              modelID: "test",
              providerID: "test",
              time: { created: index + 1, completed: index + 2 },
              path: { cwd: tmp.path, root: tmp.path },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              finish: "stop",
            })
            await Session.updatePart({
              id: Identifier.ascending("part"),
              sessionID: source.id,
              messageID: assistant.id,
              type: "tool",
              callID: `call-${index}`,
              tool: "bash",
              state: {
                status: "completed",
                input: {},
                output,
                title: `bash ${index}`,
                metadata: {},
                time: { start: 0, end: 1 },
              },
            })
          }
          const fork = await Session.fork({ sessionID: source.id })
          try {
            const messages = await Session.messages({ sessionID: fork.id })
            const tools = messages.flatMap((message) => message.parts)
            const seen = new Map<string, string>()
            for (const part of tools) {
              if (part.type !== "tool" || part.state.status !== "completed") continue
              const artifact = part.state.outputArtifact
              expect(artifact).toBeDefined()
              const chunks: Uint8Array[] = []
              for await (const chunk of RolloutArtifact.read(
                { kind: "session", scopeID: scope.id, sessionID: fork.id },
                artifact!.id,
              ))
                chunks.push(chunk)
              seen.set(part.callID, Buffer.concat(chunks).toString("utf8"))
            }
            outputs.forEach((output, index) => {
              if (seen.get(`call-${index}`) !== output)
                throw new Error(`artifact for call-${index} does not match its source output`)
            })
            const sourceArtifacts = await RolloutArtifact.list({
              kind: "session",
              scopeID: scope.id,
              sessionID: source.id,
            })
            const forkArtifacts = await RolloutArtifact.list({
              kind: "session",
              scopeID: scope.id,
              sessionID: fork.id,
            })
            expect(forkArtifacts.length).toBe(outputs.length)
            const sourceIds = new Set(sourceArtifacts.map((ref) => ref.id))
            for (const ref of forkArtifacts) expect(sourceIds.has(ref.id)).toBe(false)
          } finally {
            await Session.remove(fork.id)
          }
        } finally {
          await Session.remove(source.id)
        }
      },
    })
  })
})
