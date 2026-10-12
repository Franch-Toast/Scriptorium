# Deeproute Scriptorium

Deeproute 内部文档知识库（vitepress-carbon 主题）。本分支 `Deeproute-master` 拥有**独立的孤儿历史**，与个人站 `master` 分支无任何共同祖先与共享对象——公司仓库中不存在个人文档的任何 commit 与文件。

## 双分支工作流

```
Deeproute-master（公司 GitLab，vitepress-carbon）
      │  单向 cherry-pick（文档新增/修改同步到个人站）
      ▼
master（个人 GitHub，vitepress-theme-teek，完整内容）
```

- **方向单一**：只有公司站 → 个人站；个人站内容永不进入公司站（孤儿历史从机制上保证）。
- **路径纪律**：两侧文档路径完全一致（`docs/document/<库>/...`），这是 cherry-pick 零冲突的前提。

### 日常命令（本 worktree：/sandbox/Scriptorium-dr）

```bash
# 公司站本地开发（dev 绑定 127.0.0.1:5173）
pnpm dev
# 公司站构建
pnpm build
BASE_PATH=/Scriptorium/ pnpm build   # 带 GitLab Pages 路径前缀时
```

### 新增/修改文档（在公司分支）

```bash
cd /sandbox/Scriptorium-dr
# 编辑 docs/document/<库>/... 后
git add . && git commit -m "docs(<库>): ..."
git push <公司remote> Deeproute-master
```

### 同步到个人站（master）

```bash
cd /sandbox/Scriptorium
git log Deeproute-master --oneline -5      # 找到要同步的提交
git cherry-pick <hash>                     # 应用到 master（不依赖共同历史）
git push origin master
```

cherry-pick 按 patch 内容应用，不依赖提交哈希与共同祖先；两侧各自改写历史互不影响。

## 工程说明

- 主题：[vitepress-carbon](https://github.com/brenoepics/vitepress-carbon)（GitHub 风格极简主题，内置本地搜索）
- mermaid：`vitepress-plugin-mermaid` + `mermaid 11`，```` ```mermaid ```` 代码块自动渲染，深浅色跟随
- 侧边栏：`vitepress-sidebar` 按库扫描多段生成，新文档入库自动出现
- frontmatter 校验：`pnpm docs:frontmatter --check`（dev/build 前自动执行，规范与个人站一致）
- 工程布局与个人站同构：`srcDir: docs`、`document/` 六库、`BASE_PATH` 环境变量
