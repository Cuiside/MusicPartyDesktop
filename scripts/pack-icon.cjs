'use strict'

/**
 * 生成打包用应用图标（纯本机生成，不依赖网络）。
 *
 *   build/icon.png  512×512 网页原版 MusicParty 图标（透明背景）
 *   build/icon.ico  16/24/32/48/64/128/256 多尺寸（PNG 压缩条目，Vista+ 支持）
 *
 * 绘制交给 Windows 自带的 System.Drawing（GDI+），本脚本负责尺寸/ICO 容器/
 * 校验；这样避免引入 sharp/canvas 之类的原生依赖。
 *
 * 用法：node scripts/pack-icon.cjs [--no-ico]
 */

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const BUILD_DIR = path.join(ROOT, 'build')
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256]
const MASTER_SIZE = 512
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** PNG 的 IHDR 宽高（偏移固定：8 字节签名 + 4 长度 + 4 'IHDR'） */
function readPngSize(buffer) {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/** 把若干 PNG（每项对应一个尺寸）拼成 ICO 容器。 */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)

  const directory = Buffer.alloc(16 * entries.length)
  let offset = 6 + 16 * entries.length
  entries.forEach(({ size, data }, index) => {
    const at = index * 16
    // ICO 目录里 256 用 0 表示
    directory.writeUInt8(size >= 256 ? 0 : size, at)
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1)
    directory.writeUInt8(0, at + 2) // 调色板颜色数
    directory.writeUInt8(0, at + 3) // reserved
    directory.writeUInt16LE(1, at + 4) // color planes
    directory.writeUInt16LE(32, at + 6) // bits per pixel
    directory.writeUInt32LE(data.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += data.length
  })

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.data)])
}

function renderIcons(tempDir) {
  const source = path.join(ROOT, 'public', 'musicparty-logo.png')
  if (!fs.existsSync(source)) throw new Error('Missing original logo')
  const quote = s => s.replace(/'/g, "''")
  const lines = [
    "$ErrorActionPreference='Stop'", 'Add-Type -AssemblyName System.Drawing',
    "$src=[System.Drawing.Image]::FromFile('" + quote(source) + "')",
    'foreach($size in @(512,16,24,32,48,64,128,256)) {',
    '$bmp=New-Object System.Drawing.Bitmap([int]$size,[int]$size,([System.Drawing.Imaging.PixelFormat]::Format32bppArgb))',
    '$g=[System.Drawing.Graphics]::FromImage($bmp)',
    '$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    '$g.Clear([System.Drawing.Color]::Transparent)', '$g.DrawImage($src,0,0,[int]$size,[int]$size)',
    '$g.Dispose()',
    "$bmp.Save((Join-Path '" + quote(tempDir) + "' ('icon-'+$size+'.png')),[System.Drawing.Imaging.ImageFormat]::Png)",
    '$bmp.Dispose()', '}', '$src.Dispose()'
  ]
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(lines.join('\n'), 'utf16le').toString('base64')], { cwd: ROOT, encoding: 'utf8', timeout: 180000, windowsHide: true })

}

function main() {
  const wantIco = !process.argv.includes('--no-ico')
  fs.mkdirSync(BUILD_DIR, { recursive: true })
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-icon-'))
  try {
    renderIcons(tempDir)

    const masterPath = path.join(tempDir, `icon-${MASTER_SIZE}.png`)
    const master = fs.readFileSync(masterPath)
    const masterSize = readPngSize(master)
    if (!masterSize || masterSize.width !== MASTER_SIZE || masterSize.height !== MASTER_SIZE) {
      throw new Error(`icon.png 尺寸异常：${JSON.stringify(masterSize)}`)
    }
    fs.writeFileSync(path.join(BUILD_DIR, 'icon.png'), master)

    if (wantIco) {
      const entries = PNG_SIZES.map((size) => {
        const data = fs.readFileSync(path.join(tempDir, `icon-${size}.png`))
        const dim = readPngSize(data)
        if (!dim || dim.width !== size || dim.height !== size) {
          throw new Error(`icon-${size}.png 尺寸异常：${JSON.stringify(dim)}`)
        }
        return { size, data }
      })
      const ico = buildIco(entries)
      fs.writeFileSync(path.join(BUILD_DIR, 'icon.ico'), ico)
      console.log(
        `[icon] build/icon.ico ${ico.length} B (${entries.map((e) => e.size).join('/')}), build/icon.png ${master.length} B (${MASTER_SIZE}x${MASTER_SIZE})`
      )
    } else {
      console.log(`[icon] build/icon.png ${master.length} B (${MASTER_SIZE}x${MASTER_SIZE})`)
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(`[icon] failed: ${error?.stack || error}`)
    process.exit(1)
  }
}

module.exports = { buildIco, readPngSize }
