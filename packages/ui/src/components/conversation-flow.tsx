import { createContext, useContext, type ParentProps } from "solid-js"

const Flow = createContext<{ captureLayout?: () => () => void }>()

export function ConversationFlowProvider(props: ParentProps<{ captureLayout?: () => () => void }>) {
  return <Flow.Provider value={{ captureLayout: props.captureLayout }}>{props.children}</Flow.Provider>
}

export const useConversationFlow = () => !!useContext(Flow)
export const useConversationLayoutCapture = () => useContext(Flow)?.captureLayout
