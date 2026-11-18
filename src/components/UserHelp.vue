<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
const emit = defineEmits(['close', 'tour'])
const query = ref(''), selected = ref(''), dialog = ref(null)
let previousFocus = null
const topics = [
  { id:'room', title:'加入房间与身份', cards:[['连接房间','点击顶部连接状态，输入服务器地址和房间密码后加入。游客可先收听；设置昵称后才能点歌和聊天。'],['本地房间','在设置的本地服务中设置管理员密码并启动服务，然后连接本机地址。']] },
  { id:'search', title:'搜索与导入', cards:[['搜索点歌','点击左侧搜索，选择房间已启用的音源，输入关键词并点击点歌。'],['歌单与专辑','在搜索页绑定用户、打开歌单或专辑，然后导入；导入数量受房间限制。']] },
  { id:'queue', title:'队列与播放', cards:[['队列管理','在队列中查看待播歌曲；依房间权限可置顶、移除、排序或认领离线成员歌单。'],['播放控制','点击中央播放键或短按空格只静音本机；长按播放键或空格可暂停房间。音量只影响本机。']] },
  { id:'chat', title:'聊天与互动', cards:[['消息和点赞','左侧聊天可发送消息；点击歌曲旁的心形按钮可为当前歌曲点赞。'],['桌面歌词','播放区的歌词按钮可打开桌面歌词，旁边菜单可调整字体、颜色、边框和背景。']] },
  { id:'admin', title:'管理员与设置', cards:[['管理员终端','点击顶部盾牌并验证管理员密码，管理房间、音源、播放规则和凭据。'],['应用设置','点击顶部齿轮调整主题、声音、本地服务与桌面歌词。不要在聊天中发送密码或 Cookie。']] },
  { id:'faq', title:'常见问题', cards:[['没有声音','检查本机静音、音量和系统输出设备；如果房间暂停，请按房间权限恢复播放。'],['音源不可用','搜索入口取决于房间启用的音源；请联系管理员检查音源服务及账号权限。']] }
]
const filtered = computed(() => topics.filter(t => !selected.value || t.id === selected.value).map(t => ({...t, cards:t.cards.filter(c => !query.value.trim() || (t.title+' '+c.join(' ')).toLowerCase().includes(query.value.trim().toLowerCase()))})).filter(t => t.cards.length))
const key = e => {
  if (e.key === 'Escape') { e.preventDefault(); emit('close'); return }
  if (e.key !== 'Tab' || !dialog.value) return
  const items = [...dialog.value.querySelectorAll('button:not([disabled]), input:not([disabled])')]
  if (!items.length) return
  const first = items[0], last = items[items.length - 1]
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
}
onMounted(() => { previousFocus = document.activeElement; window.addEventListener('keydown',key); dialog.value?.querySelector('input')?.focus() })
onBeforeUnmount(() => { window.removeEventListener('keydown',key); previousFocus?.focus?.() })
</script>
<template><Teleport to="body"><div class="help-backdrop" @click.self="emit('close')"><section ref="dialog" class="help-dialog" role="dialog" aria-modal="true" aria-label="用户帮助"><header><div><small>完整教程</small><h2>用户帮助</h2><p>按照桌面应用的操作查找说明。</p></div><button class="btn-ghost" aria-label="关闭帮助" @click="emit('close')">×</button></header><div class="help-search"><label for="help-search">搜索教程</label><input id="help-search" v-model="query" placeholder="搜索点歌、静音、房间等问题" /></div><nav><button :class="{active:!selected}" @click="selected=''">全部主题</button><button v-for="topic in topics" :key="topic.id" :class="{active:selected===topic.id}" @click="selected=topic.id">{{ topic.title }}</button></nav><main><section v-for="topic in filtered" :key="topic.id"><h3>{{ topic.title }}</h3><article v-for="card in topic.cards" :key="card[0]"><b>{{ card[0] }}</b><p>{{ card[1] }}</p></article></section><p v-if="!filtered.length">没有找到相关内容，请换个关键词。</p></main><footer><button class="btn-ghost" @click="emit('close')">关闭</button><button class="btn-primary" @click="emit('tour')">重新查看入门引导</button></footer></section></div></Teleport></template>
<style scoped>
.help-backdrop{position:fixed;inset:0;z-index:200;background:#101522ad;display:flex;align-items:center;justify-content:center;padding:20px}.help-dialog{width:min(920px,100%);max-height:min(820px,94vh);display:flex;flex-direction:column;background:var(--canvas);color:var(--ink);box-shadow:0 12px 36px #0005}.help-dialog header,.help-dialog footer{display:flex;justify-content:space-between;align-items:center;padding:18px 22px;border-bottom:1px solid var(--line)}.help-dialog header{background:var(--accent);color:var(--help-accent-text, #17131c);border-bottom:1px solid var(--shell-line)}.help-dialog header small{color:var(--help-accent-text, #17131c);font-weight:700}.help-dialog header p{color:var(--help-accent-text, #17131c)}.help-dialog h2{margin:5px 0}.help-dialog p{margin:8px 0;line-height:1.6;color:var(--muted)}.help-search{padding:12px 22px}.help-search label{display:block;font-weight:700;margin-bottom:6px}.help-search input{width:100%;padding:10px;border:1px solid var(--line);background:var(--surface);color:var(--ink)}nav{display:flex;flex-wrap:wrap;gap:6px;padding:10px 22px;border-bottom:1px solid var(--line)}nav button{padding:8px;border:1px solid var(--line);background:var(--surface);color:var(--ink)}nav button.active{background:var(--accent);color:var(--help-accent-text, #17131c);border-color:var(--accent)}main{overflow:auto;padding:12px 22px;flex:1}main h3{margin:18px 0 10px;color:var(--accent)}article b{color:var(--accent)}article{padding:12px;margin-bottom:8px;border:1px solid var(--line);background:var(--surface)}footer{border-top:1px solid var(--line);border-bottom:0!important}
:global(:root[data-theme=purple]) .help-dialog{--help-accent-text:#fff}
</style>
