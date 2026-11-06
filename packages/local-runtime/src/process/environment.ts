export namespace ProcessEnvironment {
  export const allowed = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SHELL",
    "TERM",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "ComSpec",
    "COMSPEC",
    "PATHEXT",
    "BUN_INSTALL",
    "NODE_PATH",
    "npm_config_cache",
    "PYTHONPATH",
    "GIT_EXEC_PATH",
  ]

  export function select(source: Record<string, string | undefined>): Record<string, string> {
    return Object.fromEntries(allowed.flatMap((key) => (source[key] === undefined ? [] : [[key, source[key]!]])))
  }
}
