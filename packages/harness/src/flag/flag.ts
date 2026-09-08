export namespace Flag {
  export const SYNERGY_GIT_BASH_PATH = process.env["SYNERGY_GIT_BASH_PATH"]
  export const SYNERGY_CONFIG = process.env["SYNERGY_CONFIG"]
  export const SYNERGY_CONFIG_DIR = process.env["SYNERGY_CONFIG_DIR"]
  export const SYNERGY_CONFIG_CONTENT = process.env["SYNERGY_CONFIG_CONTENT"]
  export const SYNERGY_DISABLE_AUTOUPDATE = truthy("SYNERGY_DISABLE_AUTOUPDATE")
  export const SYNERGY_DISABLE_TERMINAL_TITLE = truthy("SYNERGY_DISABLE_TERMINAL_TITLE")
  export const SYNERGY_PERMISSION = process.env["SYNERGY_PERMISSION"]
  export const SYNERGY_DISABLE_DEFAULT_PLUGINS = truthy("SYNERGY_DISABLE_DEFAULT_PLUGINS")
  export const SYNERGY_DISABLE_LSP_DOWNLOAD = truthy("SYNERGY_DISABLE_LSP_DOWNLOAD")
  export const SYNERGY_DISABLE_MODELS_FETCH = truthy("SYNERGY_DISABLE_MODELS_FETCH")
  export const SYNERGY_DISABLE_FILEWATCHER = truthy("SYNERGY_DISABLE_FILEWATCHER")
  export const SYNERGY_DISABLE_CLAUDE_CODE = truthy("SYNERGY_DISABLE_CLAUDE_CODE")
  export const SYNERGY_DISABLE_CLAUDE_CODE_PROMPT =
    SYNERGY_DISABLE_CLAUDE_CODE || truthy("SYNERGY_DISABLE_CLAUDE_CODE_PROMPT")
  export const SYNERGY_DISABLE_CLAUDE_CODE_SKILLS =
    SYNERGY_DISABLE_CLAUDE_CODE || truthy("SYNERGY_DISABLE_CLAUDE_CODE_SKILLS")
  export const SYNERGY_FAKE_VCS = process.env["SYNERGY_FAKE_VCS"]
  export const SYNERGY_CLIENT = process.env["SYNERGY_CLIENT"] ?? "cli"
  export const SYNERGY_CWD = process.env["SYNERGY_CWD"]
  export const SYNERGY_BUG_REPORT_URL = process.env["SYNERGY_BUG_REPORT_URL"]
  function truthy(key: string) {
    const value = process.env[key]?.toLowerCase()
    return value === "true" || value === "1"
  }
}
