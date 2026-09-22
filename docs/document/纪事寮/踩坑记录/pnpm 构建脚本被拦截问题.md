---
title: pnpm 构建脚本被拦截问题
date: 2026-09-01
categories:
  - 纪事寮
tags:
  - pnpm
  - 构建
---

# pnpm 构建脚本被拦截问题

`pnpm install` 后构建报 esbuild 错误，本文记录该问题的现象、根因与修复步骤。

<!-- more -->

## 现象

`pnpm install` 完成后运行 VitePress 报 `esbuild` 相关错误，安装日志里出现：

```text
Ignored build scripts: esbuild@0.21.5.
Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
```

## 根因

pnpm v10 出于安全考虑**默认禁止依赖包执行安装期脚本**（postinstall 等），esbuild / @parcel/watcher 这类需要下载或编译平台二进制的包被静默跳过。

## 修复

在 `package.json` 中显式放行：

```json
{
  "pnpm": {
    "onlyBuiltDependencies": ["esbuild", "@parcel/watcher"]
  }
}
```

随后重新 `pnpm install`，日志中应看到 `esbuild postinstall: Done`。

## 教训

CI 上遇到"本地好好的、流水线装完就崩"的 Node 依赖问题，先查 pnpm 10 的构建脚本拦截日志，再看别的。
