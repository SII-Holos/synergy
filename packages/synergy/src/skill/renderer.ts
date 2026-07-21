export namespace SkillRenderer {
  const argumentPattern = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
  const quotePattern = /^["']|["']$/g
  const placeholderPattern = /\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS|\$(\d+)/g
  const supportedHints = ["$ARGUMENTS", "$ARGUMENTS[N]", "$N (zero-based)"]

  export function hints() {
    return [...supportedHints]
  }

  export function render(input: { template: string; arguments: string }) {
    const template = input.template.trim()
    const placeholders = Array.from(template.matchAll(placeholderPattern))
    if (placeholders.length === 0) {
      return input.arguments.length > 0 ? [template, input.arguments] : [template]
    }

    const args = (input.arguments.match(argumentPattern) ?? []).map((argument) => argument.replace(quotePattern, ""))
    const rendered = template.replaceAll(placeholderPattern, (placeholder, indexed, positional) => {
      if (placeholder === "$ARGUMENTS") return input.arguments
      const index = Number(indexed ?? positional)
      return args[index] ?? ""
    })
    return [rendered]
  }
}
