import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { createPluginExportLoader } from "../../../src/plugin/loaders"
function Fixture() {
  const [result, setResult] = createSignal("pending")
  const loader = createPluginExportLoader()
  const params = new URLSearchParams(location.search)
  void loader
    .load(
      "invalid-fixture",
      "/plugin-assets/invalid.js",
      "default",
      params.get("version") ?? "5.0",
      params.get("hash")!,
    )
    .then(
      () => setResult("executed"),
      (error: Error) => setResult(error.message),
    )
    .finally(() => loader.dispose())
  return <output id="result">{result()}</output>
}
render(() => <Fixture />, document.getElementById("root")!)
