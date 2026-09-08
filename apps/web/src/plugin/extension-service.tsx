import { ComposerSlotOutlet } from "@ericsanchezok/synergy-ui/composer-slots"
import { MessageSlotOutlet } from "@ericsanchezok/synergy-ui/message-slots"
import type { PluginUIExtensions } from "@ericsanchezok/synergy-plugin"
import { SlotOutlet } from "./slot-outlet"
import { HostView } from "./host-view"

export function createPluginExtensions(sessionId: () => string | undefined): PluginUIExtensions {
  return {
    render(outlet) {
      if (outlet.slot.startsWith("composer."))
        return (
          <HostView
            render={() => (
              <ComposerSlotOutlet
                slot={outlet.slot as import("@ericsanchezok/synergy-plugin").PluginComposerSlot}
                sessionId={sessionId()}
              />
            )}
          />
        )
      if ("messageId" in outlet)
        return (
          <HostView
            render={() => (
              <MessageSlotOutlet
                slot={outlet.slot}
                messageId={outlet.messageId}
                role={outlet.role}
                sessionId={sessionId()}
              />
            )}
          />
        )
      return <HostView render={() => <SlotOutlet slot={outlet.slot} sessionId={sessionId()} />} />
    },
  }
}
