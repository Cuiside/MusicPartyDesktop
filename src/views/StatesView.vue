<script setup>
import StateBlock from '../components/StateBlock.vue'
</script>

<template>
  <div class="workspace">
    <div class="workspace-inner">
      <div class="states-grid">
        <section class="panel reveal reveal-1">
          <div class="panel-head">
            <span class="label">EMPTY · 空状态</span>
            <span class="label">队列为空</span>
          </div>
          <div class="panel-body">
            <StateBlock
              kind="empty"
              title="队列是空的"
              text="搜索并点一首歌，队列会实时同步到房间里所有人。"
              action-label="去搜索"
            />
          </div>
        </section>

        <section class="panel reveal reveal-2">
          <div class="panel-head">
            <span class="label">LOADING · 加载中</span>
            <span class="label">首次进入房间</span>
          </div>
          <div class="panel-body">
            <StateBlock
              kind="loading"
              title="正在同步房间状态"
              text="从服务器拉取播放进度、队列、成员与聊天记录…"
              action-label="取消"
            />
          </div>
        </section>

        <section class="panel reveal reveal-3">
          <div class="panel-head">
            <span class="label">ERROR · 出错</span>
            <span class="label">连接失败</span>
          </div>
          <div class="panel-body">
            <StateBlock
              kind="error"
              title="连接不上本地服务"
              text="请确认 Java 后端与网易云 API 已启动，或在设置中切换为连接远程服务器。"
              action-label="重试连接"
            />
          </div>
        </section>

        <section class="panel reveal reveal-4">
          <div class="panel-head">
            <span class="label">NO RESULTS · 无结果</span>
            <span class="label">搜索</span>
          </div>
          <div class="panel-body">
            <StateBlock
              kind="no-results"
              title="没有找到结果"
              text="换个关键词试试，或切换平台来源。支持网易云音乐与 Bilibili。"
              action-label="清空搜索"
            />
          </div>
        </section>

        <section class="panel reveal reveal-4 state-wide">
          <div class="panel-head">
            <span class="label">RECONNECT · 重连</span>
            <span class="label">连接中断（演示）</span>
          </div>
          <div class="panel-body">
            <div class="reconnect-bar" style="margin-bottom: 10px">
              <span class="reconnect-spinner"></span>
              <span class="reconnect-text">与服务器的连接已断开，正在尝试重连…</span>
              <button class="text-btn">立即重连</button>
            </div>
            <div class="empty-text" style="max-width: none">
              断线时窗口顶部出现黑色横幅，重连成功后自动消失；标题栏连接状态同步变为「重连中…」。
              重连后自动追赶播放进度并恢复队列与聊天状态。
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
