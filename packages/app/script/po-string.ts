export function decodePoString(value: string): string {
  let decoded = ""

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char !== "\\") {
      decoded += char
      continue
    }

    const escape = value[index + 1]
    if (escape === undefined) throw new Error("Trailing backslash in PO string")
    index += 1

    switch (escape) {
      case "\\":
        decoded += "\\"
        break
      case '"':
        decoded += '"'
        break
      case "n":
        decoded += "\n"
        break
      case "t":
        decoded += "\t"
        break
      case "r":
        decoded += "\r"
        break
      default:
        throw new Error(`Unsupported PO escape: \\${escape}`)
    }
  }

  return decoded
}
