import { expect, test } from "bun:test"
import { SecretPatterns } from "../src/patterns"

test("observability and SmartAllow retain their separate redaction rules", () => {
  expect(SecretPatterns.replaceStandalone("ghp_abcdefgh and hf_abcdefgh", "hidden")).toEqual({
    text: "hidden and hidden",
    matches: 2,
  })
  expect("sk-abcdefghijklmnopqrst".replace(SecretPatterns.longForm(), "hidden")).toBe("hidden")
  let auth = "Bearer opaque-value Basic YWJjZA== Digest YWJjZA=="
  for (const [pattern, replacement] of SecretPatterns.authSchemes) auth = auth.replace(pattern, replacement)
  expect(auth).toBe("Bearer [redacted] Basic [redacted] Digest [redacted]")
  expect("password=example-value".replace(SecretPatterns.keyValue, "$1hidden")).toBe("password=hidden")
  expect("?token=example-value&mode=1".replace(SecretPatterns.queryParam, "$1hidden")).toBe("?token=hidden&mode=1")
})
