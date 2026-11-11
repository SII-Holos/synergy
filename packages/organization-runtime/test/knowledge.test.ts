import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { InstructionRegistry } from "@ericsanchezok/synergy-harness/instruction/registry"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { SkillTool } from "@ericsanchezok/synergy-local-runtime/tools/skill"
import { SkillSelection } from "@ericsanchezok/synergy-local-runtime/skill/selection"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import {
  type OrganizationKnowledgeProtocol as Knowledge,
  OrganizationPublicationProtocol as Publication,
} from "@ericsanchezok/synergy-organization-protocol"
import {
  stageKnowledgeSelection,
  syncKnowledgeSelection,
  activeKnowledge,
  type KnowledgeTransport,
} from "../src/knowledge"
import { registerOrganizationKnowledge } from "../src/knowledge-source"

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")

function source(
  sessionID: string,
  version: number,
  text: string,
  input?: { corrupt?: boolean; fail?: boolean },
): KnowledgeTransport {
  const bytes = new TextEncoder().encode(`---\nname: team-work\ndescription: Team work\n---\n${text}\n`)
  const file: Publication.File = {
    fileID: hash("SKILL.md"),
    path: "SKILL.md",
    bytes: bytes.length,
    sha256: hash(bytes),
    mediaType: "text/markdown",
  }
  const manifestHash = hash(Publication.manifestLine(file))
  const reference = { itemID: "team", version, manifestHash }
  const release: Knowledge.Release = {
    ...reference,
    orgID: "org",
    scope: { kind: "project", projectID: "project" },
    kind: "skill",
    title: "Team work",
    authorID: "alice",
    publishedAt: 1,
    fileCount: 1,
    totalBytes: bytes.length,
    skill: { name: "team-work", description: "Team work" },
  }
  return {
    async selection() {
      return {
        orgID: "org",
        projectID: "project",
        sessionID,
        selection: {
          revision: version,
          manifestHash: hash(JSON.stringify([reference])),
          updatedBy: "alice",
          updatedAt: 1,
          releaseCount: 1,
        },
        items: [release],
      }
    },
    async files() {
      return { items: [file] }
    },
    async content(_reference, fileID, offset, length) {
      if (input?.fail) throw new Error("Controlled download failure")
      const result = bytes.slice(offset, offset + length)
      if (input?.corrupt && result.length) result[0] = result[0]! ^ 1
      return {
        fileID,
        offset,
        sha256: file.sha256,
        totalBytes: bytes.length,
        data: Buffer.from(result).toString("base64url"),
      }
    },
  }
}

test("two Sessions in one Scope retain independent Skill versions while one updates online", async () => {
  const versions = new Map([
    ["one", 1],
    ["two", 2],
  ])
  await using runtime = await testRuntime({
    register() {
      SkillSelection.select({ builtins: [], filesystem: false })
      registerOrganizationKnowledge(
        { orgID: "org", hostID: "host" },
        {
          load: async (sessionID) =>
            stageKnowledgeSelection({
              root: runtime.host.root,
              orgID: "org",
              projectID: "project",
              sessionID,
              transport: source(
                sessionID,
                versions.get(sessionID)!,
                ["", "First version", "Second version", "Third version"][versions.get(sessionID)!]!,
              ),
            }),
        },
      )
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const first = await stageKnowledgeSelection({
          root: runtime.host.root,
          orgID: "org",
          projectID: "project",
          sessionID: "one",
          transport: source("one", 1, "First version"),
        })
        const second = await stageKnowledgeSelection({
          root: runtime.host.root,
          orgID: "org",
          projectID: "project",
          sessionID: "two",
          transport: source("two", 2, "Second version"),
        })
        const tool = await SkillTool.init()
        const captured: unknown[] = []
        const context = (sessionID: string): Tool.Context => ({
          sessionID,
          messageID: `message-${sessionID}`,
          agent: "atlas",
          abort: new AbortController().signal,
          metadata() {},
          async ask() {},
          async captureResult(value) {
            captured.push(value)
          },
        })
        expect((await tool.execute({ name: "team-work" }, context("one"))).output).toContain("First version")
        expect((await tool.execute({ name: "team-work" }, context("two"))).output).toContain("Second version")
        versions.set("one", 3)
        expect((await tool.execute({ name: "team-work" }, context("one"))).output).toContain("Third version")
        expect((await tool.execute({ name: "team-work" }, context("two"))).output).toContain("Second version")
        expect(first.selection.manifestHash).not.toBe(second.selection.manifestHash)
        expect(captured).toContainEqual(
          expect.objectContaining({ provenance: expect.objectContaining({ itemID: "team", version: 3 }) }),
        )
      },
    }),
  )
})

test("partial download, bad hash and edited cache preserve the previous applied manifest", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const current = await stageKnowledgeSelection({
      root: runtime.host.root,
      orgID: "org",
      projectID: "project",
      sessionID: "one",
      transport: source("one", 1, "First version"),
    })
    for (const fault of [{ fail: true }, { corrupt: true }]) {
      await expect(
        stageKnowledgeSelection({
          root: runtime.host.root,
          orgID: "org",
          projectID: "project",
          sessionID: "one",
          transport: source("one", 2, "Broken version", fault),
        }),
      ).rejects.toThrow()
      expect((await activeKnowledge("one"))?.selection).toEqual(current.selection)
    }
    const file = path.join(current.releases[0]!.directory, "SKILL.md")
    await fs.writeFile(file, "local user edit")
    await expect(
      stageKnowledgeSelection({
        root: runtime.host.root,
        orgID: "org",
        projectID: "project",
        sessionID: "one",
        transport: source("one", 1, "First version"),
      }),
    ).rejects.toThrow()
    expect(await fs.readFile(file, "utf8")).toBe("local user edit")
    expect((await activeKnowledge("one"))?.selection).toEqual(current.selection)
  })
})

test("another project or Session cannot be admitted by a mismatched manifest", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await expect(
      stageKnowledgeSelection({
        root: runtime.host.root,
        orgID: "org",
        projectID: "other-project",
        sessionID: "one",
        transport: source("one", 1, "Private"),
      }),
    ).rejects.toThrow()
    await expect(
      stageKnowledgeSelection({
        root: runtime.host.root,
        orgID: "org",
        projectID: "project",
        sessionID: "different-session",
        transport: source("one", 1, "Private"),
      }),
    ).rejects.toThrow()
    expect(await activeKnowledge("different-session")).toBeUndefined()
  })
})

test("a failed update keeps a previously activated version usable only after current reauthorization", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    let authorized = true
    const activated = new Set<string>()
    function transport(version: number, fail = false): KnowledgeTransport {
      return {
        ...source("one", version, version === 1 ? "Previous usable version" : "Next version", { fail }),
        async activate(selection) {
          activated.add(selection.manifestHash)
          return { orgID: "org", projectID: "project", sessionID: "one", ...selection }
        },
        retained(manifestHash) {
          if (!authorized || !activated.has(manifestHash)) throw new Error("Current access revoked")
          return source("one", 1, "Previous usable version")
        },
      }
    }
    const input = { root: runtime.host.root, orgID: "org", projectID: "project", sessionID: "one" }
    const first = await syncKnowledgeSelection({ ...input, transport: transport(1) })
    const retained = await syncKnowledgeSelection({ ...input, transport: transport(2, true) })
    expect(retained.selection).toEqual(first.selection)
    expect(retained.updateError).toContain("previous complete version remains active")
    authorized = false
    await expect(syncKnowledgeSelection({ ...input, transport: transport(2, true) })).rejects.toThrow(
      "Current access revoked",
    )
    expect((await activeKnowledge("one"))?.selection).toEqual(first.selection)
  })
})

test("member Skill discovery is live and restricted to its Home and selected project roots", async () => {
  await using runtime = await testRuntime({
    register() {
      SkillSelection.select({ builtins: [], filesystem: false })
      registerOrganizationKnowledge({ orgID: "org", accountID: "alice", deviceID: "device" })
    },
  })
  await runtime.run(async () => {
    const project = path.join(runtime.host.root, "projects", "selected")
    const sibling = path.join(runtime.host.root, "projects", "sibling")
    async function write(base: string, name: string, text: string) {
      const file = path.join(base, name, "SKILL.md")
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, `---\nname: ${name}\ndescription: ${text}\n---\n${text}`)
    }
    await write(path.join(runtime.host.root, "config", "skill"), "member-only", "Member")
    await write(path.join(runtime.host.root, "projects", ".synergy", "skill"), "ancestor-private", "Private")
    await write(path.join(sibling, ".synergy", "skill"), "sibling-private", "Private")
    await write(path.join(project, ".synergy", "skill"), "project-only", "First")
    const scope = (await Scope.fromDirectory(project)).scope
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const source = InstructionRegistry.get("skill")!
        expect((await source.entries!()).map((entry) => entry.name).sort()).toEqual(["member-only", "project-only"])
        await write(path.join(project, ".synergy", "skill"), "project-only", "Updated online")
        expect((await source.entry!("project-only"))?.description).toBe("Updated online")
        await fs.symlink(
          path.join(sibling, ".synergy", "skill", "sibling-private"),
          path.join(project, ".synergy", "skill", "leaked"),
        )
        expect((await source.entries!()).map((entry) => entry.name).sort()).toEqual(["member-only", "project-only"])
      },
    })
  })
})
