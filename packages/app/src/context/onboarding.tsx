import { createSignal } from "solid-js"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { useAuth } from "./auth"

export type OnboardingPhase = "welcome" | "setup" | "ready"

export const { use: useOnboarding, provider: OnboardingProvider } = createSimpleContext({
  name: "Onboarding",
  init: () => {
    const auth = useAuth()
    const [phase, setPhase] = createSignal<OnboardingPhase>(auth.isAuthenticated ? "setup" : "welcome")

    return {
      get phase() {
        if (!auth.isAuthenticated) return "welcome"
        if (phase() === "welcome") return "setup"
        return phase()
      },
      get ready() {
        return auth.ready
      },
      completeSetup() {
        setPhase("ready")
      },
      requireSetup() {
        setPhase("setup")
      },
    }
  },
})
