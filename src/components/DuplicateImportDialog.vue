<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue'
defineProps({ count: { type: Number, required: true }, tracks: { type: Array, default: () => [] } })
const emit = defineEmits(['close'])
const button = ref(null)
let previousFocus
const keepFocus = event => {
  if (event.key === 'Tab') { event.preventDefault(); button.value?.focus() }
}
onMounted(() => { previousFocus = document.activeElement; document.addEventListener('keydown', keepFocus, true); button.value?.focus() })
onBeforeUnmount(() => { document.removeEventListener('keydown', keepFocus, true); previousFocus?.focus?.() })
</script>
<template><Teleport to="body"><div class="notice-backdrop"><section class="notice-dialog" role="alertdialog" aria-modal="true" aria-labelledby="duplicate-title"><header id="duplicate-title">重复歌曲提示</header><div class="notice-body"><p>服务器跳过了 <strong>{{ count }}</strong> 首重复歌曲。</p><p v-if="tracks.length">以下是根据导入前待播队列推测的歌曲，仅供参考；队列变化或导入限制可能影响结果。</p><p v-else>服务器未返回歌曲名称，无法确定具体曲目。</p><ul v-if="tracks.length"><li v-for="(track, index) in tracks" :key="index"><b>{{ track.title }}</b><span>{{ track.artist }}</span></li></ul></div><footer><button ref="button" class="btn-primary" @click="emit('close')">我知道了</button></footer></section></div></Teleport></template>
<style scoped>
.notice-backdrop{position:fixed;inset:0;z-index:100020;display:grid;place-items:center;background:#0009;padding:24px}.notice-dialog{width:min(480px,100%);max-height:85vh;display:flex;flex-direction:column;background:var(--canvas);color:var(--ink);border:1px solid var(--line);box-shadow:0 24px 60px #0005}.notice-dialog header{background:var(--accent);color:var(--notice-contrast,#17131c);padding:16px 18px;font-weight:700}.notice-body{padding:12px 18px;overflow:auto;line-height:1.6;font-size:12px}.notice-body strong,.notice-body b{color:var(--accent)}ul{list-style:none;margin:10px 0;padding:0;border:1px solid var(--line)}li{display:flex;justify-content:space-between;gap:12px;padding:8px;border-bottom:1px solid var(--line)}li span{color:var(--muted)}footer{display:flex;justify-content:flex-end;padding:0 18px 18px}:global(:root[data-theme=purple]) .notice-dialog{--notice-contrast:#fff}
</style>
