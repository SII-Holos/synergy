export namespace SkillRenderer {
  const argumentPattern = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
  const quotePattern = /^["']|["']$/g
  const placeholderPattern = /\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS|\$(\d+)/g
  const supportedHints = ["$ARGUMENTS", "$ARGUMENTS[N]", "$N (one-based)"]

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
    const highestPosition = placeholders.reduce(
      (highest, placeholder) => Math.max(highest, Number(placeholder[2] ?? 0)),
      0,
    )
    const rendered = template.replaceAll(placeholderPattern, (placeholder, indexed, positional) => {
      if (placeholder === "$ARGUMENTS") return input.arguments
      if (indexed !== undefined) return args[Number(indexed)] ?? ""
      const position = Number(positional)
      const argumentIndex = position - 1
      if (argumentIndex < 0 || argumentIndex >= args.length) return ""
      if (position === highestPosition) return args.slice(argumentIndex).join(" ")
      return args[argumentIndex] ?? ""
    })
    return [rendered]
  }
}
