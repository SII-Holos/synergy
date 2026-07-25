interface IdentifierValueOptions {
  missing?: string
  unknown?: string
}

interface IdentifierListOptions extends IdentifierValueOptions {
  separator?: string
}

export namespace SynergyLinkDisplay {
  export function identifier(value: string | null | undefined, options?: IdentifierValueOptions): string {
    if (value === null || value === undefined || value.length === 0) {
      return options?.missing ?? "none"
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
}
