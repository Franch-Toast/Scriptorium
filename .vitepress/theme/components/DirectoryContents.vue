<script setup lang="ts">
import { computed } from "vue";
import { data as documents } from "../directory.data.mts";
import DirectoryTreeNode from "./DirectoryTreeNode.vue";
import type { DirectoryTreeNode as TreeNode } from "./DirectoryTreeNode.vue";

const props = defineProps<{ root: string }>();
const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

const normalizePath = (value: string) => {
  const decoded = decodeURIComponent(value).replace(/\.html$/, "").replace(/\/$/, "");
  return decoded.startsWith("/") ? decoded : `/${decoded}`;
};

// 构建期数据在模块加载时已就绪（createContentLoader 产物），此处仅做
// 一级收录：root 下的散文档直接入列；子目录聚合为一个节点且不再下钻，
// 若该目录存在 index.md 则节点可点击（标题/描述取自 index）。
const entries = computed<TreeNode[]>(() => {
  const root = normalizePath(props.root);
  const nodes: TreeNode[] = [];

  const folderOf = (name: string) => {
    let folder = nodes.find(node => node.type === "folder" && node.name === name);
    if (!folder) {
      folder = { type: "folder", name };
      nodes.push(folder);
    }
    return folder;
  };

  for (const document of documents as { url: string; title?: string; description?: string }[]) {
    // 目录 index 的 url 是尾斜杠形态（/xxx/），散文档为 .html 形态
    const isDirIndex = document.url.endsWith("/");
    const documentPath = normalizePath(document.url);
    if (!documentPath.startsWith(`${root}/`)) continue;

    const relativeParts = documentPath.slice(root.length + 1).split("/").filter(Boolean);
    if (!relativeParts.length) continue;

    if (relativeParts.length === 1) {
      if (isDirIndex) {
        // 库自身 index 已被上方 startsWith(root/) 排除；能走到这里的
        // 尾斜杠 url 都是一级子目录的 index.md → 目录节点可点击
        const folder = folderOf(relativeParts[0]);
        folder.url = document.url;
        folder.title = document.title || folder.name;
        folder.description = document.description;
        continue;
      }
      nodes.push({
        type: "document",
        name: relativeParts[0],
        title: document.title || relativeParts[0],
        description: document.description,
        url: document.url,
      });
      continue;
    }

    // 更深层文档只用于聚合出一级子目录名，不再下钻
    folderOf(relativeParts[0]);
  }

  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return collator.compare(a.title || a.name, b.title || b.name);
  });
  return nodes;
});
</script>

<template>
  <DirectoryTreeNode v-if="entries.length" :nodes="entries" />
  <p v-else class="directory-empty">暂无内容，等待填充。</p>
</template>

<style scoped>
.directory-empty {
  color: var(--vp-c-text-2);
}
</style>
