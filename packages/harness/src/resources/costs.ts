const MiB = 1024 ** 2

/** Bounded observations from individual workers; host RSS is never attributed to a task. */
export class ResourceCosts {
  static history(bytes: number | undefined) {
    return bytes === undefined ? 512 * MiB : 64 * MiB + 4 * bytes
  }
  private readonly startupSamples: number[] = []
  private readonly turnSamples = [[], [], []] as number[][]

  startup() {
    return this.quantile(this.startupSamples, 256 * MiB)
  }

  turn(inputBytes: number) {
    return 4 * inputBytes + this.quantile(this.turnSamples[this.bucket(inputBytes)]!, 32 * MiB)
  }

  observeStartup(bytes: number) {
    this.record(this.startupSamples, bytes)
  }

  observeTurn(inputBytes: number, growthBytes: number) {
    this.record(this.turnSamples[this.bucket(inputBytes)]!, growthBytes)
  }

  private bucket(bytes: number) {
    return bytes < MiB ? 0 : bytes < 16 * MiB ? 1 : 2
  }

  private record(samples: number[], bytes: number) {
    if (!Number.isFinite(bytes) || bytes < 0) return
    samples.push(bytes)
    if (samples.length > 64) samples.shift()
  }

  private quantile(samples: number[], cold: number) {
    if (!samples.length) return cold
    const sorted = samples.toSorted((a, b) => a - b)
    return Math.max(cold, Math.ceil(sorted[Math.ceil(sorted.length * 0.9) - 1]! * 1.25))
  }
}
