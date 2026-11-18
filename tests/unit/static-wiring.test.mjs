/**
 * 静态接线断言（D-01 / D-06 / D-12 / D-14 / D-16）：
 * 读取源文件文本验证关键顺序/接线，防止后续重构把修复回退而不自知。
 *
 * 运行：node --test tests/unit
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const read = (relative) => readFileSync(join(root, relative), 'utf8')

test('D-01：filteredQueueView watch 必须位于 computed 定义之后', () => {
  const source = read('src/App.vue')
  const tdzWatch = source.indexOf("() => filteredQueueView.value.map((s) => s.id).join('|')")
  const computedIndex = source.indexOf('const filteredQueueView = computed(')
  assert.ok(tdzWatch > 0, '应存在响应队列变化的选中 watcher')
  assert.ok(computedIndex > 0, '应存在 filteredQueueView computed')
  assert.ok(
    computedIndex < tdzWatch,
    `filteredQueueView watch 必须在 computed 之后（computed@${computedIndex}, watch@${tdzWatch}）`
  )
})

test('D-06：transport 不再用 resync 周期测 RTT，改用 /app/ping，resync 仅显式调用', () => {
  const source = read('src/core/live/transport.js')
  assert.match(source, /ping: '\/app\/ping'/, 'should define /app/ping destination')
  assert.match(source, /userPong: '\/user\/queue\/pong'/, 'should subscribe /user/queue/pong')
  assert.doesNotMatch(source, /setInterval\(measureLatency/, '不得存在 30s resync 测延迟定时器')
  assert.doesNotMatch(source, /latencySentAt/, '旧的“下一帧测 RTT”逻辑应已移除')
  const resyncCalls = source.match(/destination: DEST\.resync/g) || []
  assert.ok(resyncCalls.length <= 2, `resync 仅应出现在显式快照路径（<=2 处，实际 ${resyncCalls.length}）`)
  assert.match(source, /onSessionEnd/, '应提供会话结束生命周期回调（D-14）')
})

test('D-12：复制房间地址使用完整会话 base，不再用展示 host 重构', () => {
  const source = read('src/App.vue')
  assert.match(source, /live\.sessionBase \|\| httpBase\(/, '复制地址应优先使用 sessionBase')
  assert.doesNotMatch(source, /httpBase\(live\.server\)/, '不得再用展示 host 重构完整地址')
  assert.match(source, /const baseUrl = live\.sessionBase \|\| httpBase\(\)/, '媒体解析也应使用会话 base')
})

test('D-14：App 注册会话生命周期监听并在 teardown 后清理引擎', () => {
  const source = read('src/App.vue')
  assert.match(source, /setSessionLifecycleListener\(/)
  assert.match(source, /audioSetTrack\(null\)/, '生命周期清理应清空音频音源')
  assert.match(source, /if \(!liveMode\.value\) cleanupLiveAudio\(\)/, '离开实时模式也要兜底清理音频')
})

test('D-16：SettingsView 已连接且 base 变化时触发 App 事务切换，且显示会话 base', () => {
  const source = read('src/views/SettingsView.vue')
  assert.match(source, /emit\('server-change'/, '应触发 App 的原子切换')
  assert.match(source, /已应用并切换/, '应显示“已应用并切换”状态')
  assert.match(source, /仅保存（/, '未切换时应明确提示“仅保存/下次生效”')
  assert.match(source, /live\.sessionBase/, '应显示当前会话 base')
  const app = read('src/App.vue')
  assert.match(app, /const handleServerChange = async/, 'App 应有事务切换处理函数')
  assert.match(app, /@server-change="handleServerChange"/, '模板接线缺失')
})

test('D-15：App 不再用同步布尔判断命令成功，统一展示“已发送/等待确认”', () => {
  const source = read('src/App.vue')
  assert.match(source, /await liveAddToQueue\(song\)/)
  assert.match(source, /await liveSendChat\(text\)/)
  assert.match(source, /notifyCommandFailure/)
  assert.match(source, /等待服务器确认/)
  assert.doesNotMatch(source, /if \(liveAddToQueue\(song\)\) pushToast\(`已点歌/)
})

test('D-08：admin.js 绑定 authenticatedServerBase 并拒绝重定向', () => {
  const source = read('src/core/live/admin.js')
  assert.match(source, /authenticatedServerBase/)
  assert.match(source, /管理员认证已失效，请在新服务器重新认证/)
  assert.match(source, /redirect: redirectMode/)
  const transport = read('src/core/live/transport.js')
  assert.match(transport, /adminLogout\(\)/, 'teardown 必须清管理员会话')
})

test('D-02：OnboardingView 地址解析走统一 normalize，不静默回退', () => {
  const source = read('src/components/OnboardingView.vue')
  assert.match(source, /normalizeServerUrl\(value\)/)
  assert.match(source, /无法识别这个地址/)
  assert.doesNotMatch(source, /normalizeServerUrl\(withScheme\)/)
})

test('试听标记：三个 UI 组件均显示“试听”并使用实际可播时长', () => {
  const inspector = read('src/components/TrackInspector.vue')
  assert.match(inspector, /song\.trial/)
  assert.match(inspector, /song\.trialDurationKnown/)
  assert.match(inspector, /时长未确定/)
  const party = read('src/views/PartyView.vue')
  assert.match(party, /nowPlaying\.trial/)
  assert.match(party, /nowPlaying\.trialDurationKnown/)
  assert.match(party, /时长未确定/)
  const queue = read('src/components/QueueTable.vue')
  assert.match(queue, /item\.trial/)
  assert.match(queue, /item\.trialDurationKnown/)
  assert.match(queue, /时长未确定/)
})
