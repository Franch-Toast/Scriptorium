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

const sortNodes = (nodes: TreeNode[]) =>
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return collator.compare(a.type === "folder" ? a.name : a.title || a.name, b.type === "folder" ? b.name : b.title || b.name);
  });

const tree = computed<TreeNode[]>(() => {
  const root = normalizePath(props.root);
  const nodes: TreeNode[] = [];

  for (const document of documents as unknown as { url: string; title?: string; description?: string }[]) {
    const documentPath = normalizePath(document.url);
    if (!documentPath.startsWith(`${root}/`)) continue;

    const relativeParts = documentPath.slice(root.length + 1).split("/").filter(Boolean);
    if (!relativeParts.length) continue;

    let level = nodes;
    relativeParts.forEach((part, index) => {
      const isDocument = index === relativeParts.length - 1;
      if (isDocument) {
        level.push({
          type: "document",
          name: part,
          title: document.title || part,
          description: document.description,
          url: document.url,
        });
        return;
      }

      let folder = level.find(node => node.type === "folder" && node.name === part);
      if (!folder) {
        folder = { type: "folder", name: part, children: [] };
        level.push(folder);
      }
      level = folder.children || (folder.children = []);
    });
  }

  const sortRecursively = (items: TreeNode[]) => {
    sortNodes(items);
    for (const item of items) if (item.children) sortRecursively(item.children);
  };
  sortRecursively(nodes);
  return nodes;
});
</script>

<template>
  <DirectoryTreeNode v-if="tree.length" :nodes="tree" />
  <p v-else class="directory-empty">暂无文档。</p>
</template>

<style scoped>
.directory-tree {
  margin: 8px 0 16px;
  padding-left: 22px;
}

.directory-tree .directory-tree {
  margin: 4px 0 8px;
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

.directory-empty {
  color: var(--vp-c-text-2);
}
</style>
