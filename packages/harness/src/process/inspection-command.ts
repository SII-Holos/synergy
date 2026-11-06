export interface ProcessSample {
  rssBytes: number
  identity: string
}

export function rssCommand(platform: NodeJS.Platform, pids: number[]): string[] | undefined {
  if (platform === "darwin") return ["ps", "-o", "pid=,rss=,lstart=", "-p", pids.join(",")]
  if (platform === "win32") {
    return [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { try { "{0} {1} {2}" -f $_.Id, $_.WorkingSet64, $_.StartTime.ToUniversalTime().Ticks } catch {} }`,
    ]
  }
}

export function parseRssOutput(platform: NodeJS.Platform, stdout: string, pids: number[]): Map<number, ProcessSample> {
  const requested = new Set(pids)
  const samples = new Map<number, ProcessSample>()
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const rssBytes = Number(match[2]) * (platform === "darwin" ? 1024 : 1)
    const identity = match[3]
    const hasIdentity =
      platform === "darwin"
        ? /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/.test(
            identity,
          )
        : platform === "win32" && /^\d+$/.test(identity) && BigInt(identity) > 0n
    if (requested.has(pid) && Number.isSafeInteger(rssBytes) && rssBytes > 0 && hasIdentity) {
      samples.set(pid, { rssBytes, identity })
    }
  }
  return samples
}
