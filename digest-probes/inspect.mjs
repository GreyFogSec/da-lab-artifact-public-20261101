import crypto from 'node:crypto'
import fs from 'node:fs/promises'

const cases = ['valid', 'missing', 'wrong', 'malformed']
const outcomes = {
  valid: process.env.OUTCOME_VALID,
  missing: process.env.OUTCOME_MISSING,
  wrong: process.env.OUTCOME_WRONG,
  malformed: process.env.OUTCOME_MALFORMED
}
const results = []
for (const id of cases) {
  const file = `digest-sandbox/${id}/${id}.txt`
  try {
    const data = await fs.readFile(file)
    results.push({
      id,
      outcome: outcomes[id],
      fileExists: true,
      size: data.length,
      sha256: crypto.createHash('sha256').update(data).digest('hex')
    })
  } catch (error) {
    results.push({id, outcome: outcomes[id], fileExists: false, error: error.code})
  }
}
const report = {runtime: process.version, platform: process.platform, results}
await fs.mkdir('digest-results', {recursive: true})
await fs.writeFile('digest-results/download-outcomes.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))

