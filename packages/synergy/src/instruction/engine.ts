/**
 * H7 instruction template engine: the shared placeholder-substitution core
 * for skill and command instruction sources. Pure text semantics only —
 * `$N` (one-based, highest position consumes the remainder), `$ARGUMENTS`
 * (raw trailing text), `$ARGUMENTS[N]` (zero-based indexed), and the
 * append-args-when-no-placeholder behavior. Policy stages (shell expansion,
 * trim) live in the owning domain, never here.
 */
export namespace InstructionEngine {
  const argumentPattern = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
  const quotePattern = /^["']|["']$/g
  const placeholderPattern = /\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS|\$(\d+)/g

  export function tokenizeArguments(raw: string): string[] {
    return (raw.match(argumentPattern) ?? []).map((argument) => argument.replace(quotePattern, ""))
  }

  export interface RenderOptions {
    /** Append the raw argument text as a trailing part when the template has
     * no placeholder (skill behavior). Command domains keep this false. */
    appendArgsWhenNoPlaceholder?: boolean
  }

  /** Substitute placeholders in `template` using `args`. Returns one or more
   * text parts; multiple parts only occur with the append option. */
  export function render(input: { template: string; arguments: string }, options?: RenderOptions): string[] {
    const template = input.template.trim()
    const placeholders = Array.from(template.matchAll(placeholderPattern))
    if (placeholders.length === 0) {
      return options?.appendArgsWhenNoPlaceholder && input.arguments.length > 0
        ? [template, input.arguments]
        : [template]
    }

    const args = tokenizeArguments(input.arguments)
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
