# Scriptorium

个人知识库 Scriptorium 的公司内部站点，基于 VitePress 与 [vitepress-carbon](https://github.com/brenoepics/vitepress-carbon) 主题（GitHub 风格极简主题，内置本地搜索），承载在司产出的技术文档（E2E 架构拆解等），后续新文档按六库结构逐步归档。

## 目录结构

```
├── docs/
│   ├── index.md                     # 首页（hero + 六库卡片）
│   └── document/<库>/...            # 文档正文，六库分类
├── .vitepress/
│   ├── config.mts                   # 站点配置：六库定义、侧边栏生成、搜索、死链豁免
│   └── theme/
│       ├── index.ts                 # 主题接入（vitepress-carbon Layout）
│       └── custom.css               # 布局与样式覆盖层
└── package.json
```

六库：**撷简台**（碎片捕获）/ **撰修司**（在写专项）/ **正典阁**（长期沉淀）/ **纪事寮**（踩坑记录）/ **资简库**（工具与模板）/ **秘藏龛**（历史归档）。

## 常用命令

```bash
pnpm dev                              # 本地开发，http://127.0.0.1:5173
pnpm build                            # 构建产物（默认根路径）
BASE_PATH=/Scriptorium/ pnpm build    # 带 GitLab Pages 路径前缀构建
pnpm preview                          # 本地预览构建产物
pnpm docs:frontmatter --check         # frontmatter 规范校验（dev/build 前自动执行）
```

## 新增文档

在 `docs/document/<库>/` 下建目录与 `index.md`，frontmatter 基本字段：

```yaml
---
title: 文档标题
date: 2026-10-12
categories: <库名>
tags: [标签]
---
```

侧边栏由 `vitepress-sidebar` 按库自动扫描生成，新文档保存后即出现在所属库的导航中；目录默认折叠到一级。图表直接写 ```` ```mermaid ```` 代码块即可渲染（深浅色跟随站点主题）。

## 样式与布局定制

- 布局参数集中在 `.vitepress/theme/custom.css` 的 `:root` 变量：`--vp-sidebar-width`（左栏宽）、`--vp-doc-content-max-width`（正文列宽）、`--vp-doc-aside-width`（右侧"本页目录"栏宽）。
- 覆盖 carbon 主题的规则须用 `body + 双写 class` 形式（如 `.VPSidebar.VPSidebar`）：carbon 组件样式为 scoped（`class + [data-v]` 属性），普通选择器特异性不足会静默失效。
- 尚未迁移分区的链接在 `config.mts` 的 `ignoreDeadLinks` 中豁免，某库迁移完成后从列表移除即可收紧校验。
