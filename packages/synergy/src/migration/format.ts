const BAR_WIDTH = 20
const PROGRESS_INTERVAL = 200
const DISABLE_WRAP = "\x1b[?7l"
const ENABLE_WRAP = "\x1b[?7h"

export function progressBar(ratio: number): string {
  const clipped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0))
  const filled = Math.round(clipped * BAR_WIDTH)
  const empty = BAR_WIDTH - filled
  return "\x1b[90m[\x1b[0m\x1b[94m\x1b[1m" + "■".repeat(filled) + "\x1b[90m" + "·".repeat(empty) + "\x1b[90m]\x1b[0m"
}

export function stageWrite(line: string, overwrite = false): void {
  if (!process.stderr.isTTY) {
    process.stderr.write(line + (overwrite ? "\n" : ""))
    return
  }
  // \x1b[2K clears the entire line, \r returns to column 0.
  process.stderr.write((overwrite ? "\x1b[2K\r" : "") + line)
}

export function disableWrap(): void {
  if (process.stderr.isTTY) process.stderr.write(DISABLE_WRAP)
}

export function enableWrap(): void {
  if (process.stderr.isTTY) process.stderr.write(ENABLE_WRAP)
}

export { BAR_WIDTH, PROGRESS_INTERVAL }
