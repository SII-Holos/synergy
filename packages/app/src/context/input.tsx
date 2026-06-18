import { createStore } from "solid-js/store"
import { createMemo } from "solid-js"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { Persist, persisted } from "@/utils/persist"

export type SendShortcut = "enter" | "mod-enter"
export type ControlProfileId = "manual" | "guarded" | "autonomous" | "full_access"

export const { use: useInput, provider: InputProvider } = createSimpleContext({
  name: "Input",
  init: () => {
    const [store, setStore, _, ready] = persisted(
      Persist.global("input-prefs", ["input-prefs.v1"]),
      createStore<{
        sendShortcut: SendShortcut
        controlProfile?: ControlProfileId
      }>({
        sendShortcut: "enter",
      }),
    )

    return {
      ready,
      sendShortcut: createMemo(() => store.sendShortcut),
      setSendShortcut(value: SendShortcut) {
        setStore("sendShortcut", value)
      },
      controlProfile: createMemo(() => store.controlProfile),
      setControlProfile(value: ControlProfileId) {
        setStore("controlProfile", value)
      },
    }
  },
})
