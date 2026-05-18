<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { ElDialog, ElButton, ElInput, ElRadioGroup, ElRadioButton } from 'element-plus'
import { type TimeTask, type TaskResult, ORIGIN } from './timeline-types'

// ────────────────────────── Props / Emits ──────────────────

// 注：trackDirty / enforceLimit 必须用 withDefaults 显式设为 true，
// 否则 Vue 的 boolean casting 会将未传入的 ?:boolean prop 转成 false
const props = withDefaults(defineProps<{
  /** v-model — 控制整个弹窗的显示/隐藏 */
  modelValue?: boolean
  /** 必传：任务数组（segments.startTime/endTime 均为 Unix ms 时间戳）*/
  tasks: TimeTask[]
  /** 是否在 confirm 结果中追踪 isDirty（默认 true）*/
  trackDirty?: boolean
  /** 是否启用每任务 limit 时间范围约束（默认 true）*/
  enforceLimit?: boolean
}>(), {
  trackDirty: true,
  enforceLimit: true,
})

/**
 * update:modelValue — v-model 双向绑定可见性
 * confirm — 点击外层「确认」时触发，携带每个任务的最终段区间和 isDirty
 *   格式: { [id]: { segments: [[startMs, endMs], ...], isDirty: boolean } }
 *   时间格式: Unix 毫秒时间戳（number）
 */
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  confirm: [result: Record<string, TaskResult>]
}>()

/** 本地可见状态，双向绑定到父组件 v-model */
const localVisible = computed({
  get: () => props.modelValue ?? false,
  set: (v) => emit('update:modelValue', v),
})

// ────────────────────────── 常量 ──────────────────────────

const LABEL_W = 172              // 左侧任务标签列宽度（px）
const MIN_BAR_SECONDS = 900      // 时间段最小宽度：15 分钟（防止拖拽至零长）
const TOTAL_RANGE = 7 * 86400   // 可导航的总时间范围：7 天（秒）

/** Unix ms 时间戳 → 内部秒（距 ORIGIN 的秒数）*/
const msToSec = (ms: number) => Math.round((ms - ORIGIN) / 1000)

// ────────────────────────── 响应式状态 ─────────────────────

/** 时间轴容器 DOM 引用，用于测量实际宽度 */
const containerRef = ref<HTMLElement | null>(null)
/** 容器宽度缓存（px），随窗口 resize 实时更新 */
const containerWidth = ref(1440)
/** 工作副本：内部均为秒（距 ORIGIN 的秒数），弹窗打开时从 props.tasks（ms）转换而来 */
const tasks = ref<TimeTask[]>(props.tasks.map(t => ({
  ...t,
  segments: t.segments.map(s => ({ startTime: msToSec(s.startTime), endTime: msToSec(s.endTime) })),
})))
/** 弹窗打开时的初始秒数快照，用于 isDirty 比较（key=task.id，值为内部秒）*/
const originalSegments = ref<Record<string, [number, number][]>>({})

// 每次弹窗打开时从 props 重新初始化（取消则丢弃本次修改）
watch(localVisible, (v) => {
  if (v) {
    tasks.value = props.tasks.map(t => ({
      ...t,
      segments: t.segments.map(s => ({ startTime: msToSec(s.startTime), endTime: msToSec(s.endTime) })),
    }))
    // 在转换完成后，从 tasks.value（已是秒）取快照——无需二次 ms/sec 转换
    if (props.trackDirty !== false) {
      const orig: Record<string, [number, number][]> = {}
      for (const t of tasks.value) {
        orig[t.id] = t.segments.map(s => [s.startTime, s.endTime])
      }
      originalSegments.value = orig
    }
    nextTick(() => updateWidth())
  }
})

// 根据传入数据的时间范围推算初始视口，无需外部传入
const _initMin = props.tasks.reduce((m, t) => t.segments.reduce((m2, s) => Math.min(m2, msToSec(s.startTime)), m), Infinity)
const _initMax = props.tasks.reduce((m, t) => t.segments.reduce((m2, s) => Math.max(m2, msToSec(s.endTime)), m), -Infinity)
const _boundsMin = _initMin === Infinity  ? 0           : _initMin
const _boundsMax = _initMax === -Infinity ? TOTAL_RANGE : _initMax
// 两侧各留 3% 视觉余量，避免首尾拖拽柄被裁切（最小 900 秒）
const _pad = Math.max(900, Math.round((_boundsMax - _boundsMin) * 0.03))
const _viewMin = _boundsMin - _pad  // 可滚动范围左边界（秒）
const _viewMax = _boundsMax + _pad  // 可滚动范围右边界（秒）

/** 当前视口起始秒（对应时间轴左侧可见位置）*/
const viewStart = ref(_viewMin)
/** 当前视口结束秒（对应时间轴右侧可见位置）*/
const viewEnd   = ref(_viewMax)

// ── 编辑弹窗状态 ──
/** 编辑弹窗是否可见 */
const dialogVisible = ref(false)
/** 当前正在编辑的任务对象 */
const editingTask = ref<TimeTask | null>(null)
/** 当前正在编辑的段索引 */
const editingSegIdx = ref(0)
/** 编辑框：开始时间字符串（YYYY-MM-DD HH:mm:ss）*/
const editStart = ref('')
/** 编辑框：结束时间字符串（YYYY-MM-DD HH:mm:ss）*/
const editEnd   = ref('')
/** 拆分模式：none=不拆分，2=拆分2段，3=拆分3段 */
const splitMode = ref<'none' | '2' | '3'>('none')
/** 弹窗校验错误提示文本 */
const dialogError = ref('')
/** 拆分模式下每个子段的时间输入 */
type SplitSeg = { start: string; end: string }
const splitSegs = ref<SplitSeg[]>([])

/** 日期格式正则 YYYY-MM-DD HH:mm:ss */
const DATE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

/** 将"距 ORIGIN 的秒数"格式化为 YYYY-MM-DD HH:mm:ss 字符串 */
function secToStr(s: number): string {
  const d = secToDate(s)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 将 YYYY-MM-DD HH:mm:ss 字符串解析为"距 ORIGIN 的秒数"，格式非法或日期无效时返回 null */
function strToSec(str: string): number | null {
  if (!DATE_RE.test(str)) return null
  const d = new Date(str.replace(' ', 'T'))
  return isNaN(d.getTime()) ? null : dateToSec(d)
}

// ── 拖拽状态 ──
/** 当前拖拽目标：任务索引、段索引、操作边（左/右/整体移动）*/
type DragTarget = { taskIdx: number; segIdx: number; edge: 'left' | 'right' | 'move' }
const dragging = ref<DragTarget | null>(null)
/** 拖拽起始鼠标 X（px）*/
const dragStartX = ref(0)
/** 拖拽起始时段 startTime（秒）*/
const dragStartSec = ref(0)
/** 拖拽起始时段 endTime（秒）*/
const dragStartSecEnd = ref(0)

// ── 背景平移状态 ──
/** 是否正在平移视口 */
const isPanning = ref(false)
/** 平移起始鼠标 X */
const panStartX = ref(0)
/** 平移起始 viewStart（秒）*/
const panStartViewStart = ref(0)

// ── 导航滑块拖拽状态 ──
/** 是否正在拖拽底部导航缩略滑块 */
const isScrollThumbDrag = ref(false)
/** 滑块拖拽起始鼠标 X */
const thumbDragStartX = ref(0)
/** 滑块拖拽起始 viewStart（秒）*/
const thumbDragStartViewStart = ref(0)

// ────────────────────────── 计算属性 ────────────────────────

/** 当前视口时长（秒）*/
const totalSeconds = computed(() => viewEnd.value - viewStart.value)

/** 时间轴区域宽度 = 容器宽度 - 左侧标签列宽（px）*/
const timelineWidth = computed(() => containerWidth.value - LABEL_W)

/** 底部导航滑块左偏移（px）：当前视口在全局范围内的位置比例 */
const thumbLeft = computed(() => ((viewStart.value - _viewMin) / (_viewMax - _viewMin)) * timelineWidth.value)
/** 底部导航滑块宽度（px）：当前视口占全局范围的比例，最小 40px */
const thumbWidth = computed(() => Math.max(40, (totalSeconds.value / (_viewMax - _viewMin)) * timelineWidth.value))

/** 可拖拽/编辑的时间边界：取所有初始段的并集（防止拖出数据范围）*/
const dataBounds = computed(() => {
  let min = Infinity, max = -Infinity
  for (const t of props.tasks) {
    for (const s of t.segments) {
      const sMin = msToSec(s.startTime), sMax = msToSec(s.endTime)
      if (sMin < min) min = sMin
      if (sMax > max) max = sMax
    }
  }
  return {
    min: min === Infinity  ? 0           : min,
    max: max === -Infinity ? TOTAL_RANGE : max,
  }
})

/** 各任务的 limit 约束，转换为内部秒格式（enforceLimit !== false 且 task.limit 存在时有效）*/
const taskLimits = computed<Record<string, [number, number]>>(() => {
  if (props.enforceLimit === false) return {}
  return Object.fromEntries(
    props.tasks
      .filter(t => t.limit)
      .map(t => [t.id, [msToSec(t.limit!.startTime), msToSec(t.limit!.endTime)] as [number, number]])
  )
})

/** 获取指定任务的有效时间边界：有 limit 则用 limit，否则用全局 dataBounds */
function getTaskBounds(taskIdx: number): { min: number; max: number } {
  const task = tasks.value[taskIdx]
  const limit = taskLimits.value[task.id]
  if (limit) return { min: limit[0], max: limit[1] }
  return dataBounds.value
}

/** 当前正在编辑任务的 limit 约束（秒），无约束时为 null */
const currentTaskLimitSec = computed<[number, number] | null>(() => {
  if (!editingTask.value) return null
  return taskLimits.value[editingTask.value.id] ?? null
})

/** 将"距 ORIGIN 的秒数"转换为时间轴 X 坐标（px）*/
function secondToX(sec: number): number {
  return ((sec - viewStart.value) / totalSeconds.value) * timelineWidth.value
}

/** 将秒数对齐到最近的 step 整数倍（默认 60 秒 = 1 分钟），实现磁吸效果 */
function snapSecond(s: number, step = 60): number {
  return Math.round(s / step) * step
}

/**
 * 刻度线列表：根据当前像素密度自动选择合适的刻度间隔，避免标签重叠。
 * 档位：15min / 30min / 1h / 2h / 3h / 6h / 12h / 1d / 2d
 * 策略：每两条相邻刻度之间至少保留 MIN_TICK_PX 像素宽度。
 */
const rulerTicks = computed(() => {
  // 刻度间隔候选档位（秒），由小到大
  const STEPS = [900, 1800, 3600, 7200, 3 * 3600, 6 * 3600, 12 * 3600, 86400, 2 * 86400]
  const MIN_TICK_PX = 72  // 相邻刻度最小像素间距（保留标签宽度余量）
  const pxPerSec = timelineWidth.value / totalSeconds.value
  const minStepSec = MIN_TICK_PX / pxPerSec
  // 选最小的、但仍能保证间距的档位
  const step = STEPS.find(s => s >= minStepSec) ?? STEPS[STEPS.length - 1]

  const ticks: { label: string; x: number; major: boolean }[] = []
  const start = Math.ceil(viewStart.value / step) * step
  for (let s = start; s <= viewEnd.value; s += step) {
    const date = new Date(ORIGIN + s * 1000)
    const isMidnight = s % (24 * 3600) === 0
    const h = pad(date.getHours())
    const m = pad(date.getMinutes())
    // 小于 1 小时的档位显示分钟，否则只显示小时
    const timeStr = step < 3600 ? `${h}:${m}` : `${h}:00`
    const label = isMidnight
      ? `${date.getMonth() + 1}/${date.getDate()}\n${timeStr}`
      : timeStr
    ticks.push({ label, x: secondToX(s), major: isMidnight })
  }
  return ticks
})

function pad(n: number) { return String(n).padStart(2, '0') }

/** 将"距 ORIGIN 的秒数"格式化为 "M/D HH:MM" 用于时间段标签显示 */
function formatSecond(s: number): string {
  const d = new Date(ORIGIN + s * 1000)
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 将"距 ORIGIN 的秒数"转换为 Date 对象 */
function secToDate(s: number): Date {
  return new Date(ORIGIN + s * 1000)
}

/** 将 Date 对象转换为"距 ORIGIN 的秒数"（四舍五入到整秒）*/
function dateToSec(d: Date): number {
  return Math.round((d.getTime() - ORIGIN) / 1000)
}

/** 将秒数时长格式化为 "X小时Y分钟Z秒" 的可读字符串 */
function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  return `${h}小时${m}分钟${s}秒`
}

/** 将重叠时长格式化为简短标签，如 "2h30m"（用于重叠区域徽标）*/
function formatOverlap(secs: number): string {
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (h > 0) return `${h}h${m > 0 ? m + 'm' : ''}`
  return `${m}m`
}

/** 重叠检测：遍历所有任务对的所有段组合，收集有重叠的区间 */
const overlaps = computed(() => {
  const result: { taskA: number; taskB: number; start: number; end: number }[] = []
  for (let i = 0; i < tasks.value.length; i++) {
    for (let j = i + 1; j < tasks.value.length; j++) {
      for (const sa of tasks.value[i].segments) {
        for (const sb of tasks.value[j].segments) {
          const start = Math.max(sa.startTime, sb.startTime)
          const end = Math.min(sa.endTime, sb.endTime)
          if (end > start) {
            result.push({ taskA: i, taskB: j, start, end })
          }
        }
      }
    }
  }
  return result
})



// ────────────────────────── 拖拽事件 ────────────────────────

/** 拖拽拖柄（左/右边缘）按下：记录初始状态，开始调整段宽度 */
function onHandleMousedown(e: MouseEvent, taskIdx: number, segIdx: number, edge: 'left' | 'right') {
  e.preventDefault()
  e.stopPropagation()
  const seg = tasks.value[taskIdx].segments[segIdx]
  dragging.value = { taskIdx, segIdx, edge }
  dragStartX.value = e.clientX
  dragStartSec.value = seg.startTime
  dragStartSecEnd.value = seg.endTime
}

/** 拖拽时间段主体按下：记录初始状态，开始整体平移段 */
function onBarMousedown(e: MouseEvent, taskIdx: number, segIdx: number) {
  e.preventDefault()
  e.stopPropagation()
  const seg = tasks.value[taskIdx].segments[segIdx]
  dragging.value = { taskIdx, segIdx, edge: 'move' }
  dragStartX.value = e.clientX
  dragStartSec.value = seg.startTime
  dragStartSecEnd.value = seg.endTime
}

/** 全局 mousemove：统一处理滚动条拖拽、背景平移、段拖拽三种模式 */
function onMousemove(e: MouseEvent) {
  // 模式一：底部导航滑块拖拽
  if (isScrollThumbDrag.value) {
    const dx = e.clientX - thumbDragStartX.value
    const dur = totalSeconds.value
    let newStart = thumbDragStartViewStart.value + (dx / timelineWidth.value) * (_viewMax - _viewMin)
    newStart = Math.max(_viewMin, Math.min(_viewMax - dur, newStart))
    viewStart.value = newStart
    viewEnd.value = newStart + dur
    return
  }
  // 模式二：背景平移（按住空白区域左右滑动）
  if (isPanning.value) {
    const dx = e.clientX - panStartX.value
    const dur = totalSeconds.value
    let newStart = panStartViewStart.value - (dx / timelineWidth.value) * dur
    newStart = Math.max(_viewMin, Math.min(_viewMax - dur, newStart))
    viewStart.value = newStart
    viewEnd.value = newStart + dur
    return
  }
  if (!dragging.value) return
  const dx = e.clientX - dragStartX.value
  const dSec = (dx / timelineWidth.value) * totalSeconds.value
  const seg = tasks.value[dragging.value.taskIdx].segments[dragging.value.segIdx]

  const bounds = getTaskBounds(dragging.value.taskIdx)
  if (dragging.value.edge === 'left') {
    const newStart = snapSecond(dragStartSec.value + dSec)
    seg.startTime = Math.max(bounds.min, Math.min(newStart, seg.endTime - MIN_BAR_SECONDS))
  } else if (dragging.value.edge === 'right') {
    const newEnd = snapSecond(dragStartSecEnd.value + dSec)
    seg.endTime = Math.min(bounds.max, Math.max(newEnd, seg.startTime + MIN_BAR_SECONDS))
  } else {
    const dur = dragStartSecEnd.value - dragStartSec.value
    const raw = snapSecond(dragStartSec.value + dSec)
    const newStart = Math.max(bounds.min, Math.min(bounds.max - dur, raw))
    seg.startTime = newStart
    seg.endTime = newStart + dur
  }
}

/** 全局 mouseup：清除所有拖拽/平移状态 */
function onMouseup() {
  dragging.value = null
  isPanning.value = false
  isScrollThumbDrag.value = false
}

// ────────────────────────── 视口平移 ────────────────────────

/** 主区域 mousedown：排除交互元素后启动背景平移 */
function onMainMousedown(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (target.closest('.tl-bar, .tl-handle, .tl-time-label, .tl-label-cell, .tl-nav-scrollbar')) return
  e.preventDefault()
  isPanning.value = true
  panStartX.value = e.clientX
  panStartViewStart.value = viewStart.value
}

/** 底部导航滑块 mousedown：启动滑块拖拽 */
function onScrollThumbMousedown(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  isScrollThumbDrag.value = true
  thumbDragStartX.value = e.clientX
  thumbDragStartViewStart.value = viewStart.value
}

/** 点击导航轨道（非滑块区域）：将视口中心跳转到点击位置 */
function onScrollTrackClick(e: MouseEvent) {
  // 点击的是滑块本身时不触发（避免与拖拽冲突）
  if ((e.target as HTMLElement).classList.contains('tl-nav-thumb')) return
  const track = e.currentTarget as HTMLElement
  const rect = track.getBoundingClientRect()
  const x = e.clientX - rect.left
  const clickSec = _viewMin + (x / timelineWidth.value) * (_viewMax - _viewMin)
  const dur = totalSeconds.value
  let newStart = clickSec - dur / 2
  newStart = Math.max(_viewMin, Math.min(_viewMax - dur, newStart))
  viewStart.value = newStart
  viewEnd.value = newStart + dur
}

// ────────────────────────── 编辑弹窗 ────────────────────────

/** 打开段编辑弹窗：将当前段时间填入输入框，重置拆分状态 */
function openEditDialog(taskIdx: number, segIdx: number) {
  editingTask.value = tasks.value[taskIdx]
  editingSegIdx.value = segIdx
  const seg = tasks.value[taskIdx].segments[segIdx]
  editStart.value = secToStr(seg.startTime)
  editEnd.value   = secToStr(seg.endTime)
  splitMode.value = 'none'
  splitSegs.value = []
  dialogError.value = ''
  dialogVisible.value = true
}

/** 监听拆分模式切换：自动将当前段均分为 2 或 3 段并填入各子段输入框 */
watch(splitMode, (mode) => {
  if (mode === 'none') return
  const start = strToSec(editStart.value)
  const end   = strToSec(editEnd.value)
  if (start === null || end === null) return
  const count = mode === '2' ? 2 : 3
  const dur   = Math.round((end - start) / count)
  splitSegs.value = Array.from({ length: count }, (_, i) => {
    const s = start + dur * i
    const e = i === count - 1 ? end : start + dur * (i + 1)
    return { start: secToStr(s), end: secToStr(e) }
  })
})

/** 编辑弹窗「确认」：校验输入，更新段数据（拆分模式下插入新段），关闭弹窗 */
function onConfirm() {
  if (!editingTask.value) return
  const seg = editingTask.value.segments[editingSegIdx.value]
  const taskIdx = tasks.value.indexOf(editingTask.value)
  if (taskIdx < 0) return
  const bounds = getTaskBounds(taskIdx)
  dialogError.value = ''

  if (splitMode.value !== 'none') {
    for (let i = 0; i < splitSegs.value.length; i++) {
      const s = splitSegs.value[i]
      if (!DATE_RE.test(s.start) || !DATE_RE.test(s.end)) {
        dialogError.value = `段 ${i + 1} 格式错误，请使用 YYYY-MM-DD HH:mm:ss`; return
      }
    }
    const parsed = splitSegs.value.map(s => ({
      start: strToSec(s.start)!,
      end:   strToSec(s.end)!,
    }))
    for (let i = 0; i < parsed.length; i++) {
      if (isNaN(parsed[i].start) || isNaN(parsed[i].end)) {
        dialogError.value = `段 ${i + 1} 时间无效`; return
      }
      if (parsed[i].end <= parsed[i].start) {
        dialogError.value = `段 ${i + 1} 的结束时间必须晚于开始时间`; return
      }
      if (parsed[i].start < bounds.min) {
        dialogError.value = `段 ${i + 1} 的开始时间不能早于 ${formatSecond(bounds.min)}`; return
      }
      if (parsed[i].end > bounds.max) {
        dialogError.value = `段 ${i + 1} 的结束时间不能晚于 ${formatSecond(bounds.max)}`; return
      }
    }
    seg.startTime = parsed[0].start
    seg.endTime   = parsed[0].end
    for (let i = 1; i < parsed.length; i++) {
      tasks.value[taskIdx].segments.splice(editingSegIdx.value + i, 0, {
        startTime: parsed[i].start, endTime: parsed[i].end,
      })
    }
  } else {
    if (!DATE_RE.test(editStart.value) || !DATE_RE.test(editEnd.value)) {
      dialogError.value = '时间格式错误，请使用 YYYY-MM-DD HH:mm:ss'; return
    }
    const newStart = strToSec(editStart.value)!
    const newEnd   = strToSec(editEnd.value)!
    if (isNaN(newStart) || isNaN(newEnd)) { dialogError.value = '时间无效，请检查日期是否存在'; return }
    if (newEnd <= newStart) { dialogError.value = '结束时间必须晚于开始时间'; return }
    if (newStart < bounds.min) { dialogError.value = `开始时间不能早于 ${formatSecond(bounds.min)}`; return }
    if (newEnd > bounds.max)   { dialogError.value = `结束时间不能晚于 ${formatSecond(bounds.max)}`; return }
    seg.startTime = newStart
    seg.endTime   = newEnd
  }

  dialogVisible.value = false
}

/** 外层弹窗「确认」— 输出所有任务的最终段区间并关闭弹窗 */
function onOuterConfirm() {
  const result: Record<string, TaskResult> = {}
  for (const task of tasks.value) {
    const currentSegs: [number, number][] = task.segments.map(s => [
      ORIGIN + s.startTime * 1000,
      ORIGIN + s.endTime   * 1000,
    ])
    let isDirty = false
    if (props.trackDirty !== false) {
      // 直接比较内部秒数（origSegs 也是秒，无需再做 ms 转换）
      const origSegs = originalSegments.value[task.id] ?? []
      if (origSegs.length !== task.segments.length) {
        isDirty = true
      } else {
        isDirty = task.segments.some(
          (s, i) => s.startTime !== origSegs[i][0] || s.endTime !== origSegs[i][1]
        )
      }
    }
    result[task.id] = { segments: currentSegs, isDirty }
  }
  emit('confirm', result)
  localVisible.value = false
}

// ────────────────────────── 缩放 ────────────────────────────

const ZOOM_FACTOR = 1.2    // 按钮每次缩放比例
const MIN_ZOOM_DUR = 3600  // 最小视口：1 小时（秒）

/**
 * 鼠标滚轮缩放：以光标所在时间点为中心放大/缩小视口。
 * 使用 deltaY 实际值做比例缩放，避免固定档位滚动过快。
 * 普通鼠标一格 ≈ 100 单位 → 约 8% 变化；触控板连续滚动更平滑。
 */
function onWheel(e: WheelEvent) {
  const rect = containerRef.value?.getBoundingClientRect()
  if (!rect) return
  const xInTimeline = e.clientX - rect.left - LABEL_W
  const ratio = Math.max(0, Math.min(1, xInTimeline / timelineWidth.value))
  const mouseSec = viewStart.value + ratio * totalSeconds.value

  // 每单位 deltaY 对应 0.08% 缩放，普通鼠标一格 ~8%，触控板极平滑
  const factor = Math.pow(1.0008, e.deltaY)
  const newDur = Math.max(MIN_ZOOM_DUR, Math.min(_viewMax - _viewMin, totalSeconds.value * factor))
  let newStart = mouseSec - ratio * newDur
  newStart = Math.max(_viewMin, Math.min(_viewMax - newDur, newStart))
  viewStart.value = newStart
  viewEnd.value   = newStart + newDur
}

/**
 * 按钮缩放：以视口中心为轴，direction=-1 放大，direction=1 缩小。
 */
function onZoom(direction: 1 | -1) {
  const center = (viewStart.value + viewEnd.value) / 2
  const factor = direction > 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR
  const newDur = Math.max(MIN_ZOOM_DUR, Math.min(_viewMax - _viewMin, totalSeconds.value * factor))
  let newStart = center - newDur / 2
  newStart = Math.max(_viewMin, Math.min(_viewMax - newDur, newStart))
  viewStart.value = newStart
  viewEnd.value   = newStart + newDur
}

// ────────────────────────── 生命周期 ────────────────────────

/** 更新容器宽度缓存（resize 时调用）*/
function updateWidth() {
  if (containerRef.value) containerWidth.value = containerRef.value.offsetWidth
}

onMounted(() => {
  updateWidth()
  window.addEventListener('mousemove', onMousemove)
  window.addEventListener('mouseup', onMouseup)
  window.addEventListener('resize', updateWidth)
})

onUnmounted(() => {
  window.removeEventListener('mousemove', onMousemove)
  window.removeEventListener('mouseup', onMouseup)
  window.removeEventListener('resize', updateWidth)
})
</script>

<template>
  <ElDialog
    v-model="localVisible"
    title="时间轴范围选择器"
    width="92%"
    class="tl-outer-dialog"
    append-to-body
  >
    <div class="tl-root">
      <!-- ── Main area ── -->
    <div
      ref="containerRef"
      class="tl-main"
      :class="{ 'tl-main--panning': isPanning }"
      @mousedown="onMainMousedown"
      @wheel.prevent="onWheel"
    >
      <div class="tl-scroll-inner">
      <!-- ── Ruler ── -->
      <div class="tl-ruler-row">
        <div class="tl-label-cell" />
        <div class="tl-ruler">
          <template v-for="tick in rulerTicks" :key="tick.x">
            <div
              class="tl-tick"
              :class="tick.major ? 'tl-tick--major' : 'tl-tick--minor'"
              :style="{ left: tick.x + 'px' }"
            >
              <span class="tl-tick-label" v-html="tick.label.replace('\n', '<br>')" />
              <div class="tl-tick-line" />
            </div>
          </template>
        </div>
      </div>

      <!-- ── Task Rows ── -->
      <div
        v-for="(task, taskIdx) in tasks"
        :key="task.id"
        class="tl-row"
        :class="taskIdx % 2 === 0 ? 'tl-row--odd' : 'tl-row--even'"
      >
        <!-- Row divider -->
        <div v-if="taskIdx > 0" class="tl-row-divider" />

        <!-- Label -->
        <div class="tl-label-cell">
          <span class="tl-task-name">{{ task.name }}</span>
          <span class="tl-task-id">id: {{ task.id }}</span>
        </div>

        <!-- Segments area -->
        <div class="tl-segments" :style="{ width: timelineWidth + 'px' }">
          <!-- Day grid lines -->
          <template v-for="tick in rulerTicks" :key="'grid-' + tick.x">
            <div
              v-if="tick.major"
              class="tl-grid-line"
              :style="{ left: tick.x + 'px' }"
            />
          </template>

          <!-- Overlap regions -->
          <template v-for="ov in overlaps" :key="`ov-${ov.taskA}-${ov.taskB}-${ov.start}`">
            <template v-if="ov.taskA === taskIdx || ov.taskB === taskIdx">
              <div
                class="tl-overlap-region"
                :style="{
                  left: secondToX(ov.start) + 'px',
                  width: (secondToX(ov.end) - secondToX(ov.start)) + 'px',
                }"
              >
                <span class="tl-overlap-badge">
                  ⚠ {{ formatOverlap(ov.end - ov.start) }}
                </span>
              </div>
            </template>
          </template>

          <!-- Limit masks（超出 limit 范围的禁止编辑遮罩）-->
          <template v-if="taskLimits[task.id]">
            <!-- 左侧禁区（limit 开始之前）-->
            <div
              class="tl-limit-mask"
              :style="{
                left: '0',
                width: Math.max(0, secondToX(taskLimits[task.id][0])) + 'px',
              }"
            />
            <!-- 右侧禁区（limit 结束之后）-->
            <div
              class="tl-limit-mask"
              :style="{
                left: secondToX(taskLimits[task.id][1]) + 'px',
                right: '0',
                width: 'auto',
              }"
            />
          </template>

          <!-- Bar segments -->
          <template v-for="(seg, segIdx) in task.segments" :key="segIdx">
            <div
              class="tl-bar"
              :style="{
                left: secondToX(seg.startTime) + 'px',
                width: (secondToX(seg.endTime) - secondToX(seg.startTime)) + 'px',
                background: `linear-gradient(180deg, ${task.color} 0%, ${task.colorEnd} 100%)`,
              }"
              @mousedown="onBarMousedown($event, taskIdx, segIdx)"
            />

            <!-- Left handle -->
            <div
              class="tl-handle tl-handle--left"
              :style="{
                left: (secondToX(seg.startTime) - 7) + 'px',
                borderColor: task.color,
              }"
              @mousedown.stop="onHandleMousedown($event, taskIdx, segIdx, 'left')"
            />

            <!-- Right handle -->
            <div
              class="tl-handle tl-handle--right"
              :style="{
                left: (secondToX(seg.endTime) - 7) + 'px',
                borderColor: task.color,
              }"
              @mousedown.stop="onHandleMousedown($event, taskIdx, segIdx, 'right')"
            />

            <!-- Time labels -->
            <span
              class="tl-time-label tl-time-label--left"
              :style="{
                left: secondToX(seg.startTime) + 'px',
                color: task.color,
              }"
              @click.stop="openEditDialog(taskIdx, segIdx)"
            >{{ formatSecond(seg.startTime) }}</span>
            <span
              class="tl-time-label tl-time-label--right"
              :style="{
                left: secondToX(seg.endTime) + 'px',
                color: task.color,
              }"
              @click.stop="openEditDialog(taskIdx, segIdx)"
            >{{ formatSecond(seg.endTime) }}</span>
          </template>
        </div>
      </div>

      </div><!-- /.tl-scroll-inner -->
    </div>

    <!-- ── Time navigator scrollbar ── -->
    <div class="tl-nav-scrollbar">
      <div class="tl-nav-spacer">
        <div class="tl-zoom-btns">
          <button class="tl-zoom-btn" title="缩小" @click="onZoom(1)">−</button>
          <button class="tl-zoom-btn" title="放大" @click="onZoom(-1)">+</button>
        </div>
      </div>
      <div class="tl-nav-track" @click="onScrollTrackClick">
        <div
          class="tl-nav-thumb"
          :style="{ left: thumbLeft + 'px', width: thumbWidth + 'px' }"
          @mousedown="onScrollThumbMousedown"
        />
      </div>
    </div>

    <!-- ── Edit Dialog ── -->
    <ElDialog
      v-model="dialogVisible"
      title="编辑时间范围"
      width="640px"
      class="tl-dialog"
    >
      <template v-if="editingTask">
        <div class="tl-dialog-meta">
          {{ editingTask.name }} · id: {{ editingTask.id }}
        </div>

        <!-- 拆分方式（置顶） -->
        <div class="tl-dialog-split">
          <label>拆分方式</label>
          <ElRadioGroup v-model="splitMode" size="small">
            <ElRadioButton value="none">不拆分</ElRadioButton>
            <ElRadioButton value="2">拆分 2 段</ElRadioButton>
            <ElRadioButton value="3">拆分 3 段</ElRadioButton>
          </ElRadioGroup>
        </div>

        <!-- 不拆分：两个文本输入框 -->
        <template v-if="splitMode === 'none'">
          <div class="tl-dialog-row">
            <div class="tl-dialog-field">
              <label>开始时间</label>
              <ElInput v-model="editStart" placeholder="YYYY-MM-DD HH:mm:ss" class="tl-dt-input" />
            </div>
            <div class="tl-dialog-field">
              <label>结束时间</label>
              <ElInput v-model="editEnd" placeholder="YYYY-MM-DD HH:mm:ss" class="tl-dt-input" />
            </div>
          </div>
        </template>

        <!-- 拆分模式：每段两个输入框 -->
        <template v-else>
          <div class="tl-split-segs">
            <div
              v-for="(s, i) in splitSegs"
              :key="i"
              class="tl-split-seg-row"
            >
              <div class="tl-split-seg-tag">段 {{ i + 1 }}</div>
              <ElInput v-model="s.start" placeholder="YYYY-MM-DD HH:mm:ss" class="tl-dt-input" />
              <span class="tl-seg-sep">至</span>
              <ElInput v-model="s.end" placeholder="YYYY-MM-DD HH:mm:ss" class="tl-dt-input" />
            </div>
          </div>
        </template>

        <div class="tl-dialog-duration" v-if="editingTask.segments[editingSegIdx]">
          总持续时长：<span class="tl-duration-val">{{
            formatDuration(editingTask.segments[editingSegIdx].endTime - editingTask.segments[editingSegIdx].startTime)
          }}</span>
        </div>
        <div class="tl-dialog-bounds" v-if="currentTaskLimitSec">
          限制范围：{{ formatSecond(currentTaskLimitSec[0]) }} ~ {{ formatSecond(currentTaskLimitSec[1]) }}
        </div>
        <div class="tl-dialog-bounds" v-else>
          可用范围：{{ formatSecond(dataBounds.min) }} ~ {{ formatSecond(dataBounds.max) }}
        </div>
        <div class="tl-dialog-error" v-if="dialogError">{{ dialogError }}</div>
      </template>
      <template #footer>
        <ElButton @click="dialogVisible = false">取消</ElButton>
        <ElButton type="primary" @click="onConfirm">确认</ElButton>
      </template>
    </ElDialog>
    </div><!-- /.tl-root -->

    <template #footer>
      <ElButton @click="localVisible = false">取消</ElButton>
      <ElButton type="primary" @click="onOuterConfirm">确认</ElButton>
    </template>
  </ElDialog>
</template>

<style scoped>
/* ── Root ── */
.tl-root {
  font-family: 'Inter', 'PingFang SC', sans-serif;
  background: #0F1629;
  color: #CBD5E1;
  min-width: 800px;
  position: relative;
  user-select: none;
  display: flex;
  flex-direction: column;
  flex: 1;       /* 作为 .el-dialog__body flex 容器的子项，撑满可用高度 */
  min-height: 0; /* 允许 flex 压缩，height:100% 在 flex 子项中无法解析 */
}

/* ── Main ── */
.tl-main {
  position: relative;
  overflow-x: hidden;
  overflow-y: auto;
  flex: 1;
  min-height: 0; /* flex 容器内必须，否则 overflow 不生效 */
}

/* Pan cursor on background */
.tl-scroll-inner { cursor: grab; }
.tl-main--panning .tl-scroll-inner { cursor: grabbing; }
/* But keep bar/handle/label cursors */
.tl-main--panning .tl-bar,
.tl-main--panning .tl-handle { cursor: inherit; }

.tl-scroll-inner {
  min-width: 900px;
  position: relative;
}

/* ── Time navigator scrollbar ── */
.tl-nav-scrollbar {
  display: flex;
  align-items: center;
  background: #0A1020;
  border-top: 1px solid #1A2240;
  height: 22px;
  padding: 6px 8px 6px 0;
  user-select: none;
}
.tl-nav-spacer {
  width: 172px;
  min-width: 172px;
  flex-shrink: 0;
  border-right: 1px solid #2D3B5E;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding-right: 6px;
  gap: 4px;
}
.tl-zoom-btns {
  display: flex;
  gap: 4px;
}
.tl-zoom-btn {
  width: 22px;
  height: 18px;
  background: #1A2A4A;
  border: 1px solid #2D3B5E;
  border-radius: 4px;
  color: #7A9CC6;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: background 0.15s, color 0.15s;
}
.tl-zoom-btn:hover  { background: #253650; color: #A8C4E0; }
.tl-zoom-btn:active { background: #2D4A6A; }
.tl-nav-track {
  flex: 1;
  height: 6px;
  background: #1A2240;
  border-radius: 3px;
  position: relative;
  cursor: pointer;
  margin: 0 4px;
}
.tl-nav-thumb {
  position: absolute;
  top: 0;
  height: 100%;
  background: #3D5A80;
  border-radius: 3px;
  cursor: grab;
  transition: background 0.15s;
  min-width: 40px;
}
.tl-nav-thumb:hover { background: #507DAE; }
.tl-nav-thumb:active { cursor: grabbing; background: #6196C6; }

/* ── 竖向滚动条（与横向导航条同色系）── */
.tl-main::-webkit-scrollbar {
  width: 6px;
}
.tl-main::-webkit-scrollbar-track {
  background: #1A2240;
  border-radius: 3px;
}
.tl-main::-webkit-scrollbar-thumb {
  background: #3D5A80;
  border-radius: 3px;
}
.tl-main::-webkit-scrollbar-thumb:hover {
  background: #507DAE;
}
.tl-main::-webkit-scrollbar-thumb:active {
  background: #6196C6;
}

/* ── Ruler ── */
.tl-ruler-row {
  display: flex;
  background: #0C1525;
  height: 39px;
  position: sticky;
  top: 0;
  z-index: 10; /* 标尺行固定在滚动区顶部，高于任务行 */
  position: relative;
}

.tl-label-cell {
  width: 172px;
  min-width: 172px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 0 14px;
}

.tl-ruler {
  flex: 1;
  position: relative;
  overflow: hidden;
}

.tl-tick {
  position: absolute;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  top: 0;
}

.tl-tick-label {
  font-size: 10px;
  line-height: 1.3;
  text-align: center;
  display: block;
}

.tl-tick--major .tl-tick-label { color: #94A3B8; }
.tl-tick--minor .tl-tick-label { color: #3D4F6B; }

.tl-tick-line {
  width: 1px;
  height: 6px;
  background: #2D3B5E;
  margin-top: 2px;
}

/* ── Row ── */
.tl-row {
  display: flex;
  height: 104px;
  position: relative;
}

.tl-row--odd  { background: #1E2845; }
.tl-row--even { background: #1A2240; }

.tl-row-divider {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: #2D3B5E;
  z-index: 2;
}

.tl-task-name {
  font-size: 14px;
  font-weight: 600;
  color: #CBD5E1;
}

.tl-task-id {
  font-size: 11px;
  color: #475569;
  margin-top: 4px;
}

/* ── Label cell sticky ── */
.tl-label-cell {
  position: sticky;
  left: 0;
  z-index: 3;
  border-right: 1px solid #2D3B5E;
}

.tl-ruler-row .tl-label-cell  { background: #0C1525; }
.tl-row--odd  .tl-label-cell  { background: #1E2845; }
.tl-row--even .tl-label-cell  { background: #1A2240; }

/* ── Segments area ── */
.tl-segments {
  position: relative;
  height: 100%;
  overflow: visible;
  z-index: 1; /* 形成独立层叠上下文，使内部元素低于标签列（z-index: 3）*/
}

/* ── Grid line ── */
.tl-grid-line {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: #243050;
  pointer-events: none;
}

/* ── Bar ── */
.tl-bar {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  height: 28px;
  border-radius: 14px;
  cursor: grab;
  z-index: 2;
  transition: filter 0.15s;
}

.tl-bar:active {
  cursor: grabbing;
}

.tl-bar:hover {
  filter: brightness(1.1);
}

/* ── Handles ── */
.tl-handle {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid;
  cursor: ew-resize;
  z-index: 5;
}

/* ── Time labels ── */
.tl-time-label {
  position: absolute;
  top: calc(50% + 18px);
  font-size: 10px;
  white-space: nowrap;
  cursor: pointer;
}

.tl-time-label--left  { transform: translateX(-50%); }
.tl-time-label--right { transform: translateX(-50%); }

.tl-time-label:hover {
  text-decoration: underline;
}

/* ── Overlap region ── */
.tl-overlap-region {
  position: absolute;
  top: calc(50% - 14px);
  height: 28px;
  background: rgba(239, 68, 68, 0.35);
  border-left: 1px solid rgba(239, 68, 68, 0.7);
  border-right: 1px solid rgba(239, 68, 68, 0.7);
  z-index: 4;
  pointer-events: none;
}

.tl-limit-mask {
  position: absolute;
  top: 0; bottom: 0;
  background: repeating-linear-gradient(
    -45deg,
    rgba(0, 0, 0, 0.32),
    rgba(0, 0, 0, 0.32) 4px,
    transparent 4px,
    transparent 8px
  );
  pointer-events: none;
  z-index: 2;
}

.tl-overlap-badge {
  position: absolute;
  top: -20px;
  left: 50%;
  transform: translateX(-50%);
  background: #EF4444;
  border-radius: 4px;
  font-size: 10px;
  color: #fff;
  padding: 1px 5px;
  white-space: nowrap;
  pointer-events: none;
}

/* ── Dialog ── */
:deep(.tl-dialog) {
  --el-dialog-bg-color: #1A2240;
  --el-dialog-title-font-size: 15px;
  --el-dialog-border-radius: 8px;
  --el-color-primary: #3B82F6;
  --el-text-color-primary: #CBD5E1;
  --el-text-color-regular: #94A3B8;
  --el-border-color: #2D3B5E;
  --el-fill-color-blank: #0F1629;
  --el-input-text-color: #CBD5E1;
  --el-input-bg-color: #0C1525;
  --el-input-border-color: #2D3B5E;
  --el-input-focus-border-color: #3B82F6;
  --el-button-bg-color: #1E2845;
  --el-button-border-color: #2D3B5E;
  --el-button-text-color: #94A3B8;
}

.tl-dialog-meta {
  font-size: 12px;
  color: #475569;
  margin-bottom: 16px;
}

.tl-dialog-row {
  display: flex;
  gap: 16px;
}

.tl-dialog-field {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tl-dialog-field label {
  font-size: 12px;
  color: #94A3B8;
}

/* 暗色输入框 */
:deep(.tl-dt-input .el-input__wrapper) {
  background: #0C1525;
  box-shadow: 0 0 0 1px #2D3B5E inset;
}
:deep(.tl-dt-input .el-input__wrapper:hover) {
  box-shadow: 0 0 0 1px #3B82F6 inset;
}
:deep(.tl-dt-input.el-input--focused .el-input__wrapper),
:deep(.tl-dt-input .el-input__wrapper.is-focus) {
  box-shadow: 0 0 0 1px #3B82F6 inset;
}
:deep(.tl-dt-input .el-input__inner) {
  color: #CBD5E1;
  background: transparent;
  font-size: 13px;
  font-family: 'JetBrains Mono', 'Menlo', monospace;
  letter-spacing: 0.3px;
}
:deep(.tl-dt-input .el-input__inner::placeholder) {
  color: #344060;
}

.tl-dt-input {
  flex: 1;
}

.tl-seg-sep {
  color: #64748B;
  font-size: 13px;
  align-self: center;
  flex-shrink: 0;
}

.tl-dialog-duration {
  margin-top: 16px;
  font-size: 13px;
  color: #94A3B8;
}

.tl-duration-val {
  color: #34D399;
  font-weight: 600;
}

.tl-dialog-bounds {
  margin-top: 8px;
  font-size: 12px;
  color: #64748B;
}

.tl-dialog-error {
  margin-top: 6px;
  font-size: 12px;
  color: #EF4444;
}

.tl-dialog-split {
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  gap: 12px;
}

.tl-dialog-split label {
  font-size: 12px;
  color: #94A3B8;
  white-space: nowrap;
}

/* ── Split segments (split mode) ── */
.tl-split-segs {
  margin-top: 6px;
}

.tl-split-seg-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 0;
  border-top: 1px solid #1A2845;
}

.tl-split-seg-row:first-child {
  border-top: none;
  padding-top: 6px;
}

.tl-split-seg-tag {
  font-size: 11px;
  font-weight: 600;
  color: #60A5FA;
  background: rgba(59, 130, 246, 0.12);
  border-radius: 4px;
  padding: 3px 8px;
  white-space: nowrap;
  align-self: center;
  flex-shrink: 0;
  min-width: 46px;
  text-align: center;
}

:deep(.tl-dialog .el-radio-button__inner) {
  background: #1E2845;
  border-color: #2D3B5E;
  color: #94A3B8;
}

:deep(.tl-dialog .el-radio-button__original-radio:checked + .el-radio-button__inner) {
  background: #3B82F6;
  border-color: #3B82F6;
  color: #fff;
  box-shadow: none;
}
</style>

<!-- Global dialog dark theme overrides (dialog renders inside component, no append-to-body) -->
<style>
/* ── 外层弹窗：全局样式（append-to-body teleport 到 body，scoped 不可达）── */
.tl-outer-dialog.el-dialog {
  max-height: 90vh;
  margin: 5vh auto;           /* 覆盖 Element Plus 默认 margin-top: 15vh，5+90+5=100vh 不超出 */
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.tl-outer-dialog.el-dialog .el-dialog__body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 0;
  display: flex;              /* 让子元素 .tl-root 能用 flex: 1 解析高度 */
  flex-direction: column;
}

.tl-dialog.el-dialog {
  background: #1A2240;
  border: 1px solid #2D3B5E;
  border-radius: 8px;
}

.tl-dialog .el-dialog__title {
  color: #CBD5E1;
  font-size: 15px;
  font-weight: 600;
}

.tl-dialog .el-dialog__headerbtn .el-icon {
  color: #475569;
}

.tl-dialog .el-dialog__headerbtn:hover .el-icon {
  color: #94A3B8;
}

.tl-dialog .el-dialog__body {
  color: #94A3B8;
  padding: 20px 20px 10px;
}

.tl-dialog .el-dialog__footer {
  border-top: 1px solid #2D3B5E;
  padding: 12px 20px;
}

.tl-dialog .el-button {
  background: #1E2845;
  border-color: #2D3B5E;
  color: #94A3B8;
}

.tl-dialog .el-button:hover {
  background: #2D3B5E;
  border-color: #3B82F6;
  color: #CBD5E1;
}

.tl-dialog .el-button--primary {
  background: #3B82F6 !important;
  border-color: #3B82F6 !important;
  color: #fff !important;
}

.tl-dialog .el-button--primary:hover {
  background: #60A5FA !important;
  border-color: #60A5FA !important;
}

.tl-dialog .el-radio-button__inner {
  background: #1E2845;
  border-color: #2D3B5E;
  color: #94A3B8;
}

.tl-dialog .el-radio-button .el-radio-button__original-radio:checked + .el-radio-button__inner {
  background: #3B82F6;
  border-color: #3B82F6;
  color: #fff;
  box-shadow: none;
}

.tl-dialog .el-overlay {
  background: rgba(0, 0, 0, 0.6);
}
</style>
