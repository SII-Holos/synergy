import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { z } from "zod"
import { RuntimeContext } from "../../src/lifecycle/context"
import { registerAgentWorkerEntrypoint, spawnAgentWorkerProcess } from "../../src/session/agent-turn/process-host"
import {
  registerPolicyWorkerEntrypoint,
  spawnPolicyWorkerProcess,
} from "../../src/enforcement/policy-worker/process-host"
import { tmpdir } from "../support/fixture"

for (const role of ["agent", "policy"] as const)
  for (const failed of [false, true])
    test(`${role} worker stop retains its original Runtime callback${failed ? " and failure" : ""} after real native exit`, async () => {
      await using fixture = await tmpdir()
      const result = path.join(fixture.path, "result.json")
      const owner = RuntimeContext.create({
        home: fixture.path,
        root: fixture.path,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          SYNERGY_TEST_HOME: fixture.path,
          SYNERGY_WORKER_ENV_RESULT: result,
          EXPLICIT_WORKER_VALUE: "public",
        },
      })
      const held = Promise.withResolvers<void>()
      const resume = Promise.withResolvers<void>()
      const delivered = Promise.withResolvers<void>()
      void delivered.promise.catch(() => {})
      const callbackError = failed ? new Error("Original native worker exit callback failed") : undefined
      let callbacks = 0
      let observedSpawns = 0
      const spawn = Bun.spawn
      using observed = spyOn(Bun, "spawn").mockImplementation(
        new Proxy(spawn, {
          apply(target, receiver, args) {
            const input: unknown = args[0]
            if (!input || typeof input !== "object" || Array.isArray(input))
              return Reflect.apply(target, receiver, args)
            const env = "env" in input ? input.env : undefined
            if (
              !env ||
              typeof env !== "object" ||
              !("SYNERGY_RUNTIME_ROOT" in env) ||
              env.SYNERGY_RUNTIME_ROOT !== fixture.path ||
              (role === "agent"
                ? !("SYNERGY_AGENT_WORKER" in env) || env.SYNERGY_AGENT_WORKER !== "1"
                : !("SYNERGY_POLICY_WORKER" in env) || env.SYNERGY_POLICY_WORKER !== "1")
            )
              return Reflect.apply(target, receiver, args)
            const originalExit = "onExit" in input && typeof input.onExit === "function" ? input.onExit : undefined
            if (!originalExit) throw new Error("The selected native worker has no original exit callback")
            observedSpawns++
            return Reflect.apply(target, receiver, [
              {
                ...input,
                onExit(this: unknown, ...exitArgs: unknown[]) {
                  held.resolve()
                  void resume.promise
                    .then(() => Reflect.apply(originalExit, this, exitArgs))
                    .then(delivered.resolve, delivered.reject)
                },
              },
              ...args.slice(1),
            ])
          },
        }),
      )
      try {
        await owner.run(async () => {
          const entry = new URL("../session/fixtures/worker-environment.ts", import.meta.url)
          if (role === "agent") registerAgentWorkerEntrypoint(entry)
          else registerPolicyWorkerEntrypoint(entry)
          const launch = role === "agent" ? spawnAgentWorkerProcess : spawnPolicyWorkerProcess
          const worker = launch({
            onMessage() {},
            onExit() {
              expect(RuntimeContext.current()).toBe(owner)
              callbacks++
              if (callbackError) throw callbackError
            },
          })
          let stopping: Promise<void> | undefined
          try {
            expect(worker.process.pid).toBeGreaterThan(0)
            expect(worker.process.pid).not.toBe(process.pid)
            expect(await worker.process.exited).toBe(0)
            await held.promise
            expect(observedSpawns).toBe(1)
            expect(z.object({ explicit: z.string() }).parse(await Bun.file(result).json()).explicit).toBe("public")
            expect(callbacks).toBe(0)
            let stopped = false
            stopping = worker.stop(100)
            const outcome = stopping.then(
              () => {
                stopped = true
                return { kind: "completed" as const }
              },
              (error: unknown) => {
                stopped = true
                return { kind: "failed" as const, error }
              },
            )
            await new Promise<void>((resolve) => setImmediate(resolve))
            expect(stopped).toBe(false)
            expect(owner.run(() => RuntimeContext.current())).toBe(owner)
            resume.resolve()
            const [finished] = await Promise.all([outcome, delivered.promise])
            expect(callbacks).toBe(1)
            expect(finished.kind).toBe(callbackError ? "failed" : "completed")
            if (callbackError && "error" in finished) expect(finished.error).toBe(callbackError)
            const repeated = await worker.stop(100).then(
              () => undefined,
              (error: unknown) => error,
            )
            expect(repeated).toBe(callbackError)
          } finally {
            resume.resolve()
            await delivered.promise
            await stopping?.catch(() => {})
            await worker.stop(100).catch((error: unknown) => {
              if (!callbackError || error !== callbackError) throw error
            })
          }
        })
      } finally {
        owner.dispose()
      }
    })
