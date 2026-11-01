import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

const modulePath = path.resolve(
  'node_modules/@actions/artifact/lib/internal/download/download-artifact.js'
)
const {streamExtractExternal} = await import(pathToFileURL(modulePath).href)

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

const makeZip = (entryName, dataText) => {
  const name = Buffer.from(entryName, 'utf8')
  const data = Buffer.from(dataText)
  const checksum = crc32(data)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0800, 6)
  local.writeUInt16LE(0, 8)
  local.writeUInt32LE(0, 10)
  local.writeUInt32LE(checksum, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(name.length, 26)
  local.writeUInt16LE(0, 28)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(0x0314, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x0800, 8)
  central.writeUInt16LE(0, 10)
  central.writeUInt32LE(0, 12)
  central.writeUInt32LE(checksum, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
  central.writeUInt32LE(0, 42)

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + name.length, 12)
  end.writeUInt32LE(local.length + name.length + data.length, 16)

  return Buffer.concat([local, name, data, central, name, end])
}

let body = Buffer.alloc(0)
const server = http.createServer((request, response) => {
  response.writeHead(200, {
    'content-type': 'application/zip',
    'content-length': String(body.length)
  })
  response.end(body)
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') {
  throw new Error('local server did not bind')
}
const url = `http://127.0.0.1:${address.port}/artifact.zip`

const cases = [
  {id: 'parent-control-forward', segment: '..'},
  {id: 'parent-control-backslash', segment: '..\\'},
  {id: 'two-dots-space', segment: '.. '},
  {id: 'two-dots-dot', segment: '...'},
  {id: 'two-dots-dot-space', segment: '.. . '},
  {id: 'two-dots-two-spaces', segment: '..  '},
  {id: 'two-dots-nbsp', segment: '..\u00a0'},
  {id: 'dot-space-dot', segment: '. .'},
  {id: 'four-dots-space', segment: '.... '}
]

const results = []
for (const testCase of cases) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'da-win-path-'))
  const output = path.join(root, 'out')
  const protectedPath = path.join(root, 'protected.txt')
  await fs.mkdir(output)
  await fs.writeFile(protectedPath, 'sentinel')

  const payload = `payload-${testCase.id}`
  body = makeZip(`${testCase.segment}/protected.txt`, payload)

  let error = null
  try {
    await streamExtractExternal(url, output, {timeout: 3000})
  } catch (caught) {
    error = caught.message
  }

  const protectedValue = await fs.readFile(protectedPath, 'utf8')
  results.push({
    id: testCase.id,
    segmentCodePoints: Array.from(testCase.segment).map(character =>
      character.codePointAt(0).toString(16)
    ),
    error,
    outsideModified: protectedValue !== 'sentinel',
    outsideValue:
      protectedValue === 'sentinel' ? null : protectedValue
  })

  try {
    await fs.rm(root, {recursive: true, force: true})
  } catch (caught) {
    results[results.length - 1].cleanupError = caught.message
  }
}

server.close()

const report = {
  runtime: process.version,
  platform: process.platform,
  arch: process.arch,
  artifactClient: '6.3.1',
  unzipStream: '0.3.4',
  results
}
await fs.mkdir('probe-results', {recursive: true})
await fs.writeFile(
  `probe-results/path-normalization-${process.platform}.json`,
  JSON.stringify(report, null, 2)
)
console.log(JSON.stringify(report, null, 2))

if (results.some(result => result.outsideModified)) {
  process.exitCode = 2
}

