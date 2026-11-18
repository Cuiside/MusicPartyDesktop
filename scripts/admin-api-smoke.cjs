'use strict'

/**
 * MusicParty 桌面端管理员配置 API 冒烟测试（纯 Node，不启动 Electron / 后端）。
 *
 *   node scripts/admin-api-smoke.cjs
 *
 * 做法：
 * 1. 先 mock `globalThis.localStorage`（config.js 读取服务器地址）；
 * 2. mock `globalThis.window.mpDesktop.http.request` 模拟 Electron HTTP 桥；
 * 3. 动态 import `src/core/live/admin.js`，逐方法断言 URL / method / headers / body；
 * 4. 覆盖错误归一化：403、桥接网络错误、服务端业务 message、HTTP 500、HTML 回退；
 * 5. 覆盖无桥时的 fetch 回退路径（成功 / 403 / 网络失败）；
 * 6. 覆盖密码只在内存、logout 清理、自定义服务器地址。
 *
 * 全部通过输出 PASS 并以 0 退出；否则打印失败明细并以 1 退出。
 */

const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.resolve(__dirname, '..')
const ADMIN_MODULE = path.join(ROOT, 'src', 'core', 'live', 'admin.js')
const CONFIG_MODULE = path.join(ROOT, 'src', 'core', 'live', 'config.js')

let passed = 0
let failed = 0
const failures = []

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

function expectEqual(actual, expected, message) {
  const actualText = JSON.stringify(actual)
  const expectedText = JSON.stringify(expected)
  if (actualText !== expectedText) {
    throw new Error(`${message}\n      期望: ${expectedText}\n      实际: ${actualText}`)
  }
}

async function check(name, task) {
  try {
    await task()
    passed += 1
    console.log(`PASS  ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, message: String(error && error.message ? error.message : error) })
    console.log(`FAIL  ${name}\n      ${String(error && error.message ? error.message : error)}`)
  }
}

/* ------------------------------------------------------------------ */
/* 全局 mock                                                           */
/* ------------------------------------------------------------------ */

// localStorage：config.js 用它持久化服务器地址；这里用内存 Map 代替。
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
  key: (index) => [...storage.keys()][index] ?? null,
  get length() {
    return storage.size
  }
}

// Electron HTTP 桥 mock：每次请求记录参数，响应由 `responder` 决定。
const bridgeCalls = []
let responder = () => ({
  ok: true,
  status: 200,
  bodyText: JSON.stringify({ message: 'OK' }),
  contentType: 'application/json'
})

globalThis.window = {
  mpDesktop: {
    http: {
      request: async (options) => {
        bridgeCalls.push(options)
        return responder(options)
      }
    }
  }
}

function jsonBridge(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    bodyText: payload === undefined ? '' : JSON.stringify(payload),
    contentType: 'application/json'
  }
}

function setResponder(next) {
  responder = next
}

function resetBridge() {
  bridgeCalls.length = 0
}

function lastBridgeCall() {
  const call = bridgeCalls[bridgeCalls.length - 1]
  if (!call) throw new Error('没有捕获到 HTTP 桥请求')
  return call
}

function bridgeBody(call) {
  return call.body === undefined ? undefined : JSON.parse(call.body)
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const admin = await import(pathToFileURL(ADMIN_MODULE).href)
  const config = await import(pathToFileURL(CONFIG_MODULE).href)

  const PASSWORD = 'test-admin-password'

  /** 断言成功响应后重新登录管理员，保证后续请求带会话密码。 */
  async function login() {
    setResponder(() => jsonBridge(200, { message: 'VERIFIED' }))
    const ok = await admin.verifyAdmin(PASSWORD)
    if (!ok) throw new Error('测试前置失败：管理员登录未成功')
  }

  /* ---------- 1. 管理员密码验证 ---------- */

  await check('verifyAdmin 成功：URL/method/timeout/headers/body 正确，密码仅保存在内存', async () => {
    admin.adminLogout()
    resetBridge()
    setResponder(() => jsonBridge(200, { message: 'VERIFIED' }))

    const ok = await admin.verifyAdmin(PASSWORD)
    expect(ok === true, 'verifyAdmin 应返回 true')
    expect(admin.adminAuth.verified === true, 'adminAuth.verified 应为 true')
    expect(admin.adminAuth.password === PASSWORD, '密码应保存在 adminAuth 内存中')
    expect(admin.adminAuth.error === '', '成功后 adminAuth.error 应为空')
    expect(
      admin.adminAuth.authenticatedServerBase === 'http://127.0.0.1:8080',
      `认证结果应绑定到验证时的服务器 base（实际 ${admin.adminAuth.authenticatedServerBase}）`
    )

    const persisted = [...storage.values()].join('|')
    expect(!persisted.includes(PASSWORD), '密码不得写入 localStorage')

    const call = lastBridgeCall()
    expectEqual(call.url, 'http://127.0.0.1:8080/api/admin/verify', '验证 URL 错误')
    expectEqual(call.method, 'POST', '验证 method 错误')
    expectEqual(call.timeout, 12000, '验证 timeout 错误')
    expectEqual(call.headers.Accept, 'application/json', 'Accept 头错误')
    expectEqual(call.headers['Content-Type'], 'application/json', 'Content-Type 头错误')
    expectEqual(call.headers['X-Admin-Password'], PASSWORD, 'X-Admin-Password 头错误')
    expectEqual(bridgeBody(call), { password: PASSWORD }, '验证 body 错误')
  })

  await check('verifyAdmin 失败（403）：映射为「管理员密码错误」且清空会话', async () => {
    admin.adminLogout()
    resetBridge()
    setResponder(() => jsonBridge(403, { message: 'ACCESS DENIED' }))

    const ok = await admin.verifyAdmin('wrong-password')
    expect(ok === false, '错误密码应返回 false')
    expect(admin.adminAuth.verified === false, '错误密码后 verified 应为 false')
    expect(admin.adminAuth.password === '', '错误密码不得保留在内存')
    expectEqual(admin.adminAuth.error, '管理员密码错误', '403 错误文案错误')
    expectEqual(lastBridgeCall().headers['X-Admin-Password'], 'wrong-password', '验证时也应携带候选密码头')
  })

  await check('verifyAdmin 网络失败：映射为「无法连接服务器（地址/网络）」', async () => {
    admin.adminLogout()
    resetBridge()
    setResponder(() => ({ ok: false, status: 0, error: 'connect ECONNREFUSED 127.0.0.1:8080' }))

    const ok = await admin.verifyAdmin('whatever')
    expect(ok === false, '网络失败应返回 false')
    expectEqual(admin.adminAuth.error, '无法连接服务器（地址/网络）', '网络错误文案错误')
  })

  await check('verifyAdmin 空密码：本地拦截，不发请求', async () => {
    admin.adminLogout()
    resetBridge()
    const ok = await admin.verifyAdmin('')
    expect(ok === false, '空密码应返回 false')
    expectEqual(bridgeCalls.length, 0, '空密码不应发送 HTTP 请求')
    expectEqual(admin.adminAuth.error, '请输入管理员密码', '空密码提示错误')
  })

  /* ---------- 2. 平台凭据 ---------- */

  await login()

  await check('setPlatformCookie 网易云：URL/body/X-Admin-Password 正确，换行归一化', async () => {
    resetBridge()
    setResponder(() => jsonBridge(200, { message: '网易云音乐凭据已更新' }))
    const result = await admin.setPlatformCookie('netease', 'MUSIC_U=example-value;\n  __csrf=example-csrf;')
    const call = lastBridgeCall()
    expectEqual(call.url, 'http://127.0.0.1:8080/api/admin/config/cookie', 'Cookie URL 错误')
    expectEqual(call.method, 'POST', 'Cookie method 错误')
    expectEqual(call.headers['X-Admin-Password'], PASSWORD, '会话密码未带入 Cookie 请求')
    expectEqual(
      bridgeBody(call),
      { platform: 'netease', value: 'MUSIC_U=example-value; __csrf=example-csrf;' },
      'Cookie body 错误'
    )
    expectEqual(result.message, '网易云音乐凭据已更新', '应返回服务端 message')
  })

  await check('setPlatformCookie B 站：body 为 { platform: "bilibili", value }', async () => {
    resetBridge()
    setResponder(() => jsonBridge(200, { message: 'Bilibili Cookie 已更新' }))
    await admin.setPlatformCookie('bilibili', 'SESSDATA=example-session; buvid3=example-device')
    const call = lastBridgeCall()
    expectEqual(call.url, 'http://127.0.0.1:8080/api/admin/config/cookie', 'B 站 Cookie URL 错误')
    expectEqual(
      bridgeBody(call),
      { platform: 'bilibili', value: 'SESSDATA=example-session; buvid3=example-device' },
      'B 站 Cookie body 错误'
    )
  })

  await check('setPlatformCookie 非法参数：本地抛错（空值 / 未知平台）', async () => {
    let emptyError = ''
    try {
      await admin.setPlatformCookie('netease', '   ')
    } catch (error) {
      emptyError = String(error.message)
    }
    expectEqual(emptyError, '凭据不能为空', '空凭据应本地拦截')

    let platformError = ''
    try {
      await admin.setPlatformCookie('unknown-source', 'x')
    } catch (error) {
      platformError = String(error.message)
    }
    expect(platformError.includes('不支持'), `未知平台应本地拦截，实际：${platformError}`)
  })

  /* ---------- 3. 系统参数 ---------- */

  await check('updateAdminConfig：只提交传入字段，保持 maxSize/historySize 原样', async () => {
    resetBridge()
    setResponder(() => jsonBridge(200, { message: '系统配置已刷新' }))
    const patch = {
      maxSize: 500,
      historySize: 40,
      maxUserSongs: 20,
      voteSkipEnabled: true,
      voteSkipThreshold: 0.6,
      voteSkipWaitTime: 30
    }
    await admin.updateAdminConfig(patch)
    const call = lastBridgeCall()
    expectEqual(call.url, 'http://127.0.0.1:8080/api/admin/config/update', '配置更新 URL 错误')
    expectEqual(call.headers['X-Admin-Password'], PASSWORD, '配置更新缺少管理员密码头')
    expectEqual(bridgeBody(call), patch, '配置更新应只提交传入的字段')
  })

  await check('updateAdminConfig 空 patch：本地拦截，不发请求', async () => {
    resetBridge()
    let message = ''
    try {
      await admin.updateAdminConfig({})
    } catch (error) {
      message = String(error.message)
    }
    expectEqual(message, '没有需要保存的配置改动', '空配置应本地拦截')
    expectEqual(bridgeCalls.length, 0, '空配置不应发送请求')
  })

  /* ---------- 4. 锁定 / 播放控制 ---------- */

  await check('setLock：type 大写归一化，body 为 { type, locked }', async () => {
    resetBridge()
    setResponder(() => jsonBridge(200, { message: '已开启全频道操作锁定' }))
    await admin.setLock('all', true)
    const call = lastBridgeCall()
    expectEqual(call.url, 'http://127.0.0.1:8080/api/admin/lock', '锁定 URL 错误')
    expectEqual(bridgeBody(call), { type: 'ALL', locked: true }, '锁定 body 错误')

    resetBridge()
    await admin.setLock('PAUSE', false)
    expectEqual(bridgeBody(lastBridgeCall()), { type: 'PAUSE', locked: false }, '解锁 body 错误')
  })

  await check('setLock 非法类型：本地抛错', async () => {
    let message = ''
    try {
      await admin.setLock('volume', true)
    } catch (error) {
      message = String(error.message)
    }
    expect(message.includes('PAUSE/SKIP/SHUFFLE/ALL'), `非法锁定类型应被拦截，实际：${message}`)
  })

  await check('playerAction：五个服务端 action 均可发送，body 为 { action }', async () => {
    for (const action of admin.PLAYER_ACTIONS) {
      resetBridge()
      setResponder(() => jsonBridge(200, { message: 'ok' }))
      await admin.playerAction(action)
      const call = lastBridgeCall()
      expectEqual(call.url, 'http://127.0.0.1:8080/api/admin/player/action', `${action} URL 错误`)
      expectEqual(bridgeBody(call), { action }, `${action} body 错误`)
    }
  })

  await check('playerAction 非法指令：本地抛错', async () => {
    let message = ''
    try {
      await admin.playerAction('REWIND')
    } catch (error) {
      message = String(error.message)
    }
    expect(message.includes('不支持的播放指令'), `非法播放指令应被拦截，实际：${message}`)
  })

  /* ---------- 5. 房间环境 / 重置 / 推流 ---------- */

  await check('setRoomPassword：空字符串表示公开房间，body 为 { password: "" }', async () => {
    resetBridge()
    setResponder(() => jsonBridge(200, { message: '房间已设为公开访问' }))
    await admin.setRoomPassword('')
    const call = lastBridgeCall()
    expectEqual(call.url, 'http://127.0.0.1:8080/api/admin/room/password', '房间密码 URL 错误')
    expectEqual(bridgeBody(call), { password: '' }, '房间密码 body 错误')

    resetBridge()
    await admin.setRoomPassword('party-2026')
    expectEqual(bridgeBody(lastBridgeCall()), { password: 'party-2026' }, '设置密码 body 错误')
  })

  await check('clearAdminData：QUEUE/CHAT/OFFLINE 大写归一化', async () => {
    resetBridge()
    setResponder(() => jsonBridge(200, { message: '已清理 2 首离线成员的点播歌曲' }))
    await admin.clearAdminData('offline')
    const call = lastBridgeCall()
    expectEqual(call.url, 'http://127.0.0.1:8080/api/admin/room/clear', '清理 URL 错误')
    expectEqual(bridgeBody(call), { target: 'OFFLINE' }, '清理 body 错误')
  })

  await check('clearAdminData 非法目标：本地抛错', async () => {
    let message = ''
    try {
      await admin.clearAdminData('USERS')
    } catch (error) {
      message = String(error.message)
    }
    expect(message.includes('QUEUE/CHAT/OFFLINE'), `非法清理目标应被拦截，实际：${message}`)
  })

  await check('resetSystem：POST /api/admin/system/reset，body 为 {}', async () => {
    resetBridge()
    setResponder(() => jsonBridge(200, { message: '系统核心已完成全量重置并重启' }))
    const result = await admin.resetSystem()
    const call = lastBridgeCall()
    expectEqual(call.url, 'http://127.0.0.1:8080/api/admin/system/reset', '系统重置 URL 错误')
    expectEqual(call.method, 'POST', '系统重置 method 错误')
    expectEqual(bridgeBody(call), {}, '系统重置 body 应为空对象')
    expectEqual(result.message, '系统核心已完成全量重置并重启', '系统重置应返回服务端 message')
  })

  await check('setStream：body 为 { enabled }', async () => {
    resetBridge()
    setResponder(() => jsonBridge(200, { message: '直播流同步服务已启动' }))
    await admin.setStream(true)
    const call = lastBridgeCall()
    expectEqual(call.url, 'http://127.0.0.1:8080/api/admin/room/stream', '推流 URL 错误')
    expectEqual(bridgeBody(call), { enabled: true }, '推流 body 错误')
  })

  /* ---------- 6. 私人电台 / 私人 DJ ---------- */

  await check('updatePrivateDj：mode 大写归一化，单字段 patch 原样提交', async () => {
    resetBridge()
    setResponder(() => jsonBridge(200, { message: '私人电台/私人DJ 配置已更新' }))
    await admin.updatePrivateDj({ mode: 'fm' })
    expectEqual(lastBridgeCall().url, 'http://127.0.0.1:8080/api/admin/private-dj', '私人电台 URL 错误')
    expectEqual(bridgeBody(lastBridgeCall()), { mode: 'FM' }, 'mode patch 错误')

    resetBridge()
    await admin.updatePrivateDj({ fillBlankEnabled: true })
    expectEqual(bridgeBody(lastBridgeCall()), { fillBlankEnabled: true }, '单字段 patch 错误')
  })

  await check('updatePrivateDj 非法参数：本地抛错（字段 / 模式）', async () => {
    let fieldMessage = ''
    try {
      await admin.updatePrivateDj({ volume: 1 })
    } catch (error) {
      fieldMessage = String(error.message)
    }
    expect(fieldMessage.includes('不支持的私人电台字段'), `非法字段应被拦截，实际：${fieldMessage}`)

    let modeMessage = ''
    try {
      await admin.updatePrivateDj({ mode: 'AUTO' })
    } catch (error) {
      modeMessage = String(error.message)
    }
    expect(modeMessage.includes('OFF/FM/DJ'), `非法模式应被拦截，实际：${modeMessage}`)
  })

  await check('服务端业务错误（400 + message）：原样透出中文提示', async () => {
    resetBridge()
    setResponder(() => jsonBridge(400, { message: '需先配置网易云 Cookie 才能开启私人电台' }))
    let message = ''
    try {
      await admin.updatePrivateDj({ mode: 'FM' })
    } catch (error) {
      message = String(error.message)
    }
    expectEqual(message, '需先配置网易云 Cookie 才能开启私人电台', '服务端业务错误应原样透出')
  })

  /* ---------- 7. 错误归一化边界 ---------- */

  await check('HTTP 500 无 body：映射为「请求失败（HTTP 500）」', async () => {
    resetBridge()
    setResponder(() => ({ ok: false, status: 500, bodyText: '', contentType: '' }))
    let message = ''
    try {
      await admin.resetSystem()
    } catch (error) {
      message = String(error.message)
    }
    expectEqual(message, '请求失败（HTTP 500）', 'HTTP 500 文案错误')
  })

  await check('403 空 body（锁定等接口）：仍映射为「管理员密码错误」', async () => {
    resetBridge()
    setResponder(() => ({ ok: false, status: 403, bodyText: '', contentType: '' }))
    let message = ''
    try {
      await admin.setLock('SKIP', true)
    } catch (error) {
      message = String(error.message)
    }
    expectEqual(message, '管理员密码错误', '403 空 body 文案错误')
  })

  await check('HTML 回退响应：提示地址可能不是 MusicParty 后端', async () => {
    resetBridge()
    setResponder(() => ({
      ok: true,
      status: 200,
      bodyText: '<!doctype html><html><body>Vite</body></html>',
      contentType: 'text/html'
    }))
    let message = ''
    try {
      await admin.resetSystem()
    } catch (error) {
      message = String(error.message)
    }
    expectEqual(
      message,
      '服务器返回了 HTML（该地址可能不是 MusicParty 后端）',
      'HTML 回退文案错误'
    )
  })

  await check('桥接抛异常 / status 0：均映射为网络错误', async () => {
    resetBridge()
    setResponder(() => {
      throw new Error('boom')
    })
    let thrown = ''
    try {
      await admin.resetSystem()
    } catch (error) {
      thrown = String(error.message)
    }
    expectEqual(thrown, '无法连接服务器（地址/网络）', '桥接异常应映射网络错误')

    resetBridge()
    setResponder(() => ({ ok: false, status: 0, error: 'timeout' }))
    thrown = ''
    try {
      await admin.resetSystem()
    } catch (error) {
      thrown = String(error.message)
    }
    expectEqual(thrown, '无法连接服务器（地址/网络）', 'status 0 应映射网络错误')
  })

  /* ---------- 8. 服务器地址来自设置 ---------- */

  await check('请求 base：认证后同 base 可请求；切换 base 后本地拒绝且零外发（D-08 A→B 不泄漏）', async () => {
    const DEFAULT_SETTINGS = { serverUrl: 'http://127.0.0.1:8080', mode: 'local', userName: '' }
    await login()
    expect(
      admin.adminAuth.authenticatedServerBase === 'http://127.0.0.1:8080',
      '前置：应已绑定默认 base'
    )

    // 切换到另一个服务器地址（未重新认证）：本地拒绝，绝不把 A 的密码发给 B。
    config.saveSettings({ ...DEFAULT_SETTINGS, serverUrl: 'http://192.0.2.10:9999/' })
    resetBridge()
    setResponder(() => jsonBridge(200, { message: 'ok' }))
    let message = ''
    try {
      await admin.setStream(false)
    } catch (error) {
      message = String(error.message)
    }
    expectEqual(message, admin.ADMIN_ERROR_SERVER_CHANGED, '切换 base 后应本地拒绝')
    expectEqual(bridgeCalls.length, 0, '切换 base 后不得发出任何请求（旧密码不外发）')
    expect(admin.adminAuth.verified === false, '切换 base 后旧会话应被清除')

    // 在 B 上重新认证成功 → 同 base 请求正常，URL/密码头使用 B。
    setResponder(() => jsonBridge(200, { message: 'VERIFIED' }))
    const ok = await admin.verifyAdmin(PASSWORD, 'http://192.0.2.10:9999/')
    expect(ok === true, '在 B 上重新认证应成功')
    expect(
      admin.adminAuth.authenticatedServerBase === 'http://192.0.2.10:9999',
      `认证应绑定 B（实际 ${admin.adminAuth.authenticatedServerBase}）`
    )
    resetBridge()
    setResponder(() => jsonBridge(200, { message: 'ok' }))
    await admin.setStream(false)
    expectEqual(
      lastBridgeCall().url,
      'http://192.0.2.10:9999/api/admin/room/stream',
      '同 base 请求应使用 B 的 URL'
    )
    expectEqual(lastBridgeCall().headers['X-Admin-Password'], PASSWORD, '同 base 请求应带当前会话密码')

    config.saveSettings(DEFAULT_SETTINGS)
    admin.adminLogout()
  })

  /* ---------- 9. 无 Electron 桥时的 fetch 回退 ---------- */

  // fetch 回退仍走“已认证会话”的密码（D-08：未认证时不会外发任何请求）。
  await login()

  await check('fetch 回退：URL/headers/body 正确（无 mpDesktop 桥）', async () => {
    const originalWindow = globalThis.window
    const originalFetch = globalThis.fetch
    const fetchCalls = []
    globalThis.window = {}
    globalThis.fetch = async (url, options) => {
      fetchCalls.push({ url, options })
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ message: '系统配置已刷新' })
      }
    }
    try {
      resetBridge()
      setResponder(() => jsonBridge(200, { message: 'ok' }))
      const result = await admin.updateAdminConfig({ maxSize: 321 })
      const call = fetchCalls[fetchCalls.length - 1]
      expectEqual(call.url, 'http://127.0.0.1:8080/api/admin/config/update', 'fetch 回退 URL 错误')
      expectEqual(call.options.method, 'POST', 'fetch 回退 method 错误')
      expectEqual(call.options.headers['X-Admin-Password'], PASSWORD, 'fetch 回退密码头错误')
      expectEqual(JSON.parse(call.options.body), { maxSize: 321 }, 'fetch 回退 body 错误')
      expectEqual(result.message, '系统配置已刷新', 'fetch 回退应解析 JSON body')
    } finally {
      globalThis.window = originalWindow
      globalThis.fetch = originalFetch
    }
  })

  await check('fetch 回退：403 与网络异常同样归一化', async () => {
    const originalWindow = globalThis.window
    const originalFetch = globalThis.fetch
    globalThis.window = {}
    try {
      globalThis.fetch = async () => ({
        ok: false,
        status: 403,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ message: 'ACCESS DENIED' })
      })
      let message = ''
      try {
        await admin.setStream(true)
      } catch (error) {
        message = String(error.message)
      }
      expectEqual(message, '管理员密码错误', 'fetch 403 应映射密码错误')

      globalThis.fetch = async () => {
        throw new TypeError('Failed to fetch')
      }
      message = ''
      try {
        await admin.setStream(true)
      } catch (error) {
        message = String(error.message)
      }
      expectEqual(message, '无法连接服务器（地址/网络）', 'fetch 网络异常应映射网络错误')
    } finally {
      globalThis.window = originalWindow
      globalThis.fetch = originalFetch
    }
  })

  /* ---------- 10. D-08 三段覆盖 + 退出登录 ---------- */

  await check('D-08-a：未认证直接 adminRequest → 本地拒绝「请先完成管理员认证」，零外发', async () => {
    admin.adminLogout()
    resetBridge()
    setResponder(() => jsonBridge(200, { message: 'should-not-be-called' }))
    let message = ''
    try {
      await admin.adminRequest('POST', '/api/admin/lock', { type: 'ALL', locked: true })
    } catch (error) {
      message = String(error.message)
    }
    expectEqual(message, admin.ADMIN_ERROR_NOT_VERIFIED, '未认证请求应本地拒绝')
    expectEqual(bridgeCalls.length, 0, '未认证时不得发出任何 HTTP 请求')

    // 业务封装同样本地拒绝（不会先发请求再报错）。
    message = ''
    try {
      await admin.setLock('ALL', true)
    } catch (error) {
      message = String(error.message)
    }
    expectEqual(message, admin.ADMIN_ERROR_NOT_VERIFIED, '未认证的 setLock 应本地拒绝')
    expectEqual(bridgeCalls.length, 0, '未认证的 setLock 不得发出请求')
  })

  await check('D-08-b：verifyAdmin 错误密码（服务端 403）→「管理员密码错误」，且只发验证请求', async () => {
    admin.adminLogout()
    resetBridge()
    setResponder(() => jsonBridge(403, { message: 'ACCESS DENIED' }))
    const ok = await admin.verifyAdmin('wrong-pass', 'http://127.0.0.1:8080')
    expectEqual(ok, false, '错误密码应返回 false')
    expectEqual(admin.adminAuth.error, admin.ADMIN_ERROR_PASSWORD, '403 应映射管理员密码错误')
    expectEqual(admin.adminAuth.verified, false, '失败后 verified 应为 false')
    expectEqual(admin.adminAuth.authenticatedServerBase, '', '失败后不应绑定服务器')
    expectEqual(bridgeCalls.length, 1, '只应发出一次 /api/admin/verify 请求')
    expectEqual(lastBridgeCall().url, 'http://127.0.0.1:8080/api/admin/verify', '验证 URL')
    expectEqual(lastBridgeCall().headers['X-Admin-Password'], 'wrong-pass', '候选密码头')
  })

  await check('D-08-c：正确验证后同 base 请求 200；切换到另一 base → 本地拒绝且零外发', async () => {
    const DEFAULT_SETTINGS = { serverUrl: 'http://127.0.0.1:8080', mode: 'local', userName: '' }
    config.saveSettings(DEFAULT_SETTINGS)
    admin.adminLogout()
    resetBridge()
    setResponder(() => jsonBridge(200, { message: 'VERIFIED' }))
    expectEqual(await admin.verifyAdmin(PASSWORD, 'http://127.0.0.1:8080'), true, 'A 验证成功')

    resetBridge()
    setResponder(() => jsonBridge(200, { message: 'ok' }))
    await admin.setStream(true)
    expectEqual(bridgeCalls.length, 1, '同 base 应正常发出一次请求')
    expectEqual(lastBridgeCall().url, 'http://127.0.0.1:8080/api/admin/room/stream', '同 base URL')

    // 切到 B：本地拒绝，不发出任何请求（旧密码绝不外发）。
    config.saveSettings({ ...DEFAULT_SETTINGS, serverUrl: 'http://203.0.113.7:9999/' })
    resetBridge()
    let message = ''
    try {
      await admin.setStream(true)
    } catch (error) {
      message = String(error.message)
    }
    expectEqual(message, admin.ADMIN_ERROR_SERVER_CHANGED, '切到 B 后应本地拒绝')
    expectEqual(bridgeCalls.length, 0, '切到 B 后不得发出请求')
    expectEqual(admin.adminAuth.verified, false, '切到 B 后旧会话应清除')
    config.saveSettings(DEFAULT_SETTINGS)
    admin.adminLogout()
  })

  await check('adminLogout：清空密码 / verified / error，且后续请求本地拒绝、零外发', async () => {
    await login()
    expect(admin.adminAuth.verified === true, '退出前应处于已认证状态')
    admin.adminLogout()
    expect(admin.adminAuth.password === '', 'logout 后密码应清空')
    expect(admin.adminAuth.verified === false, 'logout 后 verified 应为 false')
    expect(admin.adminAuth.error === '', 'logout 后 error 应为空')
    expect(admin.adminAuth.verifying === false, 'logout 后 verifying 应为 false')
    expect(admin.adminAuth.authenticatedServerBase === '', 'logout 后服务器绑定应清空')

    resetBridge()
    setResponder(() => jsonBridge(200, { message: 'should-not-be-called' }))
    let message = ''
    try {
      await admin.resetSystem()
    } catch (error) {
      message = String(error.message)
    }
    expectEqual(message, admin.ADMIN_ERROR_NOT_VERIFIED, '未登录请求应本地拒绝（不再外发旧密码）')
    expectEqual(bridgeCalls.length, 0, '未登录请求不得发出 HTTP 请求')
  })

  /* ---------- 汇总 ---------- */

  console.log('')
  console.log(`admin-api-smoke: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log('FAILURES:')
    for (const failure of failures) {
      console.log(`  - ${failure.name}`)
      console.log(`    ${failure.message}`)
    }
    process.exitCode = 1
  } else {
    console.log('ALL PASS')
    process.exitCode = 0
  }
}

main().catch((error) => {
  console.error('admin-api-smoke 运行异常：', error)
  process.exitCode = 1
})
