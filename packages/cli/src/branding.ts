import { EOL } from "node:os"

const LOGO = [
  [`█░░█ █▀▀█ █░░ █▀▀█ █▀▀  `, `█▀▀ █░░█ █▀▀▄ █▀▀ █▀▀█ █▀▀▀ █░░█`],
  [`█▀▀█ █░░█ █░░ █░░█ ▀▀█  `, `▀▀█ █▄▄█ █░░█ █▀▀ █▄▄▀ █░▀█ █▄▄█`],
  [`▀░░▀ ▀▀▀▀ ▀▀▀ ▀▀▀▀ ▀▀▀  `, `▀▀▀ ▄▄▄█ ▀░░▀ ▀▀▀ ▀░▀▀ ▀▀▀▀ ▄▄▄█`],
]

export function logo(pad?: string) {
  const result = []
  for (const row of LOGO) {
    if (pad) result.push(pad)
    result.push(Bun.color("gray", "ansi"))
    result.push(row[0])
    result.push("\x1b[0m")
    result.push(row[1])
    result.push(EOL)
  }
  return result.join("").trimEnd()
}
