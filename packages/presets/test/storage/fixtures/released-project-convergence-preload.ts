const usageIDs = ["20260928-independent-usage-ledger-v1", "20261009-usage-response-recovery-v1"]
const entered = Promise.withResolvers<void>()
const released = Promise.withResolvers<void>()
const executions: string[] = []
let active = false
let restart = false
let readable = false
let held = false
let completed = false
let joined = false
let expired = false
let rescue: ReturnType<typeof setTimeout> | undefined

function requireState(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Released project convergence: ${message}`)
}

export const probe = {
  begin(value: boolean) {
    active = true
    restart = value
    readable = false
    if (restart) return
    void entered.promise.catch(() => {})
    rescue = setTimeout(() => {
      expired = true
      entered.reject(new Error("Product import did not reach the convergence barrier"))
      released.resolve()
    }, 30_000)
  },
  async pause(domain: string, id: string) {
    if (domain !== "usage" || id !== usageIDs[0] || completed) return
    held = true
    entered.resolve()
    await released.promise
  },
  async read() {
    if (!restart) {
      await entered.promise
      requireState(held && !completed, "product convergence must remain held while history is readable")
    }
    readable = true
  },
  join(running: boolean) {
    if (!active || !readable || restart) return
    requireState(running && held && !expired, "fixture must join product-started convergence")
    joined = true
    released.resolve()
  },
  body(domain: string, id: string, route: "runner" | "convergence") {
    if (domain !== "usage" || !usageIDs.includes(id)) return
    requireState(
      !executions.some((entry) => entry.endsWith(`/${id}`)),
      "usage migration must execute once across restart",
    )
    executions.push(`${route}/${id}`)
  },
  complete() {
    if (!held) return
    completed = true
    held = false
  },
  runner() {
    if (active && readable) requireState(completed, "replay runner entered before convergence completed")
  },
  result(summary: { completed: number; failed: number }) {
    requireState(completed && joined && !expired, "convergence must finish before the no-op assertion")
    requireState(executions.length === 2, "both usage migrations must run")
    console.info("[released project convergence] " + JSON.stringify({ restart, joined, executions, summary }))
  },
  release() {
    active = false
    clearTimeout(rescue)
    released.resolve()
  },
}

function once(source: string, from: string, to: string) {
  requireState(
    source.indexOf(from) >= 0 && source.indexOf(from) === source.lastIndexOf(from),
    "instrumentation anchor must be unique",
  )
  return source.replace(from, to)
}

Bun.plugin({
  name: "released-project-convergence-barrier",
  setup(builder) {
    const importedProbe = `import { probe } from ${JSON.stringify(import.meta.path)}\n`
    builder.onLoad({ filter: /[/\\]harness[/\\]src[/\\]migration[/\\]index\.ts$/ }, async ({ path }) => {
      let source = importedProbe + (await Bun.file(path).text())
      source = once(
        source,
        "  const state = convergence()",
        "  const state = convergence()\n  probe.join(!!state.running)",
      )
      source = once(
        source,
        '    if (migration.execution !== "after-convergence") continue',
        '    if (migration.execution !== "after-convergence") continue\n    await probe.pause(domain, migration.id)',
      )
      source = once(
        source,
        "    await migration.up(() => {})",
        '    probe.body(domain, migration.id, "convergence")\n    await migration.up(() => {})',
      )
      source = once(
        source,
        "    await mergeDomainLog(domain, { [migration.id]: Date.now() })\n  }\n}",
        "    await mergeDomainLog(domain, { [migration.id]: Date.now() })\n  }\n  probe.complete()\n}",
      )
      source = once(
        source,
        "export function runMigrations(options?: RunOptions): Promise<MigrationSummary> {",
        "export function runMigrations(options?: RunOptions): Promise<MigrationSummary> {\n  probe.runner()",
      )
      source = once(
        source,
        "        const upFn = migration.up",
        '        probe.body(domain, migration.id, "runner")\n        const upFn = migration.up',
      )
      return { contents: source, loader: "ts" }
    })
    builder.onLoad(
      { filter: /[/\\]presets[/\\]test[/\\]storage[/\\]released-project-upgrade\.test\.ts$/ },
      async ({ path }) => {
        let source =
          importedProbe +
          'import { completeDeferredMigrations as drainConvergence } from "@ericsanchezok/synergy-harness/migration"\n' +
          (await Bun.file(path).text())
        source = once(
          source,
          "        await runtime.run(async () => {",
          "        await runtime.run(async () => {\n          probe.begin(restart)\n          let failed = false\n          try {",
        )
        source = once(
          source,
          "            })\n          }",
          "            })\n          }\n          await probe.read()",
        )
        source = once(
          source,
          '          expect(await runMigrations({ output: "silent" })).toMatchObject({ completed: 0, failed: 0 })',
          '          const summary = await runMigrations({ output: "silent" })\n          probe.result(summary)\n          expect(summary).toMatchObject({ completed: 0, failed: 0 })',
        )
        source = once(
          source,
          "        })\n      }\n      if (state",
          `          } catch (error) {
            failed = true
            throw error
          } finally {
            probe.release()
            try { await drainConvergence() } catch (error) {
              if (!failed) throw error
              console.error("Convergence cleanup also failed", error)
            }
          }
        })
      }
      if (state`,
        )
        return { contents: source, loader: "ts" }
      },
    )
  },
})
