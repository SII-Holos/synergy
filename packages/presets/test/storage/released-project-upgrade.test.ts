import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { runMigrations } from "@ericsanchezok/synergy-harness/migration"
import { createSynergyClient, type ProjectDirectories } from "@ericsanchezok/synergy-sdk"
import { PresetRuntimeHandle } from "../../src/server/runtime-handle"

const Fixture = z.object({
  records: z.array(z.object({ key: z.array(z.string()), value: z.record(z.string(), z.unknown()) })),
})
const Ledger = z.object({ completed: z.array(z.string()) })

for (const version of ["2.0.0", "2.4.4", "3.0.21", "3.0.22"])
  for (const state of ["available", "missing", "file", "dangling-symlink", "symlink-loop"] as const)
    test(`v${version} complete Runtime upgrades ${state} project folders and restarts with readable history`, async () => {
      await using home = await runtimeHome()
      const directory = await fs.realpath(home.host.home)
      const main = path.join(directory, "Project with spaces 项目")
      const additional = path.join(directory, "additional")
      await fs.mkdir(main)
      await fs.mkdir(additional)
      const project = {
        id: "released-project",
        type: "project",
        directory: main,
        worktree: main,
        sandboxes: [additional],
        time: { created: 1700000000000, updated: 1700000000000 },
      }
      const fixture = Fixture.parse(
        JSON.parse(
          (
            await Bun.file(new URL(`../../../harness/test/storage/fixtures/v${version}.json`, import.meta.url)).text()
          ).replaceAll('"$HOME"', JSON.stringify(home.host.home)),
        ),
      )
      const ledger = Ledger.parse(
        await Bun.file(new URL(`./fixtures/v${version}-migration-ledger.json`, import.meta.url)).json(),
      )
      const homeSessionID = "ses_00000000000000000000000001"
      const projectSessionID = "ses_00000000000000000000000002"
      const records = fixture.records.filter((record) => record.key[0] !== "meta")
      records.push(
        ...records.map((record) => ({
          key: record.key.map((part) =>
            part === homeSessionID ? projectSessionID : part === "home" || part === "global" ? project.id : part,
          ),
          value: {
            ...record.value,
            ...(record.value.id === homeSessionID ? { id: projectSessionID } : {}),
            ...(record.value.sessionID === homeSessionID ? { sessionID: projectSessionID } : {}),
            ...(record.value.scope ? { scope: project } : {}),
            ...(record.value.scopeID ? { scopeID: project.id, directory: main } : {}),
          },
        })),
        { key: ["projects", project.id], value: project },
        { key: ["meta", "migration", "log"], value: Object.fromEntries(ledger.completed.map((id) => [id, 1])) },
      )
      for (const record of records)
        await Bun.write(path.join(home.host.root, "data", ...record.key) + ".json", JSON.stringify(record.value))
      if (state !== "available") await fs.rm(main, { recursive: true })
      if (state === "file") await Bun.write(main, "replacement file must survive")
      if (state === "dangling-symlink") await fs.symlink(path.join(directory, "absent"), main, "junction")
      if (state === "symlink-loop") await fs.symlink(main, main, "junction")

      let migrated: ProjectDirectories | undefined
      for (const restart of [false, true]) {
        const stages: string[] = []
        await using runtime = await PresetRuntimeHandle.open({
          host: home.host,
          mode: "oneshot",
          network: { hostname: "127.0.0.1", port: 0 },
          startupReporter: (event) => stages.push(event.state === "opening" ? event.stage : event.state),
        })
        expect(stages.at(-1)).toBe("ready")
        const client = createSynergyClient({ baseUrl: `http://127.0.0.1:${runtime.server.port}`, throwOnError: true })
        expect((await client.global.health()).data?.healthy).toBe(true)
        await runtime.run(async () => {
          const folders = (await client.project.directories({ scopeID: project.id })).data!
          expect(folders.folders.map((folder) => [folder.path, folder.available])).toEqual([
            [main, state === "available"],
            [additional, true],
          ])
          if (restart) expect(folders).toEqual(migrated!)
          else migrated = folders
          if (state !== "available")
            await expect(WorkspaceBinding.validate(folders.mainWorkspaceID!, project.id)).rejects.toMatchObject({
              name: "WorkspaceUnavailable",
            })
          const mainFolder = await WorkspaceCatalog.get(folders.mainWorkspaceID!, project.id)
          expect(mainFolder.sharedWritableWorkspaceIDs).toEqual(folders.additionalWorkspaceIDs)
          for (const [scopeID, sessionID] of [
            ["home", homeSessionID],
            [project.id, projectSessionID],
          ]) {
            const scope = await Scope.resolve({ scopeID })
            await ScopeContext.provide({
              scope,
              fn: async () => {
                const info = await Session.get(sessionID)
                expect(info.scope.id).toBe(scopeID)
                const messages = await Session.messages({ sessionID })
                expect(messages).toHaveLength(1)
                expect(messages[0].parts).toContainEqual(
                  expect.objectContaining({ text: "Keep the original transcript." }),
                )
                expect(
                  await Storage.read(
                    StoragePath.sessionInfo(Identifier.asScopeID(scope.id), Identifier.asSessionID(sessionID)),
                  ),
                ).toMatchObject({
                  futureOwner: { retained: true },
                })
              },
            })
          }
          expect(await runMigrations({ output: "silent" })).toMatchObject({ completed: 0, failed: 0 })
          if (!restart)
            await ScopeContext.provide({
              scope: Scope.home(),
              fn: () => Session.create({ title: "New work after upgrade" }),
            })
        })
      }
      if (state === "file") expect(await Bun.file(main).text()).toBe("replacement file must survive")
    }, 30_000)
