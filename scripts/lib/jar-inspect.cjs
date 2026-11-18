'use strict'

/**
 * JAR 结构/版本检查（打包门禁与资源准备共用）。
 *
 * 为什么不用“扫描文件头文本”：Spring Boot fat jar 的 `META-INF/MANIFEST.MF`
 * 和其它条目一样是 **DEFLATE 压缩**的，直接对前 512KB 做正则匹配会漏掉
 * `Implementation-Version`（实测旧实现返回空）。这里按 ZIP 中央目录读取指定条目
 * 并用 zlib 解压，因此 pack-manifest 能记录真实版本（如 1.4.0-fix）。
 *
 * 不依赖第三方包；不 require electron。
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const zlib = require('node:zlib')

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50

/** 解析 ZIP 中央目录，返回 [{name, method, csize, localHeaderOffset}]；失败返回 null。 */
function listZipEntries(buffer) {
  try {
    const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    if (eocd < 0) return null
    const total = buffer.readUInt16LE(eocd + 10)
    const centralOffset = buffer.readUInt32LE(eocd + 16)
    const entries = []
    let pointer = centralOffset
    for (let index = 0; index < total; index += 1) {
      if (buffer.readUInt32LE(pointer) !== CENTRAL_SIG) return null
      const method = buffer.readUInt16LE(pointer + 10)
      const compressedSize = buffer.readUInt32LE(pointer + 20)
      const nameLength = buffer.readUInt16LE(pointer + 28)
      const extraLength = buffer.readUInt16LE(pointer + 30)
      const commentLength = buffer.readUInt16LE(pointer + 32)
      const localHeaderOffset = buffer.readUInt32LE(pointer + 42)
      const name = buffer.slice(pointer + 46, pointer + 46 + nameLength).toString('utf8')
      entries.push({ name, method, csize: compressedSize, localHeaderOffset })
      pointer += 46 + nameLength + extraLength + commentLength
    }
    return entries
  } catch (_) {
    return null
  }
}

/** 读取 ZIP 内单个条目（支持 stored/deflate）。 */
function readZipEntry(buffer, entries, name) {
  const entry = entries.find((item) => item.name === name)
  if (!entry) return null
  try {
    const nameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26)
    const extraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28)
    const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength
    const data = buffer.slice(dataStart, dataStart + entry.csize)
    if (entry.method === 0) return data
    if (entry.method === 8) return zlib.inflateRawSync(data)
    return null
  } catch (_) {
    return null
  }
}

function parseManifest(text) {
  const out = {}
  const lines = String(text || '').split(/\r?\n/)
  for (const line of lines) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (match) out[match[1].toLowerCase()] = match[2].trim()
  }
  return out
}

function parseProperties(text) {
  const out = {}
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    out[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim()
  }
  return out
}

/**
 * @param {string} jarPath
 * @returns {{
 *   path: string, bytes: number, sha256: string, zipValid: boolean, error?: string,
 *   version: string, manifestVersion: string, implementationVersion: string,
 *   springBootVersion: string, gitRevision: string, buildTime: string,
 *   startClass: string, mainClass: string, buildJdkSpec: string, createdBy: string,
 *   entryCount: number
 * }}
 */
function readJarInfo(jarPath) {
  const info = {
    path: jarPath,
    bytes: 0,
    sha256: '',
    zipValid: false,
    version: '',
    manifestVersion: '',
    implementationVersion: '',
    springBootVersion: '',
    gitRevision: '',
    buildTime: '',
    startClass: '',
    mainClass: '',
    buildJdkSpec: '',
    createdBy: '',
    entryCount: 0
  }
  try {
    const buffer = fs.readFileSync(jarPath)
    info.bytes = buffer.length
    info.sha256 = crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase()
    info.zipValid = buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04
    if (!info.zipValid) return info
    const entries = listZipEntries(buffer)
    if (!entries) return info
    info.entryCount = entries.length
    const manifestEntry = readZipEntry(buffer, entries, 'META-INF/MANIFEST.MF')
    const manifest = parseManifest(manifestEntry ? manifestEntry.toString('utf8') : '')
    info.implementationVersion = manifest['implementation-version'] || ''
    info.springBootVersion = manifest['spring-boot-version'] || ''
    info.startClass = manifest['start-class'] || ''
    info.mainClass = manifest['main-class'] || ''
    info.buildJdkSpec = manifest['build-jdk-spec'] || ''
    info.createdBy = manifest['created-by'] || ''
    const buildInfoEntry =
      readZipEntry(buffer, entries, 'BOOT-INF/classes/build-info.properties') ||
      readZipEntry(buffer, entries, 'META-INF/build-info.properties')
    const buildInfo = parseProperties(buildInfoEntry ? buildInfoEntry.toString('utf8') : '')
    info.gitRevision = buildInfo['git.revision'] || ''
    info.buildTime = buildInfo['build.time'] || ''
    info.version = buildInfo.version || info.implementationVersion || ''
    info.manifestVersion = info.version || info.springBootVersion
    return info
  } catch (error) {
    info.error = String((error && error.message) || error)
    return info
  }
}

module.exports = {
  readJarInfo,
  listZipEntries,
  readZipEntry,
  parseManifest,
  parseProperties
}
