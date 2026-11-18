<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  cover: { type: Object, required: true },
  small: { type: Boolean, default: false }
})

const mark = computed(() => props.cover?.mark || '♪')
const display = computed(() =>
  props.small ? [...mark.value].slice(0, 1).join('') : mark.value
)
const wrap = computed(() => !props.small && [...mark.value].length > 3)

/* ------------------------------------------------------------------ */
/* 真实封面                                                            */
/* ------------------------------------------------------------------ */
/* 后端 `Music.coverUrl` / `PlayableMusic.coverUrl` 经 mapping.js 归一化后放在
   `cover.url`。加载成功才覆盖文字封面；无 URL、404/403、解码失败时保留下面的
   确定性文字封面（fallback）。协议相对 URL 与已知 CDN 的 http→https 已在
   mapping.js 处理；这里再对残留的 http URL 做一次 https 重试兜底。 */
const candidates = computed(() => {
  const url = typeof props.cover?.url === 'string' ? props.cover.url.trim() : ''
  if (!url) return []
  if (/^http:\/\//i.test(url)) return [url, `https://${url.slice('http://'.length)}`]
  return [url]
})

const sourceIndex = ref(0)
const failed = ref(false)
const loaded = ref(false)

// 换歌（URL 变化）时重置加载状态；同一 URL 的重复 state 帧不会重新加载图片。
watch(
  () => candidates.value[0] || '',
  () => {
    sourceIndex.value = 0
    failed.value = false
    loaded.value = false
  }
)

const imageSrc = computed(() =>
  failed.value ? '' : candidates.value[sourceIndex.value] || ''
)

const onLoad = () => {
  loaded.value = true
}

const onError = () => {
  loaded.value = false
  if (sourceIndex.value + 1 < candidates.value.length) {
    sourceIndex.value += 1 // 例如 http → https 重试
    return
  }
  failed.value = true // 所有候选都失败：显示文字封面
}
</script>

<template>
  <div
    class="cover"
    :class="{ small }"
    :style="{ background: cover.bg, color: cover.fg }"
    aria-hidden="true"
  >
    <img
      v-if="imageSrc"
      class="cover-img"
      :class="{ 'is-ready': loaded }"
      :src="imageSrc"
      alt=""
      loading="lazy"
      decoding="async"
      draggable="false"
      @load="onLoad"
      @error="onError"
    />
    <div v-show="!loaded" class="cover-mark" :class="{ wrap }">{{ display }}</div>
    <div v-if="!small && !loaded" class="cover-foot">
      <span>{{ cover.sub }}</span>
      <span class="tag">{{ cover.tag }}</span>
    </div>
  </div>
</template>

<style scoped>
/* 真实封面覆盖层：图片是绝对定位的，下面的文字封面先显示，图片解码成功后才
   淡入并隐藏文字；加载失败时直接移除 <img>，文字封面原样保留。 */
.cover-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  background: #141314;
  opacity: 0;
  transition: opacity 0.18s ease;
}

.cover-img.is-ready {
  opacity: 1;
}
</style>
