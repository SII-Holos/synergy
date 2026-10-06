import { createContext, useContext, type ParentProps } from "solid-js"

const Arrival = createContext<{ take(partID: string): boolean; revision(): number }>({
  take: () => false,
  revision: () => 0,
})

export function ConversationMotionProvider(
  props: ParentProps<{ takeArrival?: (partID: string) => boolean; liveRevision?: () => number }>,
) {
  return (
    <Arrival.Provider
      value={{ take: (id) => props.takeArrival?.(id) ?? false, revision: () => props.liveRevision?.() ?? 0 }}
    >
      {props.children}
    </Arrival.Provider>
  )
}

export const useConversationMotion = () => useContext(Arrival).take
export const useConversationLiveRevision = () => useContext(Arrival).revision
