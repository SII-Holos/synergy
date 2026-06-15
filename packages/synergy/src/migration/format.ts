import { UI } from "../cli/ui"

const BAR_WIDTH = 20
const PROGRESS_INTERVAL = 200
const DISABLE_WRAP = "\x1b[?7l"
const ENABLE_WRAP = "\x1b[?7h"

export function progressBar(ratio: number): string {
  return UI.progressBar({ ratio, width: BAR_WIDTH })
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
