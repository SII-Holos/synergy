export type FeishuApiContext = {
  apiBase: string
  getAccessToken: () => Promise<string>
}
