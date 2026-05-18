<script setup lang="ts">
import { ref } from 'vue'
import TimeLine from './components/TimeLine.vue'
import { defaultTasks, type TaskResult } from './components/timeline-types'

const visible = ref(false)
const result = ref<Record<string, TaskResult> | null>(null)

// 示例数据：实际使用时由业务方传入
const tasks = defaultTasks()

function onConfirm(r: Record<string, TaskResult>) {
  result.value = r
  console.log('[TimeLine confirm]', r)
}
</script>

<template>
  <div class="app-page">
    <button class="open-btn" @click="visible = true">打开时间轴</button>

    <div v-if="result" class="result-panel">
      <div class="result-panel__header">
        <span>📤 最新输出结果</span>
        <span class="result-panel__hint">（每次点击「确认」更新）</span>
      </div>
      <pre class="result-panel__body">{{ JSON.stringify(result, null, 2) }}</pre>
    </div>
  </div>

  <TimeLine v-model="visible" :tasks="tasks" @confirm="onConfirm" />
</template>

<style scoped>
.app-page {
  min-height: 100vh;
  background: #0A0F1E;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 40px;
  gap: 24px;
}
.open-btn {
  padding: 10px 28px;
  background: linear-gradient(135deg, #3B82F6, #1D4ED8);
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 15px;
  cursor: pointer;
  letter-spacing: 0.5px;
  transition: opacity 0.15s;
}
.open-btn:hover { opacity: 0.85; }
.result-panel {
  background: #0D1424;
  border: 1px solid #1E3A5F;
  border-radius: 8px;
  padding: 12px 20px 16px;
  max-width: 700px;
  width: 100%;
}
.result-panel__header {
  font-size: 12px;
  color: #64748B;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.result-panel__hint { color: #475569; }
.result-panel__body {
  margin: 0;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 12px;
  line-height: 1.6;
  color: #34D399;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
