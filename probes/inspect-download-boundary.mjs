import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('sandbox')
const sentinelPath = path.join(root, 'protected.txt')
const sentinel = await fs.readFile(sentinelPath)
const entries = []

const walk = async directory => {
  for (const name of await fs.readdir(directory)) {
    const absolute = path.join(directory, name)
    const relative = path.relative(root, absolute)
    const stat = await fs.lstat(absolute)
    if (stat.isDirectory()) {
      entries.push({path: relative, type: 'directory'})
      await walk(absolute)
    } else if (stat.isFile()) {
      const data = await fs.readFile(absolute)
      entries.push({
        path: relative,
        type: 'file',
        size: data.length,
        sha256: crypto.createHash('sha256').update(data).digest('hex')
      })
    } else {
      entries.push({path: relative, type: 'other'})
    }
  }
}

await walk(root)
const report = {
  runtime: process.version,
  platform: process.platform,
  downloadOutcome: process.env.DOWNLOAD_OUTCOME,
  outsideModified: sentinel.toString() !== 'protected-sentinel',
  sentinelSha256: crypto.createHash('sha256').update(sentinel).digest('hex'),
  entries
}
await fs.mkdir('probe-results', {recursive: true})
await fs.writeFile(
  `probe-results/download-boundary-${process.platform}.json`,
  JSON.stringify(report, null, 2)
)
console.log(JSON.stringify(report, null, 2))

