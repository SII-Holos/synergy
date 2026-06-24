import { EOL } from "os"

export namespace UI {
  export const Style = {
    TEXT_NORMAL: "\x1b[0m",
    TEXT_NORMAL_BOLD: "\x1b[1m",
    TEXT_DIM: "\x1b[2m",
    TEXT_SUCCESS: "\x1b[32m",
    TEXT_WARNING: "\x1b[33m",
    TEXT_DANGER: "\x1b[31m",
    TEXT_HIGHLIGHT: "\x1b[36m",
    TEXT_HIGHLIGHT_BOLD: "\x1b[1;36m",
  } as const

  export function println(message = "") {
    process.stdout.write(message + EOL)
  }

  export function print(message: string) {
    process.stdout.write(message)
  }

  export function error(message: string) {
    process.stderr.write(`${Style.TEXT_DANGER}${message}${Style.TEXT_NORMAL}${EOL}`)
  }
}
