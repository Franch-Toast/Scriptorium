<script setup lang="ts">
import { withBase } from "vitepress";

export interface DirectoryTreeNode {
  type: "folder" | "document";
  name: string;
  title?: string;
  description?: string;
  url?: string;
  children?: DirectoryTreeNode[];
}

defineOptions({ name: "DirectoryTreeNode" });
defineProps<{ nodes: DirectoryTreeNode[] }>();
</script>

<template>
  <ul class="directory-tree">
    <li v-for="node in nodes" :key="`${node.type}:${node.url || node.name}`">
      <template v-if="node.type === 'folder'">
        <span class="directory-folder">{{ node.name }}</span>
        <DirectoryTreeNode :nodes="node.children || []" />
      </template>
      <template v-else>
        <a class="directory-document" :href="withBase(node.url || '#')">{{ node.title || node.name }}</a>
        <span v-if="node.description" class="directory-description">{{ node.description }}</span>
      </template>
    </li>
  </ul>
</template>
