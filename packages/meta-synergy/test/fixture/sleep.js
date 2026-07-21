const ms = Number(process.argv[2] ?? 1000)
setTimeout(() => {
  console.log("done")
}, ms)
