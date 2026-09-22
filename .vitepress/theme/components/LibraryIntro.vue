<script setup lang="ts">
import { withBase } from "vitepress";
import { data as posts } from "../posts.data.mts";

// 六大分区介绍（dir 与 config.mts 的 libs 保持一致）
const LIBS = [
  {
    prefix: "撷简台",
    dir: "撷简台",
    title: "撷简台（inbox）",
    icon: "📥",
    desc: "快速捕获的碎片信息与待整理素材，定期清空归位",
  },
  {
    prefix: "撰修司",
    dir: "撰修司",
    title: "撰修司（projects）",
    icon: "🚀",
    desc: "正在进行的专项与项目文档，按主题组织推进",
  },
  {
    prefix: "正典阁",
    dir: "正典阁",
    title: "正典阁（knowledge）",
    icon: "📚",
    desc: "长期沉淀的技术栈、业务领域与通用能力笔记",
  },
  {
    prefix: "纪事寮",
    dir: "纪事寮",
    title: "纪事寮（experience）",
    icon: "🔍",
    desc: "踩坑记录、复盘与最佳实践，让教训不再重复",
  },
  {
    prefix: "资简库",
    dir: "资简库",
    title: "资简库（assets）",
    icon: "🧰",
    desc: "工具脚本、参考手册、文档模板与规范标准",
  },
  {
    prefix: "秘藏龛",
    dir: "秘藏龛",
    title: "秘藏龛（archive）",
    icon: "🗄️",
    desc: "完结项目与过时资料的最终归宿，历史可追溯",
  },
];

interface Post {
  url: string;
}

// 统计各库内容文档数（posts.data 已排除站点页与各库首页）
const libs = LIBS.map(l => ({
  ...l,
  count: (posts as unknown as Post[]).filter(p =>
    decodeURIComponent(p.url).startsWith(`/document/${l.prefix}`),
  ).length,
}));
</script>

<template>
  <div class="library-intro">
    <a v-for="lib in libs" :key="lib.dir" class="library-card" :href="withBase(`/document/${lib.dir}/`)">
      <div class="library-head">
        <span class="library-icon">{{ lib.icon }}</span>
        <span class="library-title">{{ lib.title }}</span>
        <span class="library-count">{{ lib.count }} 篇</span>
      </div>
      <p class="library-desc">{{ lib.desc }}</p>
      <span class="library-enter">进入 →</span>
    </a>
  </div>
</template>

<style scoped>
.library-intro {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
  margin: 16px 0;
}

.library-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.library-card:hover {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.06);
}

.library-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.library-icon {
  font-size: 18px;
}

.library-title {
  font-weight: 600;
  font-size: 15px;
  color: var(--vp-c-text-1);
}

.library-count {
  margin-left: auto;
  font-size: 12px;
  color: var(--vp-c-text-3);
}

.library-desc {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--vp-c-text-2);
}

.library-enter {
  margin-top: auto;
  font-size: 12px;
  color: var(--vp-c-brand-1);
}
</style>
