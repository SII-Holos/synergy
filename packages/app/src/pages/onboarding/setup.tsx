import { createSignal, createEffect, Show } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { useOnboarding } from "@/context/onboarding"
import { useAuth } from "@/context/auth"
import { Logo } from "@ericsanchezok/synergy-ui/logo"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { IntroSequence } from "./intro-sequence"
import { GenesisChat, cleanupGenesisSession } from "./genesis-chat"
import { PhaseTransition } from "./transition"
import type { HolosProfile } from "@ericsanchezok/synergy-sdk/client"

type SetupPhase = "checking" | "model-required" | "chat" | "transition-out"

interface SetupProps {
  onConnectionError: () => void
}

function isNetworkError(error: unknown) {
  if (error instanceof Error) {
    const message = error.message.toLowerCase()
    return message.includes("fetch") || message.includes("network") || message.includes("abort")
  }
  return false
}

export default function Setup(props: SetupProps) {
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const onboarding = useOnboarding()
  const auth = useAuth()

  const [phase, setPhase] = createSignal<SetupPhase>("checking")
  const [showIntro, setShowIntro] = createSignal(false)
  const [profileName, setProfileName] = createSignal<string | undefined>()
  const [complete, setComplete] = createSignal(false)

  createEffect(() => {
    if (phase() !== "checking") return

    if (auth.status === "guest") {
      checkProfile()
      return
    }

    const serverUrl = globalSDK.url
    const fetchFn = platform.fetch ?? globalThis.fetch
    fetchFn(`${serverUrl}/holos/verify`)
      .then(async (res) => {
        if (res.status === 401) {
          auth.logout()
          return
        }
        checkProfile()
      })
      .catch((error) => {
        if (isNetworkError(error)) {
          props.onConnectionError()
          return
        }
        checkProfile()
      })

    function checkProfile() {
      const profileApi = globalSDK.client.holos?.profile
      if (!profileApi) {
        onboarding.completeSetup()
        return
      }

      profileApi
        .get()
        .then(async (res) => {
          const profile = res.data?.profile as HolosProfile | null
          if (profile?.initialized) {
            onboarding.completeSetup()
            return
          }
          onboarding.requireSetup()
          try {
            const health = await globalSDK.client.global.health()
            const modelReady = health.data?.modelReady ?? true
            if (!modelReady) {
              setPhase("model-required")
              return
            }
          } catch {}
          setShowIntro(true)
        })
        .catch((error) => {
          if (isNetworkError(error)) {
            props.onConnectionError()
            return
          }
          onboarding.completeSetup()
        })
    }
  })

  const handleIntroPreload = () => {
    setPhase("chat")
  }

  const handleIntroComplete = () => {
    setShowIntro(false)
  }

  const handleProfileUpdate = (update: { name: string; bio: string }) => {
    setProfileName(update.name)
  }

  const handleComplete = () => {
    setComplete(true)
  }

  const handleSkip = async () => {
    const fetchFn = platform.fetch ?? globalThis.fetch
    await fetchFn(`${globalSDK.url}/holos/profile/skip-genesis`, { method: "POST" }).catch(() => {})
    setPhase("transition-out")
  }

  const handleNext = () => {
    setPhase("transition-out")
  }

  const retryModelCheck = () => {
    setPhase("checking")
  }

  const handleTransitionOutMidpoint = () => {
    cleanupGenesisSession(globalSDK.url, platform.fetch)
    onboarding.completeSetup()
  }

  return (
    <div class="fixed inset-0 bg-background-base">
      <style>{`
        @keyframes genesis-slide-up {
          0%   { opacity: 0; transform: translateY(20px) scale(0.97); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>

      <Show when={phase() === "checking"}>
        <div class="flex items-center justify-center h-full" />
      </Show>

      <Show when={phase() === "model-required"}>
        <div class="relative flex-1 h-full min-h-0 flex flex-col items-center justify-center font-sans">
          <div class="w-full max-w-xl px-6 flex flex-col items-center gap-8">
            <Logo class="w-58.5 opacity-12 shrink-0" />
            <div class="flex flex-col items-center gap-2 text-center">
              <h1 class="text-lg font-medium text-text-strong">Set up an AI provider</h1>
              <p class="text-sm text-text-weak max-w-md">
                Synergy needs an AI provider configured before you can get started.
              </p>
            </div>
            <div class="w-full rounded-2xl border border-border-weak-base bg-surface-raised-base/50 p-4 flex flex-col gap-3">
              <div class="text-sm text-text-weak">Run the following command in your terminal:</div>
              <div class="px-3 py-2 rounded-lg bg-background-base font-mono text-sm text-text-base">
                synergy config ui
              </div>
            </div>
            <Button size="large" onClick={retryModelCheck}>
              Retry
            </Button>
          </div>
        </div>
      </Show>

      <Show when={phase() === "chat"}>
        <div class="h-full flex items-stretch justify-center">
          <div class="w-full max-w-[680px] flex flex-col">
            <GenesisChat
              heroReady={!showIntro()}
              onSkip={handleSkip}
              onProfileUpdate={handleProfileUpdate}
              onComplete={handleComplete}
            />
          </div>
        </div>

        <Show when={complete()}>
          <div
            class="fixed bottom-8 left-1/2 -translate-x-1/2 z-20"
            style={{ animation: "genesis-slide-up 2s cubic-bezier(0.16, 1, 0.3, 1) 0.6s both" }}
          >
            <button
              type="button"
              class="group flex items-center gap-3 px-8 py-4 rounded-2xl bg-text-base text-background-base text-16-medium transition-all hover:opacity-90 active:scale-[0.97]"
              onClick={handleNext}
            >
              <span>Continue</span>
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                class="transition-transform group-hover:translate-x-1"
              >
                <path
                  d="M5 12H19M14 7L19 12L14 17"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
          </div>
        </Show>
      </Show>

      <Show when={phase() === "transition-out"}>
        <PhaseTransition
          text={profileName() ? `Nice to meet you. I'm ${profileName()}.` : "All set"}
          onMidpoint={handleTransitionOutMidpoint}
          onComplete={() => {}}
        />
      </Show>

      <Show when={showIntro()}>
        <IntroSequence onPreload={handleIntroPreload} onComplete={handleIntroComplete} />
      </Show>
    </div>
  )
}
