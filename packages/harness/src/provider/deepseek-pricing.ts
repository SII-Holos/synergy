import type { ProviderPricing } from "./pricing"

export namespace DeepSeekPricing {
  // Provenance: https://api-docs.deepseek.com/quick_start/pricing/ (verified 2026-10-02).
  // UTC peaks: 01:00–04:00 and 06:00–10:00 on weekdays outside Chinese public holidays.
  // Calendar: https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm (国办发明电〔2025〕7号).
  const holidays = [
    ["01-01", "01-03"],
    ["02-15", "02-23"],
    ["04-04", "04-06"],
    ["05-01", "05-05"],
    ["06-19", "06-21"],
    ["09-25", "09-27"],
    ["10-01", "10-07"],
  ]
  const effectiveFrom = Date.parse("2026-10-01T00:00:00Z")
  export function phase(at: number): "peak" | "off-peak" | "unknown" {
    const time = new Date(at)
    const hour = time.getUTCHours()
    if ([0, 6].includes(time.getUTCDay()) || !((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10))) return "off-peak"
    if (time.getUTCFullYear() !== 2026) return "unknown"
    const date = time.toISOString().slice(5, 10)
    return holidays.some(([start, end]) => date >= start && date <= end) ? "off-peak" : "peak"
  }
  export function capture(
    pricing: ProviderPricing.Info | null,
    endpoint: string,
    started: number,
    modelID?: string,
  ): ProviderPricing.Info | null {
    if ((pricing && pricing.source.kind !== "catalog") || started < effectiveFrom) return pricing
    let url: URL
    try {
      url = new URL(endpoint)
    } catch {
      return pricing
    }
    if (url.origin !== "https://api.deepseek.com") return pricing
    const model = modelID ?? pricing?.source.modelID
    const flash = ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].includes(model ?? "")
    if (!flash && model !== "deepseek-v4-pro") return pricing
    const offPeak = {
      input: flash ? 0.15 : 0.66,
      cacheRead: flash ? 0.003 : 0.022,
      output: flash ? 0.6 : 1.98,
      cacheWrite: 0,
      cacheWrite1h: 0,
    }
    const peak = { ...offPeak, input: offPeak.input * 2, cacheRead: offPeak.cacheRead * 2, output: offPeak.output * 2 }
    const selected = phase(started)
    return {
      version: 1,
      currency: "USD",
      unitTokens: 1_000_000,
      source: { kind: "official", providerID: pricing?.source.providerID ?? "deepseek", modelID: model! },
      capturedAt: started,
      rates: selected === "peak" ? peak : offPeak,
      policy: {
        id: "deepseek-2026-10-01",
        effectiveAt: started,
        clock: "request-start",
        phase: selected,
        calendar: new Date(started).getUTCFullYear() === 2026 ? "CN-2026-state-council-2025-7" : null,
        offPeak,
        peak,
      },
      raw: {
        source: "https://api-docs.deepseek.com/quick_start/pricing/",
        observedAt: "2026-10-02",
        model: model!,
        calendar: "https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm",
      },
    }
  }
  export function crossesBoundary(started: number, ended: number) {
    const initial = phase(started)
    if (initial === "unknown" || phase(ended) !== initial || ended - started > 366 * 86400_000) return true
    const day = Math.floor(started / 86400_000) * 86400_000
    for (let date = day; date <= ended; date += 86400_000)
      for (const hour of [0, 1, 4, 6, 10]) {
        const boundary = date + hour * 3600_000
        if (boundary > started && boundary <= ended && phase(boundary) !== initial) return true
      }
    return false
  }
}
