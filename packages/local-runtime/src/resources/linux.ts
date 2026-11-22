import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import type { ResourceHost } from "@ericsanchezok/synergy-harness/resources/host"
import type { ResourceSnapshot } from "@ericsanchezok/synergy-harness/resources/schema"
import { CgroupMemory } from "./cgroup"

const unescapeMount = (value: string) =>
  value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)))

export function cgroupDirectories(membership: string, mounts: string, version: 1 | 2 = 2): string[] {
  const member = membership
    .split("\n")
    .map((line) => /^(\d+):([^:]*):(\/.*)$/.exec(line))
    .find(
      (match) => match && (version === 1 ? match[2]!.split(",").includes("memory") : match[1] === "0" && !match[2]),
    )?.[3]
  if (member === undefined) return []
  const candidates = mounts
    .split("\n")
    .flatMap((line) => {
      const [left, right] = line.split(" - ")
      const [type, , options] = (right ?? "").split(" ")
      if (!left || (version === 1 ? type !== "cgroup" || !options?.split(",").includes("memory") : type !== "cgroup2"))
        return []
      const fields = left.split(" ")
      const root = unescapeMount(fields[3] ?? "")
      const mount = unescapeMount(fields[4] ?? "")
      if (!root.startsWith("/") || !mount.startsWith("/")) return []
      const relative =
        member === "/"
          ? ""
          : member === root
            ? ""
            : member.startsWith(`${root.replace(/\/$/, "")}/`)
              ? member.slice(root.length)
              : undefined
      if (relative === undefined) return []
      const directory = path.posix.resolve(mount, `.${relative.startsWith("/") ? relative : `/${relative}`}`)
      if (directory !== mount && !directory.startsWith(`${mount}/`)) return []
      return [{ mount, directory, root }]
    })
    .sort((a, b) => a.root.length - b.root.length || b.mount.length - a.mount.length)
  const selected = candidates[0]
  if (!selected) throw new Error(`Cannot resolve cgroup v${version} memory mount`)
  const directories: string[] = []
  for (let current = selected.directory; ; current = path.posix.dirname(current)) {
    directories.push(current)
    if (current === selected.mount) break
  }
  return directories
}

export function memoryFields(text: string) {
  return Object.fromEntries(
    text
      .trim()
      .split("\n")
      .flatMap((line) => {
        const [key, amount, unit] = line.trim().split(/\s+/)
        const value = Number(amount)
        return key && Number.isFinite(value) && value >= 0
          ? [[key.replace(/:$/, ""), value * (unit === "kB" ? 1024 : 1)]]
          : []
      }),
  )
}
function limit(text: string) {
  if (text.trim() === "max") return undefined
  const value = Number(text.trim())
  if (!/^\d+$/.test(text.trim()) || !Number.isFinite(value)) throw new Error("Invalid cgroup memory counter")
  return value
}
function psi(text: string) {
  return Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((line) => {
        const [kind, ...fields] = line.split(/\s+/)
        return [kind, Number(fields.find((field) => field.startsWith("total="))?.slice(6))]
      }),
  )
}
const optional = (file: string) => readFile(file, "utf8").catch(() => undefined)
const readCounter = (file: string) =>
  readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })

// Linux v1 reports PAGE_COUNTER_MAX rounded to a page boundary for an unlimited counter.
// Provenance: https://docs.kernel.org/admin-guide/cgroup-v1/memory.html
function v1Limit(raw: string) {
  if (!/^\d+$/.test(raw.trim())) throw new Error("Invalid cgroup v1 memory counter")
  const value = BigInt(raw.trim())
  return [4096n, 16384n, 65536n].some((page) => value === (1n << 63n) - page) ? undefined : Number(value)
}

async function v1Domains(directories: string[]): Promise<ResourceSnapshot["domains"]> {
  const domains: ResourceSnapshot["domains"] = []
  let inherited = Infinity
  for (const directory of directories) {
    const [limitText, usageText, stats] = await Promise.all([
      readFile(path.join(directory, "memory.limit_in_bytes"), "utf8"),
      readFile(path.join(directory, "memory.usage_in_bytes"), "utf8"),
      readFile(path.join(directory, "memory.stat"), "utf8"),
    ])
    const hard = v1Limit(limitText)
    const usage = limit(usageText)
    if (usage === undefined) throw new Error("Cgroup usage is unavailable")
    if (hard !== undefined)
      domains.push({ kind: "cgroup", capacityBytes: hard, availableBytes: Math.max(0, hard - usage) })
    const reported = /^hierarchical_memory_limit\s+(\S+)/m.exec(stats)?.[1]
    if (reported) inherited = Math.min(inherited, v1Limit(reported) ?? Infinity)
  }
  // A bind mount can hide the parent paying for sibling usage. Its limit is
  // visible in memory.stat, but its remaining bytes cannot be inferred from the leaf.
  if (inherited < Math.min(...domains.map((domain) => domain.capacityBytes ?? Infinity)))
    domains.push({ kind: "cgroup", capacityBytes: inherited, availableBytes: 0 })
  return domains
}

export function linuxResources(proc = "/proc"): ResourceHost.Source {
  let previous: { at: number; counters: Map<string, { stall: number; high: number; oom: number }> } | undefined
  let cgroup: ReturnType<typeof CgroupMemory.readCgroupV2>
  return {
    serviceMemory: () => cgroup,
    async sample(): Promise<ResourceSnapshot> {
      const [memory, membership, mounts, hostPressure] = await Promise.all([
        readFile(path.join(proc, "meminfo"), "utf8"),
        readFile(path.join(proc, "self/cgroup"), "utf8"),
        readFile(path.join(proc, "self/mountinfo"), "utf8"),
        optional(path.join(proc, "pressure/memory")),
      ])
      const values = memoryFields(memory)
      if (!values.MemTotal || values.MemAvailable === undefined)
        throw new Error("Host memory availability is unavailable")
      const domains: ResourceSnapshot["domains"] = [
        { kind: "physical", capacityBytes: values.MemTotal, availableBytes: values.MemAvailable },
      ]
      let quality: ResourceSnapshot["quality"] = hostPressure ? "complete" : "partial"
      const counters = new Map([["host", { stall: psi(hostPressure ?? "").full || 0, high: 0, oom: 0 }]])
      let throttled = false
      const legacy = cgroupDirectories(membership, mounts, 1)
      const directories = legacy.length ? [] : cgroupDirectories(membership, mounts)
      if (!directories.length) quality = "partial"
      if (legacy.length) domains.push(...(await v1Domains(legacy)))
      cgroup = directories[0] ? CgroupMemory.readCgroupV2(directories[0]) : undefined
      for (const directory of directories) {
        const [currentText, maxText, highText, eventsText, pressureText, statText] = await Promise.all([
          readCounter(path.join(directory, "memory.current")),
          readCounter(path.join(directory, "memory.max")),
          optional(path.join(directory, "memory.high")),
          optional(path.join(directory, "memory.events")),
          optional(path.join(directory, "memory.pressure")),
          optional(path.join(directory, "memory.stat")),
        ])
        if (currentText === undefined && maxText === undefined) {
          if (!(await stat(directory)).isDirectory()) throw new Error("Cgroup membership is unavailable")
          quality = "partial"
          continue
        }
        if (currentText === undefined || maxText === undefined)
          throw new Error("Cgroup hard limit or usage is unreadable")
        const current = limit(currentText)
        const max = limit(maxText)
        if (current === undefined) throw new Error("Cgroup usage is unavailable")
        if (max !== undefined) {
          const stats = memoryFields(statText ?? "")
          // Provenance: https://docs.kernel.org/admin-guide/cgroup-v2.html#memory
          // Keep clean inactive file pages separate; the policy chooses how much reclaim to predict.
          const reclaimableBytes =
            pressureText && eventsText && statText
              ? Math.min(
                  current,
                  Math.max(0, (stats.inactive_file ?? 0) - (stats.file_dirty ?? 0) - (stats.file_writeback ?? 0)),
                )
              : undefined
          domains.push({
            kind: "cgroup",
            capacityBytes: max,
            availableBytes: Math.max(0, max - current),
            ...(reclaimableBytes === undefined ? {} : { reclaimableBytes }),
          })
        }
        const high = highText === undefined ? undefined : limit(highText)
        throttled ||= high !== undefined && current >= high
        const events = memoryFields(eventsText ?? "")
        counters.set(directory, {
          high: events.high ?? 0,
          oom: (events.oom ?? 0) + (events.oom_kill ?? 0),
          stall: psi(pressureText ?? "").full || 0,
        })
        if (!eventsText || !pressureText) quality = "partial"
      }
      // cgroup.type exists only on non-root cgroups. At a delegated mount an
      // unbounded visible chain cannot establish the remaining bytes of a hidden parent.
      const mount = directories.at(-1)
      if (mount && domains.length === 1 && (await readCounter(path.join(mount, "cgroup.type"))) !== undefined)
        throw new Error("Container memory headroom is unavailable")
      const at = Date.now()
      let stallFraction = 0
      let highEvent = false
      let oomEvent = false
      for (const [source, counter] of counters) {
        const before = previous?.counters.get(source)
        if (!before || !previous) continue
        if (at > previous.at)
          stallFraction = Math.max(
            stallFraction,
            Math.max(0, counter.stall - before.stall) / ((at - previous.at) * 1000),
          )
        highEvent ||= counter.high > before.high
        oomEvent ||= counter.oom > before.oom
      }
      const pressure =
        oomEvent || stallFraction >= 0.1
          ? "critical"
          : throttled || highEvent || stallFraction >= 0.01
            ? "warning"
            : "normal"
      previous = { at, counters }
      return { sampledAt: at, quality, pressure, domains, processRssBytes: process.memoryUsage.rss() }
    },
  }
}
