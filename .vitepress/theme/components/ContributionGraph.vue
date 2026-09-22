<script setup lang="ts">
import { computed } from "vue";
import data from "../../generated/contributions.json";

interface DayCount {
  date: string;
  count: number;
}

interface Cell {
  date: string;
  count: number;
  level: number;
  tip: string;
  today: boolean;
}

const DAY = 86_400_000;

// 数据为"当日文档修改篇次"，5 档着色阈值对齐个人知识库的修改频次
function levelOf(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 6) return 3;
  return 4;
}

const byDate = computed(() => {
  const map = new Map<string, number>();
  for (const d of (data as { days: DayCount[] }).days ?? []) {
    map.set(d.date, d.count);
  }
  return map;
});

// 全程使用 UTC 计算（正午时间戳），避免时区与夏令时导致格子错位
const cells = computed<Cell[][]>(() => {
  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12);
  const start = end - 52 * 7 * DAY; // 53 周
  const startAligned = start - new Date(start).getUTCDay() * DAY; // 对齐到周日

  const weeks: Cell[][] = [];
  for (let t = startAligned; t <= end; t += DAY) {
    const d = new Date(t);
    if (d.getUTCDay() === 0) weeks.push([]); // 每周从周日开始新列（startAligned 已对齐周日，首格必触发）
    const key = d.toISOString().slice(0, 10);
    const count = byDate.value.get(key) ?? 0;
    const cn = `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
    weeks[weeks.length - 1].push({
      date: key,
      count,
      level: levelOf(count),
      tip: count > 0 ? `${count} 篇文档修改 · ${cn}` : `${cn} 无修改`,
      today: key === todayKey,
    });
  }
  return weeks;
});

// 月份标签：每列取首格，月份变化处显示标签，与网格逐列对齐
const monthLabels = computed<string[]>(() => {
  const labels: string[] = [];
  let lastMonth = -1;
  for (const week of cells.value) {
    if (week.length === 0) continue;
    const d = new Date(week[0].date + "T12:00:00Z");
    const month = d.getUTCMonth();
    labels.push(month !== lastMonth ? `${month + 1}月` : "");
    lastMonth = month;
  }
  return labels;
});

const total = computed(() =>
  ((data as { days: DayCount[] }).days ?? []).reduce((sum, d) => sum + d.count, 0),
);
</script>

<template>
  <div class="contrib-graph">
    <div class="contrib-header">
      <span class="contrib-title">文档更新动态</span>
      <span class="contrib-total">过去一年共 {{ total }} 次文档修改</span>
    </div>

    <div class="contrib-scroll">
      <div class="contrib-inner">
        <div class="contrib-months" aria-hidden="true">
          <span
            v-for="(label, i) in monthLabels"
            :key="i"
            class="contrib-month"
            :class="{ visible: label }"
            >{{ label || "·" }}</span
          >
        </div>
        <div class="contrib-body">
          <div class="contrib-weekdays" aria-hidden="true">
            <span v-for="i in 7" :key="i" class="contrib-weekday">{{
              ["", "一", "", "三", "", "五", ""][i - 1]
            }}</span>
          </div>
          <div class="contrib-grid">
            <div v-for="(week, wi) in cells" :key="wi" class="contrib-col">
              <span
                v-for="cell in week"
                :key="cell.date"
                class="contrib-cell"
                :class="[`l${cell.level}`, { today: cell.today }]"
                :data-tip="cell.tip"
              ></span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="contrib-footer">
      <span>由 git 提交记录生成</span>
      <span class="contrib-legend">
        少
        <span class="contrib-cell l0"></span>
        <span class="contrib-cell l1"></span>
        <span class="contrib-cell l2"></span>
        <span class="contrib-cell l3"></span>
        <span class="contrib-cell l4"></span>
        多
      </span>
    </div>
  </div>
</template>

<style scoped>
.contrib-graph {
  margin: 0 0 24px;
  padding: 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
}

.contrib-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.contrib-title {
  font-weight: 600;
  font-size: 15px;
}

.contrib-total {
  font-size: 13px;
  color: var(--vp-c-text-2);
}

.contrib-scroll {
  overflow-x: auto;
  /* 左右留白：避免首尾列的悬浮 tooltip 被滚动裁剪 */
  padding: 0 24px 4px;
}

.contrib-inner {
  display: inline-block;
  min-width: 100%;
}

/* 月份行与网格逐列对齐：左偏移 = 星期标签列宽 + 间距，每格宽 = 格子 + 列间距 */
.contrib-months {
  display: flex;
  margin: 0 0 2px 23px;
}

.contrib-month {
  width: 15px;
  font-size: 11px;
  color: var(--vp-c-text-3);
  visibility: hidden;
  flex-shrink: 0;
}

.contrib-month.visible {
  visibility: visible;
}

.contrib-body {
  display: flex;
  gap: 3px;
}

.contrib-weekdays {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 20px;
  flex-shrink: 0;
}

.contrib-weekday {
  height: 12px;
  line-height: 12px;
  font-size: 10px;
  color: var(--vp-c-text-3);
}

.contrib-grid {
  display: flex;
  gap: 3px;
}

.contrib-col {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.contrib-cell {
  position: relative;
  width: 12px;
  height: 12px;
  border-radius: 2px;
  flex-shrink: 0;
  background: var(--tk-contrib-l0);
}

.contrib-cell.l1 {
  background: var(--tk-contrib-l1);
}

.contrib-cell.l2 {
  background: var(--tk-contrib-l2);
}

.contrib-cell.l3 {
  background: var(--tk-contrib-l3);
}

.contrib-cell.l4 {
  background: var(--tk-contrib-l4);
}

/* 今天的格子加高亮描边（GitHub 做法） */
.contrib-cell.today {
  outline: 1px solid var(--vp-c-text-2);
  outline-offset: 1px;
}

/* 悬浮 tooltip：纯 CSS 深色小卡，显示在格子正上方（两种主题下均为深色底） */
.contrib-cell::after {
  content: attr(data-tip);
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%) translateY(2px);
  padding: 5px 9px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.85);
  color: #fff;
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.1s ease;
  z-index: 10;
}

.contrib-cell:hover::after {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

.contrib-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
  font-size: 12px;
  color: var(--vp-c-text-3);
}

.contrib-legend {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

@media (max-width: 768px) {
  .contrib-cell {
    width: 10px;
    height: 10px;
  }

  .contrib-month {
    width: 13px;
  }

  .contrib-weekday {
    height: 10px;
    line-height: 10px;
  }
}
</style>
