import { $ } from "bun"
import { ConfigMarkdown } from "../config/markdown"

export namespace CommandRenderer {
  const argumentPattern = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
  const placeholderPattern = /\$(\d+)/g
  const quotePattern = /^["']|["']$/g

  export async function render(input: { template: string; arguments: string }) {
    const raw = input.arguments.match(argumentPattern) ?? []
    const args = raw.map((argument) => argument.replace(quotePattern, ""))
    const placeholders = input.template.match(placeholderPattern) ?? []
    let highestPosition = 0
    for (const placeholder of placeholders) {
      const position = Number(placeholder.slice(1))
      if (position > highestPosition) highestPosition = position
    }

    const withPositions = input.template.replaceAll(placeholderPattern, (_, index) => {
      const position = Number(index)
      const argumentIndex = position - 1
      if (argumentIndex >= args.length) return ""
      if (position === highestPosition) return args.slice(argumentIndex).join(" ")
      return args[argumentIndex]
    })
    let rendered = withPositions.replaceAll("$ARGUMENTS", input.arguments)
    const shellExpressions = ConfigMarkdown.shell(rendered)
    if (shellExpressions.length > 0) {
      const results = await Promise.all(
        shellExpressions.map(async ([, command]) => {
          try {
            return await $`${{ raw: command }}`.quiet().nothrow().text()
          } catch (error) {
            return `Error executing command: ${error instanceof Error ? error.message : String(error)}`
          }
        }),
      )
      let index = 0
      rendered = rendered.replace(ConfigMarkdown.SHELL_REGEX, () => results[index++])
    }
    return rendered.trim()
  }
}
