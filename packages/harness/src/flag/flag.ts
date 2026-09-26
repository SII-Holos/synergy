import { RuntimeContext } from "../lifecycle/context"

export const Flag = {
  get SYNERGY_GIT_BASH_PATH() {
    return RuntimeContext.current().host.env["SYNERGY_GIT_BASH_PATH"]
  },
  get SYNERGY_CONFIG() {
    return RuntimeContext.current().host.env["SYNERGY_CONFIG"]
  },
  get SYNERGY_CONFIG_DIR() {
    return RuntimeContext.current().host.env["SYNERGY_CONFIG_DIR"]
  },
  get SYNERGY_CONFIG_CONTENT() {
    return RuntimeContext.current().host.env["SYNERGY_CONFIG_CONTENT"]
  },
  get SYNERGY_DISABLE_AUTOUPDATE() {
    return truthy("SYNERGY_DISABLE_AUTOUPDATE")
  },
  get SYNERGY_DISABLE_TERMINAL_TITLE() {
    return truthy("SYNERGY_DISABLE_TERMINAL_TITLE")
  },
  get SYNERGY_PERMISSION() {
    return RuntimeContext.current().host.env["SYNERGY_PERMISSION"]
  },
  get SYNERGY_DISABLE_DEFAULT_PLUGINS() {
    return truthy("SYNERGY_DISABLE_DEFAULT_PLUGINS")
  },
  get SYNERGY_DISABLE_LSP_DOWNLOAD() {
    return truthy("SYNERGY_DISABLE_LSP_DOWNLOAD")
  },
  get SYNERGY_DISABLE_MODELS_FETCH() {
    return truthy("SYNERGY_DISABLE_MODELS_FETCH")
  },
  get SYNERGY_DISABLE_FILEWATCHER() {
    return truthy("SYNERGY_DISABLE_FILEWATCHER")
  },
  get SYNERGY_DISABLE_CLAUDE_CODE() {
    return truthy("SYNERGY_DISABLE_CLAUDE_CODE")
  },
  get SYNERGY_DISABLE_CLAUDE_CODE_PROMPT() {
    return Flag.SYNERGY_DISABLE_CLAUDE_CODE || truthy("SYNERGY_DISABLE_CLAUDE_CODE_PROMPT")
  },
  get SYNERGY_DISABLE_CLAUDE_CODE_SKILLS() {
    return Flag.SYNERGY_DISABLE_CLAUDE_CODE || truthy("SYNERGY_DISABLE_CLAUDE_CODE_SKILLS")
  },
  get SYNERGY_FAKE_VCS() {
    return RuntimeContext.current().host.env["SYNERGY_FAKE_VCS"]
  },
  get SYNERGY_CLIENT() {
    return RuntimeContext.current().host.env["SYNERGY_CLIENT"] ?? "cli"
  },
  get SYNERGY_CWD() {
    return RuntimeContext.current().host.env["SYNERGY_CWD"]
  },
  get SYNERGY_BUG_REPORT_URL() {
    return RuntimeContext.current().host.env["SYNERGY_BUG_REPORT_URL"]
  },
}

function truthy(key: string) {
  const value = RuntimeContext.current().host.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}
