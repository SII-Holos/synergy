import path from "node:path"
import { Settings, prepareRuntime } from "./runtime"
import { Command, RemoteLab, Reply, Snapshot } from "./remote-protocol"
import { atomicJSON, sealEvidence } from "./evidence"
import { recordedProvider, readRequests } from "./provider"
import type { Driver } from "./runner"

export const RemoteSettings = Settings.extend({ remote: RemoteLab })

export async function docker(lab: RemoteLab, args: string[]) {
  const process = Bun.spawn(
    [
      "docker",
      "--host",
      lab.endpoint.replace(/^https:/, "tcp:"),
      "--tlsverify",
      "--tlscert",
      lab.engineTLS.cert,
      "--tlskey",
      lab.engineTLS.key,
      "--tlscacert",
      lab.engineTLS.ca,
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  if (code) throw new Error(`Owned Docker observation failed: ${stderr}`)
  return stdout
}

export async function controller(directory: string, deadlineMs: number) {
  const pending = new Map<string, ReturnType<typeof Promise.withResolvers<Snapshot | undefined>>>()
  const ready = Promise.withResolvers<Snapshot | undefined>()
  pending.set("ready", ready)
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "remote-worker.ts"), directory], {
    env: { PATH: process.env.PATH, SYNERGY_TEST_HOME: path.join(directory, "home"), SYNERGY_DISABLE_MODELS_FETCH: "1" },
    stdout: Bun.file(path.join(directory, `controller-${Date.now()}.stdout`)),
    stderr: Bun.file(path.join(directory, `controller-${Date.now()}.stderr`)),
    ipc(message: unknown) {
      const result = Reply.parse(message)
      const waiter = pending.get(result.id)
      pending.delete(result.id)
      if (result.error) waiter?.reject(new Error(result.error))
      else waiter?.resolve(result.value)
    },
  })
  void child.exited.then((code) => {
    for (const waiter of pending.values()) waiter.reject(new Error(`Owned controller exited before reply (${code})`))
    pending.clear()
  })
  async function bounded<T>(promise: Promise<T>): Promise<T> {
    const timeout = setTimeout(() => child.kill("SIGKILL"), deadlineMs)
    try {
      return await promise
    } finally {
      clearTimeout(timeout)
    }
  }
  await bounded(ready.promise)
  let stopped = false
  return {
    pid: child.pid,
    async request(command: Command) {
      const id = crypto.randomUUID()
      const waiter = Promise.withResolvers<Snapshot | undefined>()
      pending.set(id, waiter)
      child.send({ id, command })
      return bounded(waiter.promise)
    },
    async kill() {
      child.kill("SIGKILL")
      await child.exited
      stopped = true
      if (child.signalCode !== "SIGKILL") throw new Error("Controller did not die at the SIGKILL barrier")
    },
    async [Symbol.asyncDispose]() {
      if (stopped || child.exitCode !== null) return
      const waiter = Promise.withResolvers<Snapshot | undefined>()
      const id = crypto.randomUUID()
      pending.set(id, waiter)
      child.send({ id, command: "close" })
      await bounded(waiter.promise)
      await child.exited
      stopped = true
    },
  }
}

export function remoteFault(input: unknown): Driver {
  const settings = RemoteSettings.parse(input)
  return async (context) => {
    const lab = settings.remote
    const image = JSON.parse(await docker(lab, ["image", "inspect", lab.image])) as Array<{ Id: string }>
    if (image.length !== 1 || image[0]?.Id !== lab.image) throw new Error("Frozen remote image changed")
    const gateway = await recordedProvider({
      directory: context.directory,
      provider: settings.providerID,
      upstream: settings.upstream,
      apiKey: (await Bun.file(settings.apiKeyFile).text()).trim(),
    })
    await using recorder = gateway
    await prepareRuntime(context.directory, settings, gateway)
    const { remote, ...modelSettings } = settings
    await atomicJSON(path.join(context.directory, "settings.json"), modelSettings)
    await atomicJSON(path.join(context.directory, "lab.json"), remote)
    if (context.scenario.live) await Bun.write(path.join(context.directory, "live"), "1")
    const barriers: string[] = []
    const states: Snapshot[] = []
    const physical: Array<{ at: number; container: string; effects: string; record: string }> = []
    async function observe(state: Snapshot) {
      const ids = (
        await docker(lab, ["ps", "-aq", "--filter", `label=io.synergy.environment=${state.identity.environmentID}`])
      )
        .trim()
        .split("\n")
        .filter(Boolean)
      if (ids.length !== 1 || !ids[0]) throw new Error("Expected exactly one physical allocation")
      const effects = await docker(lab, ["exec", ids[0], "cat", `${state.directory}/effects.txt`])
      const record = await docker(lab, ["exec", ids[0], "cat", `${state.directory}/record.txt`])
      physical.push({ at: Date.now(), container: ids[0], effects, record })
      await atomicJSON(path.join(context.directory, "physical.json"), physical)
      if (effects !== "once\n" || record !== state.identity.marker)
        throw new Error("Physical bytes disagree with the declared single effect")
    }
    const saveFault = context.scenario.id === "fault-save-crash"
    await using first = await controller(context.directory, settings.deadlineMs)
    const exited = Snapshot.parse(await first.request("start"))
    states.push(exited)
    if (exited.state !== "exited" || exited.saved || exited.uses < 1)
      throw new Error("Execution did not stop at the unsaved physical-exit barrier")
    await observe(exited)
    barriers.push(saveFault ? "process-exited" : "effect-written")
    if (saveFault) {
      const blocked = Snapshot.parse(await first.request("block-save"))
      states.push(blocked)
      if (blocked.state !== "unsaved" || blocked.uses < 1) throw new Error("Save failure did not retain ownership")
      barriers.push("save-blocked")
    }
    await first.kill()
    barriers.push("controller-killed")
    await observe(exited)
    await using second = await controller(context.directory, settings.deadlineMs)
    barriers.push("controller-restarted")
    const recovered = Snapshot.parse(await second.request("inspect"))
    states.push(recovered)
    await observe(recovered)
    if (saveFault) {
      if (recovered.state !== "unsaved" || recovered.uses < 1)
        throw new Error("Restart lost an unsaved operation or its ownership")
      await second.request("restore-save")
    }
    const completed = Snapshot.parse(await second.request("complete"))
    states.push(completed)
    if (completed.state !== "completed" || !completed.saved || completed.uses !== 0)
      throw new Error("Recovery failed to save and release the original operation")
    if (saveFault) barriers.push("save-retried")
    const continued = Snapshot.parse(await second.request("continue"))
    states.push(continued)
    await observe(continued)
    const replacement = Snapshot.parse(await second.request("replace"))
    states.push(replacement)
    await observe(replacement)
    if (replacement.allocationID === exited.allocationID) throw new Error("Replacement did not allocate fresh compute")
    const reclaimed = Snapshot.parse(await second.request("reclaim"))
    if (reclaimed.allocationID || reclaimed.uses) throw new Error("Owned compute was not reclaimed after verification")
    const remaining = await Promise.all(
      [
        ["ps", "-aq"],
        ["volume", "ls", "-q"],
        ["network", "ls", "-q"],
      ].map((args) =>
        docker(lab, [...args, "--filter", `label=io.synergy.environment=${exited.identity.environmentID}`]),
      ),
    )
    if (remaining.some((listing) => listing.trim())) throw new Error("Owned physical allocation survived reclamation")
    await atomicJSON(path.join(context.directory, "cleanup.json"), {
      containers: 0,
      volumes: 0,
      networks: 0,
      uses: reclaimed.uses,
      allocation: reclaimed.allocationID,
    })
    barriers.push("continued")
    await Bun.write(path.join(context.directory, "effects.txt"), physical.at(-1)!.effects)
    await atomicJSON(path.join(context.directory, "product.json"), states)
    await atomicJSON(path.join(context.directory, "transport.json"), {
      barriers,
      controllers: [first.pid, second.pid],
      requests: await readRequests(context.directory),
    })
    await atomicJSON(path.join(context.directory, "observations.json"), {
      effects: physical.at(-1)!.effects.trim().split("\n").length,
      reexecutions: physical.some((entry) => entry.effects !== "once\n") ? 1 : 0,
      retainedUniqueBytes: physical.every((entry) => entry.record === exited.identity.marker),
      saveOnlyRetry:
        completed.identity.operationID === exited.identity.operationID &&
        physical.every((entry) => entry.effects === "once\n"),
      continued: replacement.state === "completed" && (!context.scenario.live || continued.markerRecovered),
    })
    const evidence = await Promise.all([
      sealEvidence(context.directory, "product.json", "product"),
      sealEvidence(context.directory, "observations.json", "product"),
      sealEvidence(context.directory, "physical.json", "external"),
      sealEvidence(context.directory, "effects.txt", "external"),
      sealEvidence(context.directory, "cleanup.json", "external"),
      sealEvidence(context.directory, "transport.json", "transport"),
    ])
    return {
      status: "passed",
      model: context.scenario.live ? (continued.markerRecovered ? "passed" : "failed") : "not-applicable",
      barriers,
      requests: await readRequests(context.directory),
      evidence,
    }
  }
}
