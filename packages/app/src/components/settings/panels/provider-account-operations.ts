import type { ProviderConnection } from "@ericsanchezok/synergy-sdk/client"

type ProviderConnectionResponse = Promise<{ data?: ProviderConnection }>

export interface ProviderConnectionClient {
  create(
    input: {
      providerConnectionCreateInput: {
        profileID: string
        name: string
        endpoint?: string
        enabled: boolean
      }
    },
    options: { throwOnError: true },
  ): ProviderConnectionResponse
  update(
    input: {
      providerID: string
      providerConnectionUpdateInput: {
        name: string
        endpoint: string | null
        enabled: boolean
      }
    },
    options: { throwOnError: true },
  ): ProviderConnectionResponse
  remove(input: { providerID: string }, options: { throwOnError: true }): Promise<unknown>
}

export type SaveProviderAccountInput =
  | {
      mode: "create"
      profileID: string
      name: string
      endpoint?: string
      enabled: boolean
    }
  | {
      mode: "update"
      providerID: string
      name: string
      endpoint: string | null
      enabled: boolean
    }

export async function saveProviderAccount(
  client: ProviderConnectionClient,
  input: SaveProviderAccountInput,
): Promise<ProviderConnection> {
  const response =
    input.mode === "update"
      ? await client.update(
          {
            providerID: input.providerID,
            providerConnectionUpdateInput: {
              name: input.name,
              endpoint: input.endpoint,
              enabled: input.enabled,
            },
          },
          { throwOnError: true },
        )
      : await client.create(
          {
            providerConnectionCreateInput: {
              profileID: input.profileID,
              name: input.name,
              ...(input.endpoint ? { endpoint: input.endpoint } : {}),
              enabled: input.enabled,
            },
          },
          { throwOnError: true },
        )
  if (!response.data) throw new Error("Provider account response was empty")
  return response.data
}

export async function removeProviderAccount(client: ProviderConnectionClient, providerID: string) {
  await client.remove({ providerID }, { throwOnError: true })
}
