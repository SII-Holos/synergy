export type MetaSynergyHiddenReason = "managed" | "policy"

interface IdentifierValueOptions {
  missing?: string
  unknown?: string
  hiddenReason?: MetaSynergyHiddenReason | null
  showStart?: number
  showEnd?: number
}

interface IdentifierListOptions extends IdentifierValueOptions {
  separator?: string
}

export namespace MetaSynergyDisplay {
  export function identifier(value: string | null | undefined, options?: IdentifierValueOptions): string {
    if (value === null || value === undefined || value.length === 0) {
      return options?.missing ?? "none"
    }

    if (options?.hiddenReason) {
      return maskIdentifier(value, options)
    }

    return value
  }

  export function maybeIdentifier(value: unknown, options?: IdentifierValueOptions): string {
    if (typeof value !== "string") {
      return value == null ? (options?.missing ?? "none") : (options?.unknown ?? "unknown")
    }

    return identifier(value, options)
  }

  export function identifierList(values: Array<string> | undefined, options?: IdentifierListOptions): string {
    if (!values || values.length === 0) {
      return options?.missing ?? "none"
    }

    const separator = options?.separator ?? ", "
    return values.map((value) => identifier(value, options)).join(separator)
  }

  export function maskIdentifier(
    value: string,
    options?: { hiddenReason?: MetaSynergyHiddenReason | null; showStart?: number; showEnd?: number },
  ): string {
    const showStart = options?.showStart ?? defaultPrefixLength(value)
    const showEnd = options?.showEnd ?? defaultSuffixLength(value)

    if (value.length <= showStart + showEnd + 3) {
      return `${value.slice(0, Math.max(1, Math.min(4, value.length)))}...`
    }

    return `${value.slice(0, showStart)}...${value.slice(-showEnd)}`
  }

  function defaultPrefixLength(value: string) {
    if (value.startsWith("env_")) return 8
    if (value.startsWith("ses_")) return 8
    return 8
  }

  function defaultSuffixLength(value: string) {
    if (value.startsWith("env_")) return 7
    if (value.startsWith("ses_")) return 6
    return 8
  }
}
