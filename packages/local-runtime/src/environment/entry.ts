import fs from "node:fs/promises"
import { z } from "zod"
import { EnvironmentSchema } from "@ericsanchezok/synergy-harness/environment/schema"
import { ExecutionHost } from "./host"
import { NativeExecutor } from "./native-executor"
import { WorkspaceCoordinator } from "../workspace/coordinator"

export async function startExecutionHost() {
  const target = EnvironmentSchema.Target.parse(JSON.parse(process.env.SYNERGY_EXECUTION_TARGET ?? "null"))
  const token = process.env.SYNERGY_EXECUTION_TOKEN ?? ""
  const directory = "/var/lib/synergy-executor"
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const scratch = "/workspaces/.scratch"
  await fs.mkdir(scratch, { recursive: true, mode: 0o700 })
  await fs.chown(scratch, 1000, 1000)
  const executor = await NativeExecutor.open({
    target,
    directory: `${directory}/receipts`,
    coordinator: new WorkspaceCoordinator({ directory: `${directory}/claims` }),
    runAs: { uid: 1000, gid: 1000 },
    runtime: {
      shell: "/bin/bash",
      directory: scratch,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: scratch,
        TMPDIR: "/tmp",
        LANG: "C.UTF-8",
        TERM: "xterm-256color",
      },
    },
    files: {
      materializationRoot: "/workspaces",
      allowedRoots: z.array(z.string()).parse(JSON.parse(process.env.SYNERGY_WORKSPACE_ROOTS ?? "[]")),
    },
  })
  const cert = process.env.SYNERGY_EXECUTION_CERT
  const key = process.env.SYNERGY_EXECUTION_KEY
  const host = ExecutionHost.listen({
    executor,
    target,
    token,
    listen: { hostname: "0.0.0.0", port: 7443 },
    tls: cert && key ? { cert, key } : undefined,
    allowInsecure: !cert && !key,
  })
  let stopping: Promise<void> | undefined
  const stop = () =>
    (stopping ??= (async () => {
      await host.stop()
      await executor.close()
    })())
  process.once(
    "SIGTERM",
    () =>
      void stop().then(
        () => process.exit(0),
        () => process.exit(1),
      ),
  )
  process.once(
    "SIGINT",
    () =>
      void stop().then(
        () => process.exit(0),
        () => process.exit(1),
      ),
  )
  return { ...host, stop }
}

if (import.meta.main) await startExecutionHost()
