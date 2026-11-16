import type { OrganizationEncryption } from "./accounts.js"

type SafeStorage = {
  isAsyncEncryptionAvailable(): Promise<boolean>
  getSelectedStorageBackend(): string
  encryptStringAsync(value: string): Promise<Buffer>
  decryptStringAsync(value: Buffer): Promise<{ result: string }>
}

export function organizationEncryption(storage: SafeStorage, platform = process.platform): OrganizationEncryption {
  return {
    async available() {
      // Electron's basic_text backend has no OS credential protection; never persist organization tokens through it.
      // https://www.electronjs.org/docs/latest/api/safe-storage#platform-specific-key-providers
      return (
        (await storage.isAsyncEncryptionAvailable()) &&
        !(platform === "linux" && storage.getSelectedStorageBackend() === "basic_text")
      )
    },
    encrypt: (value) => storage.encryptStringAsync(value),
    decrypt: async (value) => (await storage.decryptStringAsync(value)).result,
  }
}
