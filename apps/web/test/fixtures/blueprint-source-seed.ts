import path from "node:path"

export async function seedBlueprintSourceHistory(
  repository: string,
  home: string,
  runtime: { run<T>(fn: () => Promise<T>): Promise<T> },
) {
  const fixture = Bun.file(path.join(home, "blueprint-source-seed.json"))
  if (await fixture.exists()) return
  const [
    { Session },
    { Scope },
    { ScopeContext },
    { Identifier },
    { Asset },
    { NoteStore },
    { BlueprintLoopStore, BlueprintLoopService },
  ] = await Promise.all([
    import(path.join(repository, "packages/harness/src/session/index.ts")),
    import(path.join(repository, "packages/harness/src/scope/index.ts")),
    import(path.join(repository, "packages/harness/src/scope/context.ts")),
    import(path.join(repository, "packages/harness/src/id/id.ts")),
    import(path.join(repository, "packages/harness/src/asset/asset.ts")),
    import(path.join(repository, "packages/note/src/index.ts")),
    import(path.join(repository, "packages/blueprint/src/blueprint/index.ts")),
  ])
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const note = await NoteStore.create({
          title: "Preserved source Blueprint",
          kind: "blueprint",
          content: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Ordinary Blueprint document" }] }],
          },
        })
        await NoteStore.create({ title: "Ordinary Note remains", kind: "note" })
        const session = await Session.create({ title: "Preserved source conversation" })
        const loop = await BlueprintLoopStore.create({
          noteID: note.id,
          title: note.title,
          sessionID: session.id,
          source: "lattice",
          runMode: "current",
        })
        await BlueprintLoopService.bindSessionToLoop(session.id, loop.id, "execution")
        const rootID = Identifier.ascending("message")
        const messageID = Identifier.ascending("message")
        const toolPartID = Identifier.ascending("part")
        const now = Date.now()
        await Session.updateMessage({
          id: rootID,
          sessionID: session.id,
          role: "user",
          time: { created: now },
          agent: "general",
          model: { providerID: "fixture", modelID: "fixture" },
          rootID,
          isRoot: true,
          metadata: {
            source: "blueprint_loop_start",
            loopID: loop.id,
            noteID: note.id,
            title: note.title,
            userPrompt: "Keep the original source request",
            requiredFeatures: ["blueprint", "lattice"],
          },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: rootID,
          sessionID: session.id,
          type: "text",
          text: "Internal source control instructions",
        })
        const asset = await Asset.write(
          Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><text x="10" y="40">Original attachment</text></svg>',
          ),
          "image/svg+xml",
          "source-sent.svg",
        )
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: rootID,
          sessionID: session.id,
          type: "attachment",
          mime: "image/svg+xml",
          filename: "source-sent.svg",
          url: `asset://${asset}`,
        })
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "assistant",
          parentID: rootID,
          rootID,
          modelID: "fixture",
          providerID: "fixture",
          mode: "test",
          agent: "general",
          path: { cwd: null, root: null },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now + 1, completed: now + 2 },
          finish: "stop",
        })
        await Session.updatePart({
          id: toolPartID,
          messageID,
          sessionID: session.id,
          type: "tool",
          callID: "source-history-control",
          tool: "blueprint_loop_stop",
          state: {
            status: "completed",
            input: { summary: "Preserved source audit" },
            output: JSON.stringify({ loopID: loop.id, control: "Internal source tool metadata" }),
            title: "Preserved source audit",
            metadata: { requiredFeatures: ["blueprint", "lattice"] },
            time: { start: now, end: now + 1 },
          },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID,
          sessionID: session.id,
          type: "text",
          text: "Preserved ordinary source answer",
        })
        await Bun.write(
          fixture,
          JSON.stringify({ sessionID: session.id, noteID: note.id, loopID: loop.id, toolPartID }),
        )
      },
    }),
  )
}
