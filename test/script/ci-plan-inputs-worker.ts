import { mock } from "bun:test"
import * as childProcess from "node:child_process"
import ts from "typescript"

const [root, base, head, serializedTasks, repetitions, fault] = process.argv.slice(2)
const counts = { inventory: 0, batch: 0, blobs: 0, parse: 0 }
const parsedFiles: string[] = []
const batches: string[][] = []
const execFileSync = childProcess.execFileSync
const createSourceFile = ts.createSourceFile
mock.module("node:child_process", () => ({
  ...childProcess,
  execFileSync(command: string, args: string[], options: childProcess.ExecFileSyncOptions) {
    const output = execFileSync(command, args, options)
    if (command !== "git") return output
    if (args[0] === "ls-tree") counts.inventory++
    if (args[0] === "cat-file" && args[1] === "--batch") {
      counts.batch++
      const oids = String(options.input).split("\n").filter(Boolean)
      counts.blobs += oids.length
      batches.push(oids)
      if (fault === "truncate") return Buffer.from(output).subarray(0, -1)
      if (fault === "missing") return Buffer.from(`${oids[0]} missing\n`)
    }
    return output
  },
}))
mock.module("typescript", () => ({
  default: {
    ...ts,
    createSourceFile(...args: Parameters<typeof ts.createSourceFile>) {
      counts.parse++
      parsedFiles.push(args[0])
      return createSourceFile(...args)
    },
  },
}))
const { planInputs } = await import("../../script/ci")
const { createPlan } = await import("../../script/ci/plan")
const observations = []
try {
  for (let index = 0; index < Number(repetitions); index++) {
    const tasks = JSON.parse(serializedTasks!)
    const inputs = await planInputs(root!, base!, head!, tasks)
    observations.push({
      inputs,
      plan: createPlan({ base: base!, head: head!, sha: head!, run: "fixture", mode: "affected", tasks, ...inputs }),
      counts: { ...counts },
    })
  }
  console.log(JSON.stringify({ observations, parsedFiles, batches }))
} catch (error) {
  const failure = error as { name?: string; revision?: string; stage?: string; path?: string; reason?: string }
  console.log(
    JSON.stringify({
      observations,
      counts,
      failure: {
        name: failure.name,
        revision: failure.revision,
        stage: failure.stage,
        path: failure.path,
        reason: failure.reason,
      },
    }),
  )
}
