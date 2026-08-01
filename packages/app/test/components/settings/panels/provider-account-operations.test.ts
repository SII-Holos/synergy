import { describe, expect, test } from "bun:test"
import type { ProviderConnection } from "@ericsanchezok/synergy-sdk/client"
import {
  canAddProviderAccount,
  removeProviderAccount,
  saveProviderAccount,
  type ProviderConnectionClient,
} from "../../../../src/components/settings/panels/provider-account-operations"

function connection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return {
    id: "deepseek-work",
    name: "DeepSeek Work",
    profileID: "deepseek",
    catalogProviderID: "deepseek",
    enabled: true,
    configured: true,
    removable: true,
    canCreateSibling: true,
    ...overrides,
  }
}

function mockClient() {
  const calls: Array<{ operation: string; input: unknown; options: unknown }> = []
  const client: ProviderConnectionClient = {
    async create(input, options) {
      calls.push({ operation: "create", input, options })
      return { data: connection({ name: input.providerConnectionCreateInput.name }) }
    },
    async update(input, options) {
      calls.push({ operation: "update", input, options })
      return { data: connection({ id: input.providerID, name: input.providerConnectionUpdateInput.name }) }
    },
    async remove(input, options) {
      calls.push({ operation: "remove", input, options })
    },
  }
  return { client, calls }
}

describe("provider account operations", () => {
  test("only permits another account when the server reports a reusable catalog", () => {
    expect(canAddProviderAccount(connection({ canCreateSibling: true }))).toBe(true)
    expect(canAddProviderAccount(connection({ canCreateSibling: false }))).toBe(false)
  })

  test("creates a named account with its own endpoint and enabled state", async () => {
    const { client, calls } = mockClient()
    const result = await saveProviderAccount(client, {
      mode: "create",
      profileID: "deepseek",
      name: "DeepSeek Work",
      endpoint: "https://work.deepseek.invalid/v1",
      enabled: false,
    })

    expect(result.name).toBe("DeepSeek Work")
    expect(calls).toEqual([
      {
        operation: "create",
        input: {
          providerConnectionCreateInput: {
            profileID: "deepseek",
            name: "DeepSeek Work",
            endpoint: "https://work.deepseek.invalid/v1",
            enabled: false,
          },
        },
        options: { throwOnError: true },
      },
    ])
  })

  test("updates and removes only the selected account connection", async () => {
    const { client, calls } = mockClient()
    const result = await saveProviderAccount(client, {
      mode: "update",
      providerID: "deepseek-work",
      name: "DeepSeek Production",
      endpoint: null,
      enabled: true,
    })
    await removeProviderAccount(client, "deepseek-work")

    expect(result).toMatchObject({ id: "deepseek-work", name: "DeepSeek Production" })
    expect(calls).toEqual([
      {
        operation: "update",
        input: {
          providerID: "deepseek-work",
          providerConnectionUpdateInput: {
            name: "DeepSeek Production",
            endpoint: null,
            enabled: true,
          },
        },
        options: { throwOnError: true },
      },
      {
        operation: "remove",
        input: { providerID: "deepseek-work" },
        options: { throwOnError: true },
      },
    ])
  })

  test("rejects an empty generated client response", async () => {
    const { client } = mockClient()
    client.create = async () => ({})

    await expect(
      saveProviderAccount(client, {
        mode: "create",
        profileID: "deepseek",
        name: "DeepSeek Work",
        enabled: true,
      }),
    ).rejects.toThrow("Provider account response was empty")
  })
})
