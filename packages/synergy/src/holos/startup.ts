import * as prompts from "@clack/prompts"
import { UI } from "@/cli/ui"
import { performHolosLogin } from "./login"
import { HolosAuth } from "./auth"

const DIM = UI.Style.TEXT_DIM
const RESET = UI.Style.TEXT_NORMAL
const CYAN = UI.Style.TEXT_HIGHLIGHT
const CYAN_BOLD = UI.Style.TEXT_HIGHLIGHT_BOLD
const BOLD = UI.Style.TEXT_NORMAL_BOLD
const WARN = UI.Style.TEXT_WARNING
const GREEN = UI.Style.TEXT_SUCCESS

export namespace HolosStartup {
  export async function resolveIdentity(interactive: boolean) {
    if (!interactive) {
      const stored = await HolosAuth.getStoredCredential()
      if (!stored) {
        return
      }

      const result = await HolosAuth.verifyStoredCredentials()
      if (!result.valid) {
        return
      }

      await HolosAuth.configureHolos()

      return
    }

    UI.empty()
    prompts.intro(CYAN_BOLD + " Holos " + RESET)

    const stored = await HolosAuth.getStoredCredential()

    if (stored) {
      prompts.log.message(
        UI.card({
          title: "◆ LOCAL AGENT IDENTITY",
          rows: [
            { label: "ID", value: stored.agentId, valueStyle: CYAN },
            { label: "Secret", value: stored.maskedSecret, valueStyle: DIM },
          ],
        }),
      )
    } else {
      prompts.log.message(`${DIM}No local agent identity detected.${RESET}`)
    }

    const options: { value: string; label: string; hint?: string }[] = []

    if (stored) {
      options.push({
        value: "use-local",
        label: "Authenticate with local identity",
        hint: `${stored.agentId.slice(0, 8)}…`,
      })
    }

    options.push(
      { value: "import", label: "Import registered credentials", hint: "enter Agent ID & Secret" },
      { value: "create", label: "Create a new agent identity", hint: "register via browser" },
      { value: "skip", label: "Proceed without Holos", hint: "standalone mode" },
    )

    const choice = await prompts.select({
      message: "Select authentication method.",
      options,
      initialValue: stored ? "use-local" : "create",
    })

    if (prompts.isCancel(choice)) {
      prompts.log.info(`${DIM}Skipped — launching in standalone mode.${RESET}`)
      return
    }

    if (choice === "skip") {
      prompts.log.info(`${DIM}Launching in standalone mode — Holos features disabled.${RESET}`)
      return
    }

    if (choice === "use-local") {
      const spinner = prompts.spinner()
      spinner.start(`${DIM}Handshaking with Holos…${RESET}`)
      const result = await HolosAuth.verifyStoredCredentials()
      if (result.valid) {
        spinner.stop(`${GREEN}●${RESET} Identity verified ${DIM}— agent ${result.agentId.slice(0, 8)}…${RESET}`)
        await HolosAuth.configureHolos()
      } else {
        spinner.stop(`${WARN}●${RESET} Verification failed`, 1)
        prompts.log.warn(
          `${BOLD}Credential mismatch${RESET} — this identity is not recognized by Holos.\n` +
            `  ${DIM}Reason: ${result.reason}${RESET}\n` +
            `  ${DIM}Falling back to standalone mode.${RESET}`,
        )
      }
      return
    }

    if (choice === "import") {
      const agentId = await prompts.text({
        message: "Agent ID",
        placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      })
      if (prompts.isCancel(agentId) || !agentId) {
        prompts.log.info(`${DIM}Cancelled — launching in standalone mode.${RESET}`)
        return
      }

      const agentSecret = await prompts.password({ message: "Agent Secret" })
      if (prompts.isCancel(agentSecret) || !agentSecret) {
        prompts.log.info(`${DIM}Cancelled — launching in standalone mode.${RESET}`)
        return
      }

      const spinner = prompts.spinner()
      spinner.start(`${DIM}Verifying credentials…${RESET}`)
      const result = await HolosAuth.verifyCredentials(agentSecret)
      if (!result.valid) {
        spinner.stop(`${WARN}●${RESET} Verification failed`, 1)
        prompts.log.warn(
          `${BOLD}Unrecognized credentials${RESET} — Holos did not accept this identity.\n` +
            `  ${DIM}Reason: ${result.reason}${RESET}\n` +
            `  ${DIM}Falling back to standalone mode.${RESET}`,
        )
        return
      }

      await HolosAuth.saveCredentialsAndConfigure(agentId, agentSecret)
      spinner.stop(`${GREEN}●${RESET} Credentials imported ${DIM}— agent ${agentId.slice(0, 8)}…${RESET}`)
      return
    }

    if (choice === "create") {
      const result = await performHolosLogin()
      if (!result) {
        prompts.log.info(`${DIM}Cancelled — launching in standalone mode.${RESET}`)
      }
    }
  }
}
