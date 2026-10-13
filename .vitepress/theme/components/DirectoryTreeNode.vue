<script setup lang="ts">
import { withBase } from "vitepress";

export interface DirectoryTreeNode {
  type: "folder" | "document";
  name: string;
  title?: string;
  description?: string;
  url?: string;
}

defineOptions({ name: "DirectoryTreeNode" });
defineProps<{ nodes: DirectoryTreeNode[] }>();
</script>

<template>
  <ul class="directory-tree">
    <li v-for="node in nodes" :key="`${node.type}:${node.url || node.name}`">
      <template v-if="node.type === 'folder'">
        <!-- 有 index.md 的子目录渲染为链接，否则仅显示目录名 -->
        <a v-if="node.url" class="directory-folder" :href="withBase(node.url)">{{ node.title || node.name }}</a>
        <span v-else class="directory-folder">{{ node.name }}</span>
      </template>
      <template v-else>
        <a class="directory-document" :href="withBase(node.url || '#')">{{ node.title || node.name }}</a>
        <span v-if="node.description" class="directory-description">{{ node.description }}</span>
      </template>
    </li>
  </ul>
</template>

<style scoped>
.directory-tree {
  margin: 8px 0 16px;
  padding-left: 22px;
}

.directory-folder {
  font-weight: 600;
}

.directory-document {
  text-decoration: none;
}

.directory-description {
  margin-left: 8px;
  color: var(--vp-c-text-2);
  font-size: 0.9em;
}
</style>
