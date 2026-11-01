import fs from 'node:fs/promises'
import {Readable} from 'node:stream'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

const fromArtifact = relative =>
  pathToFileURL(path.resolve('node_modules/@actions/artifact', relative)).href
const {internalArtifactTwirpClient} = await import(
  fromArtifact('lib/internal/shared/artifact-twirp-client.js')
)
const {getBackendIdsFromToken} = await import(
  fromArtifact('lib/internal/shared/util.js')
)
const {uploadToBlobStorage} = await import(
  fromArtifact('lib/internal/upload/blob-upload.js')
)
const {StringValue} = await import(fromArtifact('lib/generated/index.js'))

const crcTable = Array.from({length: 256}, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = buffer => {
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
const makeZip = (fileName, dataText) => {
  const name = Buffer.from(fileName)
  const data = Buffer.from(dataText)
  const checksum = crc32(data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0800, 6)
  local.writeUInt32LE(checksum, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(0x0314, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x0800, 8)
  central.writeUInt32LE(checksum, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + name.length, 12)
  end.writeUInt32LE(local.length + name.length + data.length, 16)
  return Buffer.concat([local, name, data, central, name, end])
}

const runId = process.env.GITHUB_RUN_ID
const cases = [
  {id: 'valid', hashMode: 'valid'},
  {id: 'missing', hashMode: 'missing'},
  {id: 'wrong', hashMode: 'wrong'},
  {id: 'malformed', hashMode: 'malformed'}
]
const backend = getBackendIdsFromToken()
const client = internalArtifactTwirpClient({maxAttempts: 1, retryIntervalMs: 1})
const results = []

for (const item of cases) {
  const name = `digest-${item.id}-${runId}`
  const zip = makeZip(`${item.id}.txt`, `digest-payload-${item.id}`)
  const record = {id: item.id, name, hashMode: item.hashMode, finalized: false}
  try {
    const created = await client.CreateArtifact({
      workflowRunBackendId: backend.workflowRunBackendId,
      workflowJobRunBackendId: backend.workflowJobRunBackendId,
      name,
      mimeType: StringValue.create({value: 'application/zip'}),
      version: 7
    })
    record.createOk = created.ok
    const upload = await uploadToBlobStorage(
      created.signedUploadUrl,
      Readable.from([zip]),
      'application/zip'
    )
    const finalize = {
      workflowRunBackendId: backend.workflowRunBackendId,
      workflowJobRunBackendId: backend.workflowJobRunBackendId,
      name,
      size: String(upload.uploadSize || zip.length)
    }
    if (item.hashMode === 'valid') {
      finalize.hash = StringValue.create({value: `sha256:${upload.sha256Hash}`})
    } else if (item.hashMode === 'wrong') {
      finalize.hash = StringValue.create({value: `sha256:${'0'.repeat(64)}`})
    } else if (item.hashMode === 'malformed') {
      finalize.hash = StringValue.create({value: 'sha256:not-a-valid-digest'})
    }
    const response = await client.FinalizeArtifact(finalize)
    record.finalizeOk = response.ok
    record.finalized = response.ok
    record.artifactId = response.artifactId
    record.actualDigest = `sha256:${upload.sha256Hash}`
  } catch (error) {
    record.error = String(error.message).replace(/https?:\/\/[^ ]+/g, '[url]').slice(0, 500)
  }
  results.push(record)
}

const report = {runtime: process.version, platform: process.platform, runId, cases: results}
await fs.mkdir('digest-results', {recursive: true})
await fs.writeFile('digest-results/service-validation.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))

