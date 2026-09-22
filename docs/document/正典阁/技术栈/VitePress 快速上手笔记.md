---
title: VitePress 快速上手笔记
date: 2026-08-20
categories:
  - 正典阁
tags:
  - 前端
  - VitePress
---

# VitePress 快速上手笔记

本篇记录 VitePress 的核心概念与本站落地时的常用配置，作为快速查阅手册。

<!-- more -->

## 核心概念

- **srcDir**：存放 Markdown 的目录，本站为 `docs/`；配置文件在 `docs/.vitepress/`；
- **base**：部署在子路径（如 GitHub Pages 项目站）时必须设置，VitePress 要求以 `/` 开头结尾；
- **frontmatter**：每页可覆盖布局与主题配置，`layout: home` 即落地页。

## 常用命令

```bash
npx vitepress dev docs     # 开发（HMR）
npx vitepress build docs   # 构建到 docs/.vitepress/dist
npx vitepress preview docs # 本地预览构建产物
```

## 踩过的点

- `base` 不对时静态资源 404，页面白屏但控制台看不出明显报错；
- 内部链接带空格/中文会在构建期做 dead link 检查，最好用 `permalink` 固定功能页 URL；
- 深色模式由 `html.dark` 类控制，自定义 CSS 变量要同时给 `:root` 和 `.dark` 两份。
