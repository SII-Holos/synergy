import { readFile } from "node:fs/promises"
import path from "node:path"
import type { ResourceHost } from "@ericsanchezok/synergy-harness/resources/host"
import type { ResourceSnapshot } from "@ericsanchezok/synergy-harness/resources/schema"

const unescapeMount = (value: string) =>
  value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)))

export function cgroupDirectories(membership: string, mounts: string): string[] {
  const member = membership
    .split("\n")
    .find((line) => line.startsWith("0::"))
    ?.slice(3)
  if (member === undefined) return []
  const candidates = mounts
    .split("\n")
    .flatMap((line) => {
      const [left, right] = line.split(" - ")
      if (!left || right?.split(" ")[0] !== "cgroup2") return []
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
      const directory = path.resolve(mount, `.${relative.startsWith("/") ? relative : `/${relative}`}`)
      if (directory !== mount && !directory.startsWith(`${mount}/`)) return []
      return [{ mount, directory }]
    })
    .sort((a, b) => b.mount.length - a.mount.length)
  const selected = candidates[0]
  if (!selected) throw new Error("Cannot resolve cgroup v2 mount")
  const directories: string[] = []
  for (let current = selected.directory; ; current = path.dirname(current)) {
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
  if (!Number.isFinite(value) || value < 0 || !text.trim()) throw new Error("Invalid cgroup memory counter")
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

export function linuxResources(proc = "/proc"): ResourceHost.Source {
  let previous: { at: number; stall: number; high: number; oom: number } | undefined
  return {
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
      let highEvents = 0
      let oomEvents = 0
      let stall = psi(hostPressure ?? "").full || 0
      let throttled = false
      for (const directory of cgroupDirectories(membership, mounts)) {
        const [currentText, maxText, highText, eventsText, pressureText] = await Promise.all([
          optional(path.join(directory, "memory.current")),
          optional(path.join(directory, "memory.max")),
          optional(path.join(directory, "memory.high")),
          optional(path.join(directory, "memory.events")),
          optional(path.join(directory, "memory.pressure")),
        ])
        // A root without a memory controller has neither counter nor limit; partial reads are unsafe.
        if (currentText === undefined && maxText === undefined) {
          quality = "partial"
          continue
        }
        if (currentText === undefined || maxText === undefined) throw new Error("Cgroup hard limit is unreadable")
        const current = limit(currentText)
        const max = limit(maxText)
        if (current === undefined) throw new Error("Cgroup usage is unavailable")
        if (max !== undefined)
          domains.push({ kind: "cgroup", capacityBytes: max, availableBytes: Math.max(0, max - current) })
        const high = highText === undefined ? undefined : limit(highText)
        throttled ||= high !== undefined && current >= high
        const events = memoryFields(eventsText ?? "")
        highEvents += events.high ?? 0
        oomEvents += (events.oom ?? 0) + (events.oom_kill ?? 0)
        stall = Math.max(stall, psi(pressureText ?? "").full || 0)
        if (!eventsText || !pressureText) quality = "partial"
      }
      const at = Date.now()
      const stallFraction =
        previous && at > previous.at ? Math.max(0, stall - previous.stall) / ((at - previous.at) * 1000) : 0
      const pressure =
        (previous && oomEvents > previous.oom) || stallFraction >= 0.1
          ? "critical"
          : throttled || (previous && highEvents > previous.high) || stallFraction >= 0.01
            ? "warning"
            : "normal"
      previous = { at, stall, high: highEvents, oom: oomEvents }
      return { sampledAt: at, quality, pressure, domains, processRssBytes: process.memoryUsage.rss() }
    },
  }
}
