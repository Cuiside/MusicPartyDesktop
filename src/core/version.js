/**
 * 集中管理桌面应用的展示版本号（单一来源）。
 *
 * 版本真值来自 `package.json` 的 `version` 字段，由 Vite 在构建时内联（JSON import），
 * 因此打包产物里不会再有和 package.json 不一致的硬编码。运行时如果 Electron preload
 * 暴露了 `window.mpDesktop.app.info()`（主进程 `app.getVersion()`），优先用它——
 * 这样开发入口/打包入口/安装包显示同一个版本，且升级 package.json 后无需改 UI。
 *
 * 本模块不依赖 electron/ 改动：preload 已有 `mpDesktop.app.info()`。
 *
 * @module core/version
 */

import packageJson from '../../package.json'

/**
 * 构建时版本（来自 package.json，单一来源）。package.json 缺失/异常时退化为 '0.0.0'，
 * UI 会显示未知版本而不是旧版本号。
 * @type {string}
 */
export const APP_VERSION =
  packageJson && typeof packageJson.version === 'string' && packageJson.version.trim()
    ? packageJson.version.trim()
    : '0.0.0'

/** 桌面产品名（与 electron-builder `productName` 保持一致，单一来源避免多处硬编码）。 */
export const APP_PRODUCT_NAME =
  packageJson && typeof packageJson.build?.productName === 'string' && packageJson.build.productName
    ? packageJson.build.productName
    : 'Music Party'

/** 构建所用 Electron 版本（来自 package.json devDependencies，去掉 ^/~ 前缀）。 */
export const ELECTRON_VERSION =
  typeof packageJson?.devDependencies?.electron === 'string'
    ? packageJson.devDependencies.electron.replace(/^[^0-9]*/, '').trim()
    : '—'

/**
 * 解析运行时版本：优先 Electron preload 的 `app.getVersion()`，回退构建时 package.json 版本。
 * 永不抛错（浏览器预览 / preload 未就绪时直接回退）。
 *
 * @returns {Promise<string>}
 */
export async function resolveAppVersion() {
  try {
    const info = await window?.mpDesktop?.app?.info?.()
    if (info && typeof info.version === 'string' && info.version.trim()) return info.version.trim()
  } catch {
    /* preload 未就绪或非 Electron 环境：使用构建时版本 */
  }
  return APP_VERSION
}
