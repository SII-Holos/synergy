import { session } from "electron"
import { BrowserDataContexts } from "../browser-data-contexts.js"
import { BrowserHostBrokerClient } from "../browser-host-broker.js"
import type { BrowserNativePagePool } from "../browser-native-page-pool.js"
import type { DesktopThemeSnapshot } from "../theme.js"
import type { DesktopMemberConnection } from "./member-runtimes.js"

export class DesktopMemberBrowsers {
  private entries = new Map<string, BrowserHostBrokerClient>()

  constructor(
    private options: {
      nativePool: BrowserNativePagePool
      theme(): DesktopThemeSnapshot
      clearSavedData(partition: string): Promise<void>
    },
  ) {}

  async start(member: DesktopMemberConnection) {
    const id = member.connectionID
    if (this.entries.has(id)) throw new Error("Member Browser already started.")
    const broker = new BrowserHostBrokerClient({
      serverUrl: member.browser.url,
      token: member.browser.token,
      headers: member.browser.headers,
      hostId: `member-browser-${id}`,
      runtimeKey: id,
      nativePool: this.options.nativePool,
      dataContexts: new BrowserDataContexts({ session: (partition) => session.fromPartition(partition) }),
      theme: this.options.theme(),
      clearSavedData: this.options.clearSavedData,
    })
    this.entries.set(id, broker)
    let closing: Promise<void> | undefined
    const close = () =>
      (closing ??= broker.close().then(() => {
        if (this.entries.get(id) === broker) this.entries.delete(id)
      }))
    try {
      broker.connect()
      return { close }
    } catch (error) {
      await close()
      throw error
    }
  }
}
