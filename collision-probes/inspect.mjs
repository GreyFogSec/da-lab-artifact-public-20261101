import crypto from 'node:crypto'
import fs from 'node:fs/promises'

const metadata = JSON.parse(
  await fs.readFile('collision-meta/service-validation.json', 'utf8')
)
const expected = new Map(
  metadata.artifacts.map(artifact => [artifact.payloadSha256, artifact])
)
const iterations = []
for (let iteration = 1; iteration <= 10; iteration++) {
  const file = `collision-results/${iteration}/collision.bin`
  try {
    const data = await fs.readFile(file)
    const digest = crypto.createHash('sha256').update(data).digest('hex')
    const match = expected.get(digest)
    iterations.push({
      iteration,
      exists: true,
      size: data.length,
      sha256: digest,
      matchedArtifact: match?.name || null,
      mixedOrCorrupt: !match
    })
  } catch (error) {
    iterations.push({iteration, exists: false, error: error.code})
  }
}
const distinctHashes = [...new Set(iterations.filter(x => x.sha256).map(x => x.sha256))]
const report = {
  runtime: process.version,
  platform: process.platform,
  artifactCount: metadata.artifacts.length,
  iterations,
  distinctOutputCount: distinctHashes.length,
  anyMixedOrCorrupt: iterations.some(item => item.mixedOrCorrupt)
}
await fs.mkdir('collision-evidence', {recursive: true})
await fs.writeFile('collision-evidence/outcomes.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))

