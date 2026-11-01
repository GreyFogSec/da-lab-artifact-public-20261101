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
const {StringValue} = await import(
  fromArtifact('lib/generated/index.js')
)

const crcTable = Array.from({length: 256}, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return c >>> 0
})
const crc32 = buffer => {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

const makeZip = dataText => {
  const name = Buffer.from('protected.txt')
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

const runSuffix = process.env.GITHUB_RUN_ID || String(Date.now())
const candidates = [
  {id: 'exact-dotdot', name: '..'},
  {id: 'dotdot-space', name: '.. '},
  {id: 'dotdot-two-spaces', name: '..  '},
  {id: 'dotdot-dot-space', name: '.. . '},
  {id: 'leading-space-dotdot', name: ' ..'},
  {id: 'slash-parent', name: `../escape-${runSuffix}`},
  {id: 'backslash-parent', name: `..\\escape-${runSuffix}`},
  {id: 'encoded-dotdot', name: `%2e%2e-${runSuffix}`},
  {id: 'fullwidth-dots', name: `．．-${runSuffix}`},
  {id: 'safe-a', name: `safe-a-${runSuffix}`},
  {id: 'safe-b', name: `safe-b-${runSuffix}`}
]

const backendIds = getBackendIdsFromToken()
const client = internalArtifactTwirpClient({
  maxAttempts: 1,
  retryIntervalMs: 1
})
const results = []

for (const candidate of candidates) {
  const record = {
    id: candidate.id,
    nameCodePoints: Array.from(candidate.name).map(character =>
      character.codePointAt(0).toString(16)
    ),
    accepted: false,
    finalized: false
  }

  try {
    const create = await client.CreateArtifact({
      workflowRunBackendId: backendIds.workflowRunBackendId,
      workflowJobRunBackendId: backendIds.workflowJobRunBackendId,
      name: candidate.name,
      mimeType: StringValue.create({value: 'application/zip'}),
      version: 7
    })
    record.createOk = create.ok
    if (!create.ok) {
      results.push(record)
      continue
    }
    record.accepted = true

    const zip = makeZip(`payload-${candidate.id}`)
    const upload = await uploadToBlobStorage(
      create.signedUploadUrl,
      Readable.from([zip]),
      'application/zip'
    )
    const finalizeRequest = {
      workflowRunBackendId: backendIds.workflowRunBackendId,
      workflowJobRunBackendId: backendIds.workflowJobRunBackendId,
      name: candidate.name,
      size: String(upload.uploadSize || zip.length)
    }
    if (upload.sha256Hash) {
      finalizeRequest.hash = StringValue.create({
        value: `sha256:${upload.sha256Hash}`
      })
    }
    const finalized = await client.FinalizeArtifact(finalizeRequest)
    record.finalizeOk = finalized.ok
    record.finalized = finalized.ok
    record.artifactId = finalized.artifactId
  } catch (error) {
    record.error = String(error.message)
      .replace(/https?:\/\/[^ ]+/g, '[url]')
      .slice(0, 500)
  }
  results.push(record)
}

const report = {
  runtime: process.version,
  platform: process.platform,
  runId: runSuffix,
  candidates: results
}
await fs.mkdir('probe-results', {recursive: true})
await fs.writeFile(
  'probe-results/server-name-validation.json',
  JSON.stringify(report, null, 2)
)
console.log(JSON.stringify(report, null, 2))

