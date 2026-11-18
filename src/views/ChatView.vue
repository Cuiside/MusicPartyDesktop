<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { Send, Terminal } from 'lucide-vue-next'
import TrackCover from '../components/TrackCover.vue'

const props = defineProps({
  messages: { type: Array, required: true },
  live: { type: Boolean, default: false }
})
const emit = defineEmits(['send', 'add', 'find'])

const draft = ref('')
const scroller = ref(null)

const count = computed(() => props.messages.length)

const scrollToBottom = async () => {
  await nextTick()
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
}

const send = () => {
  const text = draft.value.trim()
  if (!text) return
  emit('send', text)
  draft.value = ''
  scrollToBottom()
}

watch(count, scrollToBottom)
onMounted(scrollToBottom)
</script>

<template>
  <div class="workspace chat-workspace">
    <div class="workspace-inner">
      <div class="panel chat-panel reveal reveal-1">
        <div class="panel-head">
          <span class="label">
            房间聊天 · {{ count }} 条 · {{ live ? '实时同步' : '演示数据' }}
          </span>
          <span class="label">限流 1s · / 命令</span>
        </div>

        <div ref="scroller" class="chat-scroll">
          <template v-for="m in messages" :key="m.id">
            <div v-if="m.type === 'system'" class="chat-msg system">
              <span class="chat-time">{{ m.time }}</span>
              <span class="chat-sys">{{ m.text }}</span>
            </div>

            <div v-else-if="m.type === 'song'" class="chat-msg">
              <span class="chat-time">{{ m.time }}</span>
              <span class="member-avatar alt">{{ (m.user || '?').slice(0, 1) }}</span>
              <div class="chat-body">
                <div class="chat-head">
                  <span class="chat-name">{{ m.user }}</span>
                  <span v-if="m.role" class="chat-role">{{ m.role }}</span>
                </div>
                <div class="chat-song">
                  <div class="chat-song-cover">
                    <TrackCover v-if="m.song" :cover="m.song.cover" small />
                  </div>
                  <div class="chat-song-info">
                    <span class="stitle">{{ m.song?.title || m.text }}</span>
                    <span class="sartist">{{ m.song?.artist || '' }}</span>
                  </div>
                  <button v-if="m.song?.id" class="chip" @click="emit('add', m.song)">点歌</button>
                  <button v-else-if="m.song?.title" class="chip" @click="emit('find', m.song.title)">搜索点歌</button>
                  <span v-else class="chip">无法点歌</span>
                </div>
              </div>
            </div>

            <div v-else class="chat-msg" :class="{ me: m.me }">
              <span class="chat-time">{{ m.time }}</span>
              <span class="member-avatar" :class="{ alt: !m.me }">
                {{ (m.user || '?').slice(0, 1) }}
              </span>
              <div class="chat-body">
                <div class="chat-head">
                  <span class="chat-name">{{ m.user }}</span>
                  <span v-if="m.role" class="chat-role">{{ m.role }}</span>
                </div>
                <span v-if="m.command" class="chat-command">{{ m.text }}</span>
                <span v-else class="chat-text">{{ m.text }}</span>
              </div>
            </div>
          </template>

          <div v-if="!count" class="chat-empty">
            还没有消息 · 输入 /help 查看可用命令
          </div>
        </div>

        <div class="chat-composer">
          <div class="chat-input-wrap">
            <Terminal class="composer-icon" :size="14" :stroke-width="1.8" />
            <input
              v-model="draft"
              placeholder="发送消息，或输入 / 命令…"
              spellcheck="false"
              @keydown.enter.prevent="send"
            />
          </div>
          <button class="btn-primary chat-send" @click="send">
            <Send :size="13" :stroke-width="2" />
            发送
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
