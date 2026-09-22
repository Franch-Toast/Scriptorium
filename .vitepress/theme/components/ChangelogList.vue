<script setup lang="ts">
import { computed } from "vue";
import { withBase } from "vitepress";
import { data as posts } from "../posts.data.mts";
import updates from "../../generated/docs-updates.json";

interface Post {
  url: string;
  excerpt?: string;
  frontmatter: {
    title?: string;
    date?: string;
    description?: string;
    categories?: string[];
    tags?: string[];
  };
}

interface DocUpdate {
  file: string;
  lastDate: string;
}

const norm = (url: string) => decodeURIComponent(url).replace(/\.html$/, "");

// docs-updates.json 的 file（"docs/xx/yy.md"）规范化为与 post.url 同口径的 "/xx/yy"
const lastDates = computed(() => {
  const map = new Map<string, string>();
  for (const d of (updates as { docs: DocUpdate[] }).docs ?? []) {
    map.set(`/${d.file.slice(5).replace(/\.md$/, "")}`, d.lastDate);
  }
  return map;
});

// 一级目录名 -> 展示名
const LIB_NAMES: [string, string][] = [
  ["撷简台", "撷简台（inbox）"],
  ["撰修司", "撰修司（projects）"],
  ["正典阁", "正典阁（knowledge）"],
  ["纪事寮", "纪事寮（experience）"],
  ["资简库", "资简库（assets）"],
  ["秘藏龛", "秘藏龛（archive）"],
];

const libOf = (url: string) => {
  // URL 形如 /document/<分区>/...，分区名在第三段
  const seg = norm(url).split("/")[2] ?? "";
  return LIB_NAMES.find(([prefix]) => seg.startsWith(prefix))?.[1] ?? "未分类";
};

// 摘要：frontmatter.description 优先，无则回退 <!-- more --> 前的正文摘录
const descOf = (p: Post) =>
  (p.frontmatter.description ?? "").trim() || p.excerpt || "";

// 按最后提交时间倒序（git 数据缺失时回退 frontmatter.date）
const sorted = computed(() =>
  ((posts as unknown as Post[]) ?? [])
    .map(p => ({
      ...p,
      lastDate: lastDates.value.get(norm(p.url)) ?? String(p.frontmatter.date).slice(0, 10),
    }))
    .sort((a, b) => (a.lastDate.slice(0, 10) < b.lastDate.slice(0, 10) ? 1 : -1)),
);

// 按年份分组，插入年份分隔标题，长列表保留时间锚点
const grouped = computed(() => {
  const groups: { year: string; items: (Post & { lastDate: string })[] }[] = [];
  for (const p of sorted.value) {
    const year = p.lastDate.slice(0, 10).slice(0, 4);
    const last = groups[groups.length - 1];
    if (last && last.year === year) last.items.push(p);
    else groups.push({ year, items: [p] });
  }
  return groups;
});

const monthDay = (date: string) => {
  const [, m, d] = date.slice(0, 10).split("-");
  return `${Number(m)} 月 ${Number(d)} 日`;
};
</script>

<template>
  <div class="changelog">
    <template v-for="group in grouped" :key="group.year">
      <h2 class="changelog-year">{{ group.year }} 年</h2>
      <a
        v-for="post in group.items"
        :key="post.url"
        class="changelog-card"
        :href="withBase(post.url)"
      >
        <div class="changelog-meta">
          <span class="changelog-lib">{{ libOf(post.url) }}</span>
          <time class="changelog-time">{{ monthDay(post.lastDate) }} 更新</time>
        </div>
        <span class="changelog-title">{{ post.frontmatter.title || "未命名文档" }}</span>
        <div v-if="descOf(post)" class="changelog-excerpt" v-html="descOf(post)"></div>
        <div class="changelog-badges">
          <span
            v-for="c in post.frontmatter.categories ?? []"
            :key="`c-${c}`"
            class="changelog-badge cat"
            >{{ c }}</span
          >
          <span v-for="t in post.frontmatter.tags ?? []" :key="`t-${t}`" class="changelog-badge"
            ># {{ t }}</span
          >
        </div>
      </a>
    </template>
    <p v-if="!sorted.length" class="changelog-empty">暂无文档更新记录。</p>
  </div>
</template>

<style scoped>
.changelog-year {
  margin: 28px 0 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--vp-c-divider);
  text-align: center;
  font-size: 18px;
  font-weight: 600;
}

/* 整卡即链接：点击卡片任意位置跳转对应文档 */
.changelog-card {
  display: block;
  margin-bottom: 14px;
  padding: 16px 18px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  color: inherit;
  text-decoration: none;
  transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;
}

.changelog-card:hover {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.08);
  transform: translateY(-2px);
  text-decoration: none;
}

.changelog-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 12px;
}

.changelog-lib {
  padding: 1px 8px;
  border-radius: 10px;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  font-weight: 500;
}

.changelog-time {
  color: var(--vp-c-text-3);
}

.changelog-title {
  display: block;
  font-size: 17px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--vp-c-text-1);
  transition: color 0.2s ease;
}

.changelog-card:hover .changelog-title {
  color: var(--vp-c-brand-1);
}

/* 摘要小卡片：浅底 + 品牌色左边线，与卡片主体形成层次 */
.changelog-excerpt {
  margin: 10px 0 2px;
  padding: 8px 12px;
  border-left: 3px solid var(--vp-c-brand-1);
  border-radius: 6px;
  background: var(--vp-c-bg-soft);
  font-size: 13px;
  color: var(--vp-c-text-2);
}

/* v-html 注入的摘要内容重置文档级样式 */
.changelog-excerpt :deep(p) {
  margin: 0 0 4px;
  line-height: 1.7;
}

.changelog-excerpt :deep(p:last-child) {
  margin-bottom: 0;
}

.changelog-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.changelog-badge {
  padding: 1px 8px;
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  font-size: 12px;
  color: var(--vp-c-text-2);
}

.changelog-badge.cat {
  border-color: transparent;
}

.changelog-empty {
  color: var(--vp-c-text-3);
  font-size: 14px;
}
</style>
