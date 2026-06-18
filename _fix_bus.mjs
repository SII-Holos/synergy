import { readFileSync, writeFileSync } from "node:fs"

const base = "packages/synergy/src"

// Fix 1: plugin/index.ts
let file = readFileSync(`${base}/plugin/index.ts`, "utf8")
file = file.replace(
  `    Bus.subscribeAll(async (input) => {
      const loaded = await state().then((x) => x.loaded)
      for (const { hooks } of loaded) {
        hooks["event"]?.({ event: input })
      }
    })`,
  `    const pluginEventState = Instance.state(
      () => {
        const unsub = Bus.subscribeAll(async (input) => {
          const loaded = await state().then((x) => x.loaded)
          for (const { hooks } of loaded) {
            hooks["event"]?.({ event: input })
          }
        })
        return { unsub }
      },
      async (s) => s.unsub(),
    )
    void pluginEventState()`,
)
writeFileSync(`${base}/plugin/index.ts`, file)
console.log("ok: plugin/index.ts")

// Fix 2: file/format.ts
file = readFileSync(`${base}/file/format.ts`, "utf8")
file = file.replace(
  /  export function init\(\) \{\s+log\.info\("init"\)\s+Bus\.subscribe\(File\.Event\.Edited[\s\S]+?\}\)\s+\}\)/,
  `  export function init() {
    log.info("init")
    const fmtState = Instance.state(
      () => {
        const unsub = Bus.subscribe(File.Event.Edited, async (payload) => {
          const file = payload.properties.file
          log.info("formatting", { file })
          const ext = path.extname(file)

          for (const item of await getFormatter(ext)) {
            log.info("running", { command: item.command })
            try {
              const proc = Bun.spawn({
                cmd: item.command.map((x) => x.replace("$FILE", file)),
                cwd: Instance.directory,
                env: { ...process.env, ...item.environment },
                stdout: "ignore",
                stderr: "ignore",
              })
              const exit = await proc.exited
              if (exit !== 0)
                log.error("failed", {
                  command: item.command,
                  ...item.environment,
                })
            } catch (error) {
              log.error("failed to format file", {
                error,
                command: item.command,
                ...item.environment,
                file,
              })
            }
          }
        })
        return { unsub }
      },
      async (s) => s.unsub(),
    )
    void fmtState()
  }`,
)
writeFileSync(`${base}/file/format.ts`, file)
console.log("ok: file/format.ts")

// Fix 3: project/bootstrap.ts
file = readFileSync(`${base}/project/bootstrap.ts`, "utf8")
file = file.replace(
  `  Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      await Scope.setInitialized(Instance.scope.id)
    }
  })`,
  `  const commandState = Instance.state(
    () => {
      const unsub = Bus.subscribe(Command.Event.Executed, async (payload) => {
        if (payload.properties.name === Command.Default.INIT) {
          await Scope.setInitialized(Instance.scope.id)
        }
      })
      return { unsub }
    },
    async (s) => s.unsub(),
  )
  void commandState()`,
)
writeFileSync(`${base}/project/bootstrap.ts`, file)
console.log("ok: project/bootstrap.ts")

// Fix 4: server/runtime.ts
file = readFileSync(`${base}/server/runtime.ts`, "utf8")
file = file.replace(
  `  Bus.subscribe(Channel.Event.Connected, (event) => {
    const channel = event.properties.channelType + ":" + event.properties.accountId
    Bun.stderr.write(DIM + "    " + GREEN + "●" + RESET + " " + channel + " " + DIM + "reconnected" + RESET + EOL)
  })
  Bus.subscribe(Channel.Event.Disconnected, (event) => {
    const channel = event.properties.channelType + ":" + event.properties.accountId
    const reason = event.properties.reason ? ": " + event.properties.reason : ""
    Bun.stderr.write(
      DIM + "    " + WARN + "●" + RESET + " " + channel + " " + DIM + "disconnected" + reason + RESET + EOL,
    )
  })`,
  `  const channelState = Instance.state(
    () => {
      const unsubs: Array<() => void> = []
      unsubs.push(
        Bus.subscribe(Channel.Event.Connected, (event) => {
          const channel = event.properties.channelType + ":" + event.properties.accountId
          Bun.stderr.write(DIM + "    " + GREEN + "●" + RESET + " " + channel + " " + DIM + "reconnected" + RESET + EOL)
        }),
      )
      unsubs.push(
        Bus.subscribe(Channel.Event.Disconnected, (event) => {
          const channel = event.properties.channelType + ":" + event.properties.accountId
          const reason = event.properties.reason ? ": " + event.properties.reason : ""
          Bun.stderr.write(
            DIM + "    " + WARN + "●" + RESET + " " + channel + " " + DIM + "disconnected" + reason + RESET + EOL,
          )
        }),
      )
      return { unsubs }
    },
    async (s) => {
      for (const unsub of s.unsubs) unsub()
    },
  )
  void channelState()`,
)
writeFileSync(`${base}/server/runtime.ts`, file)
console.log("ok: server/runtime.ts")

// Fix 5: engram/embedding.ts — add dispose()
file = readFileSync(`${base}/engram/embedding.ts`, "utf8")
const disposeBlock = `
  /**
   * Release the local embedding model to free memory.
   * No-op if the model was never loaded or was already disposed.
   * Subsequent generate() calls will load the model again on demand.
   */
  export function dispose() {
    localExtractor = undefined
    localModelReady = false
    localModelError = undefined
  }
`
file = file.replace(`  async function resolveModel() {`, disposeBlock + `\n  async function resolveModel() {`)
writeFileSync(`${base}/engram/embedding.ts`, file)
console.log("ok: engram/embedding.ts")

// Fix 6: engram/experience-recall.ts — add timeout cleanup
file = readFileSync(`${base}/engram/experience-recall.ts`, "utf8")
file = file.replace(
  `  export function trackRetrieval(sessionID: string, experienceIDs: string[]) {
    pendingRetrievals.set(sessionID, experienceIDs)
  }`,
  `  export function trackRetrieval(sessionID: string, experienceIDs: string[]) {
    pendingRetrievals.set(sessionID, experienceIDs)
    setTimeout(() => {
      pendingRetrievals.delete(sessionID)
    }, 10 * 60 * 1000)
  }`,
)
writeFileSync(`${base}/engram/experience-recall.ts`, file)
console.log("ok: engram/experience-recall.ts")

console.log("ALL DONE")
