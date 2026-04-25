export namespace Flag {
  export const SYNERGY_GIT_BASH_PATH = process.env["SYNERGY_GIT_BASH_PATH"]
  export const SYNERGY_CONFIG = process.env["SYNERGY_CONFIG"]
  export const SYNERGY_CONFIG_DIR = process.env["SYNERGY_CONFIG_DIR"]
  export const SYNERGY_CONFIG_CONTENT = process.env["SYNERGY_CONFIG_CONTENT"]
  export const SYNERGY_DISABLE_AUTOUPDATE = truthy("SYNERGY_DISABLE_AUTOUPDATE")
  export const SYNERGY_DISABLE_PRUNE = truthy("SYNERGY_DISABLE_PRUNE")
  export const SYNERGY_DISABLE_TERMINAL_TITLE = truthy("SYNERGY_DISABLE_TERMINAL_TITLE")
  export const SYNERGY_PERMISSION = process.env["SYNERGY_PERMISSION"]
  export const SYNERGY_DISABLE_DEFAULT_PLUGINS = truthy("SYNERGY_DISABLE_DEFAULT_PLUGINS")
  export const SYNERGY_DISABLE_LSP_DOWNLOAD = truthy("SYNERGY_DISABLE_LSP_DOWNLOAD")
  export const SYNERGY_DISABLE_AUTOCOMPACT = truthy("SYNERGY_DISABLE_AUTOCOMPACT")
  export const SYNERGY_DISABLE_MODELS_FETCH = truthy("SYNERGY_DISABLE_MODELS_FETCH")
  export const SYNERGY_DISABLE_CLAUDE_CODE = truthy("SYNERGY_DISABLE_CLAUDE_CODE")
  export const SYNERGY_DISABLE_CLAUDE_CODE_PROMPT =
    SYNERGY_DISABLE_CLAUDE_CODE || truthy("SYNERGY_DISABLE_CLAUDE_CODE_PROMPT")
  export const SYNERGY_DISABLE_CLAUDE_CODE_SKILLS =
    SYNERGY_DISABLE_CLAUDE_CODE || truthy("SYNERGY_DISABLE_CLAUDE_CODE_SKILLS")
  export const SYNERGY_FAKE_VCS = process.env["SYNERGY_FAKE_VCS"]
  export const SYNERGY_CLIENT = process.env["SYNERGY_CLIENT"] ?? "cli"
  export const SYNERGY_CWD = process.env["SYNERGY_CWD"]
  export const SYNERGY_HOSTED = truthy("SYNERGY_HOSTED")
  export const SYNERGY_SCOPE_ROOT = process.env["SYNERGY_SCOPE_ROOT"]
  export const SYNERGY_DISABLE_WEB_MOUNT = truthy("SYNERGY_DISABLE_WEB_MOUNT")
  export const SYNERGY_AUTH_COOKIE_NAME = process.env["SYNERGY_AUTH_COOKIE_NAME"] ?? "holos_jwt"
  export const SYNERGY_JWT_SECRET = process.env["SYNERGY_JWT_SECRET"]
  export const SYNERGY_JWT_ISSUER = process.env["SYNERGY_JWT_ISSUER"]
  export const SYNERGY_JWT_AUDIENCE = process.env["SYNERGY_JWT_AUDIENCE"]
  export const HOLOS_OWNER_ID = process.env["HOLOS_OWNER_ID"]
  export const SYNERGY_ARXIV_API_URL = process.env["SYNERGY_ARXIV_API_URL"] ?? "https://arxivsearch.synergy.holosai.io"
  export const SYNERGY_SEARXNG_URL = process.env["SYNERGY_SEARXNG_URL"] ?? "https://websearch.synergy.holosai.io"
  export const SYNERGY_AGORA_URL = process.env["SYNERGY_AGORA_URL"]
  export const SYNERGY_AGORA_TOKEN_URL = process.env["SYNERGY_AGORA_TOKEN_URL"]
  export const SYNERGY_BUG_REPORT_URL = process.env["SYNERGY_BUG_REPORT_URL"]
  // Experimental
  export const SYNERGY_EXPERIMENTAL = truthy("SYNERGY_EXPERIMENTAL")
  export const SYNERGY_EXPERIMENTAL_FILEWATCHER = truthy("SYNERGY_EXPERIMENTAL_FILEWATCHER")
  export const SYNERGY_EXPERIMENTAL_DISABLE_FILEWATCHER = truthy("SYNERGY_EXPERIMENTAL_DISABLE_FILEWATCHER")
  export const SYNERGY_EXPERIMENTAL_OXFMT = SYNERGY_EXPERIMENTAL || truthy("SYNERGY_EXPERIMENTAL_OXFMT")
  export const SYNERGY_EXPERIMENTAL_LSP_TY = truthy("SYNERGY_EXPERIMENTAL_LSP_TY")
  export const SYNERGY_EXPERIMENTAL_LSP_TOOL = SYNERGY_EXPERIMENTAL || truthy("SYNERGY_EXPERIMENTAL_LSP_TOOL")

  function truthy(key: string) {
    const value = process.env[key]?.toLowerCase()
    return value === "true" || value === "1" || value === "yes" || value === "on"
  }
}
