/** 时间原点：2026-05-15 00:00:00 本地时间（内部秒偏移量以此为基准）*/
export const ORIGIN = new Date(2026, 4, 15).getTime()

export interface TimeSegment {
  startTime: number  // Unix ms 时间戳
  endTime: number    // Unix ms 时间戳
}

export interface TimeTask {
  id: string
  name: string
  color: string
  colorEnd: string
  segments: TimeSegment[]
  /**
   * 可选：该任务可编辑的时间范围约束（Unix ms 时间戳）。
   * 启用 enforceLimit 后，拖拽和编辑均不可超出此范围。
   */
  limit?: TimeSegment
}

/** 外层确认时每个任务的输出结构 */
export interface TaskResult {
  /** 各段最终时间区间（Unix ms 时间戳对）*/
  segments: [number, number][]
  /** 相对于传入时是否发生改动（trackDirty !== false 时有效）*/
  isDirty: boolean
}

export function defaultTasks(): TimeTask[] {
  // d(h, m, s) → seconds from 2026-05-15 00:00:00
  // d(h, m, s) → Unix ms 时间戳（从 2026-05-15 00:00 偏移）
  const d = (h: number, m = 0, s = 0) => ORIGIN + (h * 3600 + m * 60 + s) * 1000

  return [
    // ── 单段：跨天，与 B 有重叠 / 限制在 5/15~5/17 内编辑 ──
    {
      id: '001', name: '任务 A',
      color: '#60A5FA', colorEnd: '#2563EB',
      segments: [{ startTime: d(18), endTime: d(42) }],         // 5/15 18:00 ~ 5/16 18:00
      limit: { startTime: d(18), endTime: d(42) },               // 限制：5/15 00:00 ~ 5/17 00:00
    },
    // ── 单段：与 A、C 均重叠 / 限制在 5/16 内 ──────────────
    {
      id: '002', name: '任务 B',
      color: '#34D399', colorEnd: '#059669',
      segments: [{ startTime: d(30), endTime: d(54) }],         // 5/16 06:00 ~ 5/17 06:00
      limit: { startTime: d(24), endTime: d(72) },              // 限制：5/16 00:00 ~ 5/18 00:00
    },
    // ── 单段：与 B 末段重叠 ──────────────────────────────────
    {
      id: '003', name: '任务 C',
      color: '#FCD34D', colorEnd: '#D97706',
      segments: [{ startTime: d(45), endTime: d(66) }],         // 5/16 21:00 ~ 5/17 18:00
    },
    // ── 单段：较短，仅在第一天 / 限制在 5/15 内 ────────────
    {
      id: '004', name: '任务 D',
      color: '#A78BFA', colorEnd: '#7C3AED',
      segments: [{ startTime: d(9), endTime: d(27) }],          // 5/15 09:00 ~ 5/16 03:00
      limit: { startTime: d(0), endTime: d(36) },               // 限制：5/15 00:00 ~ 5/16 12:00
    },
    // ── 多段（三段不连续）────────────────────────────────────
    {
      id: '005', name: '任务 E（多段）',
      color: '#F472B6', colorEnd: '#BE185D',
      segments: [
        { startTime: d(6),  endTime: d(14) },                   // 5/15 06:00 ~ 14:00
        { startTime: d(36), endTime: d(48) },                   // 5/16 12:00 ~ 5/17 00:00
        { startTime: d(72), endTime: d(84) },                   // 5/18 00:00 ~ 12:00
      ],
    },
    // ── 多段（两段）+ 短段测试 ────────────────────────────────
    {
      id: '006', name: '任务 F（短段）',
      color: '#FB923C', colorEnd: '#C2410C',
      segments: [
        { startTime: d(24 + 6, 30), endTime: d(24 + 8) },      // 5/16 06:30 ~ 08:00（1.5h）
        { startTime: d(24 * 3),     endTime: d(24 * 3 + 14) }, // 5/18 00:00 ~ 14:00
      ],
    },
    // ── 超长段：跨三天 ───────────────────────────────────────
    {
      id: '007', name: '任务 G（长跨度）',
      color: '#22D3EE', colorEnd: '#0E7490',
      segments: [{ startTime: d(48), endTime: d(120) }],        // 5/17 00:00 ~ 5/20 00:00
    },
    // ── 末段：第 6~7 天 ──────────────────────────────────────
    {
      id: '008', name: '任务 H（末段）',
      color: '#86EFAC', colorEnd: '#15803D',
      segments: [{ startTime: d(24 * 5 + 12), endTime: d(24 * 6 + 6) }], // 5/20 12:00 ~ 5/21 06:00
    },
    // ── 多段密集，前两段与 E 有重叠 ─────────────────────────
    {
      id: '009', name: '任务 I（密集）',
      color: '#C084FC', colorEnd: '#7E22CE',
      segments: [
        { startTime: d(4),      endTime: d(10) },               // 5/15 04:00 ~ 10:00 (与E段1重叠)
        { startTime: d(38),     endTime: d(50) },               // 5/16 14:00 ~ 5/17 02:00
        { startTime: d(24 * 4 + 8), endTime: d(24 * 4 + 20) }, // 5/19 08:00 ~ 20:00
      ],
    },
    // ── 仅夜间段 ────────────────────────────────────────────
    {
      id: '010', name: '任务 J（夜间）',
      color: '#FDA4AF', colorEnd: '#9F1239',
      segments: [
        { startTime: d(22),         endTime: d(24 + 4) },       // 5/15 22:00 ~ 5/16 04:00
        { startTime: d(24 * 2 + 22), endTime: d(24 * 3 + 4) }, // 5/17 22:00 ~ 5/18 04:00
        { startTime: d(24 * 4 + 22), endTime: d(24 * 5 + 4) }, // 5/19 22:00 ~ 5/20 04:00
      ],
    },
  ]
}
