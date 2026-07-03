/**
 * Extract the last path segment (filename / directory name).
 * Handles both forward slash and backslash separators.
 */
export function getFilename(path: string | undefined) {
  if (!path) return ""
  const trimmed = path.replace(/[\/\\]+$/, "")
  const parts = trimmed.split(/[\/\\]/)
  return parts[parts.length - 1] ?? ""
}

/**
 * Extract the parent directory of a path, with a trailing separator.
 * Handles both forward slash and backslash — backslashes are normalized to forward slashes in output.
 *
 *   "/home/user/projects" → "/home/user/"
 *   "C:\\Users\\projects" → "C:/Users/"
 *   "~" → ""
 *   "/" → "/"
 */
export function getDirectory(path: string | undefined) {
  if (!path) return ""
  const normalized = path.replace(/\\/g, "/")
  const parts = normalized.split("/")
  if (parts.length <= 1) return normalized === "/" ? "/" : ""
  return parts.slice(0, parts.length - 1).join("/") + "/"
}

/**
 * Return the file extension (last dot-segment), or the full path if no dot exists.
 */
export function getFileExtension(path: string | undefined) {
  if (!path) return ""
  const parts = path.split(".")
  return parts[parts.length - 1]
}

/**
 * Parse a user-typed path string into a parent-directory + search-query pair.
 *
 * Rules (in order):
 * 1. Empty input → homeDir with no query
 * 2. Expand "~" and "~/..." using homeDir
 * 3. Normalize backslashes to forward slashes
 * 4. Absolute paths (Unix `/`, Windows `C:/`, UNC `//`) → split on last `/`; Windows drive roots stay rooted at `C:/`
 * 5. Relative paths → homeDir is the parent, the whole input is the query
 *
 *   resolvePathInput("~/projects/myapp", "/home/user") → { path: "/home/user/projects", query: "myapp" }
 *   resolvePathInput("C:\\Users\\me", "/home/user")    → { path: "C:/Users", query: "me" }
 *   resolvePathInput("D:\\data", "/home/user")         → { path: "D:/", query: "data" }
 *   resolvePathInput("D:", "/home/user")               → { path: "D:/", query: "" }
 *   resolvePathInput("myproject", "/home/user")         → { path: "/home/user", query: "myproject" }
 */
export function resolvePathInput(input: string, homeDir: string): { path: string; query: string } {
  const trimmed = input.trim()
  if (!trimmed) return { path: homeDir || "/", query: "" }

  // Bare tilde: browse home directory itself
  if (trimmed === "~") return { path: homeDir || "/", query: "" }

  let expanded = trimmed

  // Tilde-prefixed path expansion
  if (expanded.startsWith("~/")) {
    expanded = (homeDir || "") + expanded.slice(1)
  }

  // Normalize all backslashes to forward slashes
  expanded = expanded.replace(/\\/g, "/")

  // Bare Windows drive letters are treated as drive roots in browser-style path inputs.
  const driveRoot = expanded.match(/^([A-Za-z]):(?:\/)?$/)
  if (driveRoot) return { path: `${driveRoot[1]}:/`, query: "" }

  const isAbsolute = expanded.startsWith("/") || /^[A-Za-z]:\//.test(expanded)

  if (isAbsolute) {
    const lastSlash = expanded.lastIndexOf("/")
    if (/^[A-Za-z]:\//.test(expanded) && lastSlash <= 2) {
      return { path: `${expanded[0]}:/`, query: expanded.slice(3) }
    }
    const parentDir = expanded.slice(0, lastSlash) || "/"
    const query = expanded.slice(lastSlash + 1)
    return { path: parentDir, query }
  }

  return { path: homeDir || "/", query: expanded }
}
