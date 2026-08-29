import { $ } from "bun"
import { ConfigMarkdown } from "../config/markdown"
import { InstructionEngine } from "../instruction/engine"

export namespace CommandRenderer {
  export async function render(input: { template: string; arguments: string }) {
    let rendered = InstructionEngine.render(input)[0]!
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
      rendered = rendered.replace(ConfigMarkdown.SHELL_REGEX, () => results[index++]!)
    }
    return rendered.trim()
  }
}
