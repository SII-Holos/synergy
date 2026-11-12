import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

test("the Node Home reader preflights completed native Home3 before credentials and refuses unfinished or retired Homes", async () => {
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "restored-node-home-"))
  try {
    const entry = path.join(directory, "home.ts")
    const bundleFile = path.join(directory, "home.mjs")
    await fs.writeFile(
      entry,
      [
        `export * from ${JSON.stringify(fileURLToPath(new URL("../src/home.ts", import.meta.url)))};`,
        `export * as Native from ${JSON.stringify(fileURLToPath(import.meta.resolve("@ericsanchezok/synergy-harness/lifecycle/home-restoration-file")))};`,
        `export { HomeOwnershipFile } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@ericsanchezok/synergy-harness/lifecycle/home-ownership-file")))};`,
      ].join("\n"),
    )
    const built = await Bun.build({ entrypoints: [entry], target: "node" })
    expect(built.success).toBe(true)
    await fs.writeFile(bundleFile, await built.outputs[0]!.text())
    const script = path.join(directory, "reader.test.mjs")
    await fs.writeFile(
      script,
      `
      import assert from "node:assert/strict";
      import fs from "node:fs/promises";
      import path from "node:path";
      import { randomUUID } from "node:crypto";
      import { prepareHostedHome, readHostedHome, Native, HomeOwnershipFile } from ${JSON.stringify(pathToFileURL(bundleFile).href)};
      assert.equal(typeof globalThis.Bun, "undefined");
      const input = {baseDirectory:process.argv[2],identity:{orgID:"organization",hostID:"restored-host"},origin:"https://organization.example"};
      const home = await prepareHostedHome(input);
      const ownerFile = path.join(home.root,"home-ownership.json");
      const original = JSON.parse(await fs.readFile(ownerFile,"utf8"));
      const restoration = HomeOwnershipFile.RestorationInfo.parse({...original,schemaVersion:3,installationID:randomUUID(),incarnation:randomUUID()});
      const base = Native.StagingDisk.parse({schemaVersion:1,phase:"staging",restoreID:"native-node",owner:"organization-runtime",sourceHash:"a".repeat(64),requestHash:"b".repeat(64),installationID:restoration.installationID,incarnation:restoration.incarnation,target:{home:await fs.realpath(home.home),root:await fs.realpath(home.root),homeIdentity:await Native.physical(home.home),rootIdentity:await Native.physical(home.root),storageHash:"c".repeat(64),artifacts:{kind:"future",directory:path.join(home.root,"artifacts"),parent:home.root,parentIdentity:await Native.physical(home.root)}}});
      const completion = Native.completion(base,"d".repeat(64));
      const complete = JSON.stringify(base)+"\\n"+completion;
      await fs.writeFile(ownerFile,JSON.stringify(restoration)+"\\n");
      await fs.writeFile(Native.filename(home.root),complete);
      const credentialFile = path.join(home.root,"auth","organization-runtime.json");
      const open = fs.open;
      let credentialReads = 0;
      fs.open = async (filename,...args) => { if (filename === credentialFile) credentialReads++; return open(filename,...args); };
      const ready = await readHostedHome(home.home,input.identity);
      assert.deepEqual(ready,{...home,restoration});
      assert.ok(credentialReads > 0);
      assert.deepEqual(await prepareHostedHome(input),ready);
      async function denied() {
        credentialReads = 0;
        await assert.rejects(readHostedHome(home.home,input.identity));
        await assert.rejects(prepareHostedHome(input));
        assert.equal(credentialReads,0);
      }
      const bindingFile = path.join(home.root,"organization.json");
      const bindingBytes = await fs.readFile(bindingFile,"utf8");
      const {publicKey:_,...provisioning} = JSON.parse(bindingBytes);
      await fs.writeFile(bindingFile,JSON.stringify({...provisioning,state:"provisioning"}));
      await denied();
      assert.deepEqual(JSON.parse(await fs.readFile(bindingFile,"utf8")),{...provisioning,state:"provisioning"});
      await fs.writeFile(bindingFile,bindingBytes);
      await fs.rm(Native.filename(home.root));
      await denied();
      await fs.writeFile(Native.filename(home.root),JSON.stringify(base)+"\\n");
      await denied();
      await fs.writeFile(Native.filename(home.root),JSON.stringify(base)+"\\n"+completion.slice(0,-5));
      await denied();
      await fs.writeFile(Native.filename(home.root),complete);
      await fs.writeFile(ownerFile,JSON.stringify({...restoration,installationID:randomUUID()}));
      await denied();
      await fs.writeFile(ownerFile,JSON.stringify(restoration));
      credentialReads = 0;
      await assert.rejects(readHostedHome(home.home,{...input.identity,hostID:"other-host"}));
      assert.equal(credentialReads,0);
      const files = HomeOwnershipFile.open({root:home.root,env:process.env});
      const retired = HomeOwnershipFile.RetirementInfo.parse({...original,schemaVersion:4,source:restoration,maintenanceID:"retired-native-node",referenceHash:"e".repeat(64),physicalHash:await files.physicalHash()});
      await HomeOwnershipFile.open({root:home.root,env:process.env,selected:retired}).retire(restoration);
      await denied();
      console.log("ready");
    `,
    )
    const child = Bun.spawn(["node", script, path.join(directory, "homes")], {
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    })
    try {
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(exit, stderr).toBe(0)
      expect(stdout).toBe("ready\n")
    } finally {
      if (child.exitCode === null) child.kill()
      await child.exited
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 15_000)
