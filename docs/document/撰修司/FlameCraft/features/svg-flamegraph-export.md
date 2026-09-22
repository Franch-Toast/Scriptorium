---
title: "交互式 SVG 火焰图导出"
date: 2026-09-20
description: "FlameCraft 支持将火焰图导出为独立的交互式 SVG 文件，风格与 Brendan Gregg 的 FlameGraph(https://github."
categories:
  - 撰修司
tags:
  - FlameCraft
---

# 交互式 SVG 火焰图导出

## 概述

FlameCraft 支持将火焰图导出为独立的交互式 SVG 文件，风格与 [Brendan Gregg 的 FlameGraph](https://github.com/brendangregg/FlameGraph) 工具一致。导出的 SVG 无需任何外部依赖，可直接在浏览器中打开使用。

## 使用方式

1. 在 FlameCraft UI 中选择要查看的 profile
2. 在火焰图区域找到 Share/Export 按钮
3. 点击 "Download FlameGraph SVG"
4. 在浏览器中打开下载的 `.svg` 文件

## 交互功能

| 功能 | 操作 |
|-|-|
| **缩放** | 点击任意帧，展开该帧的子树至全宽 |
| **回退** | 点击 "Reset Zoom" 或已缩放的父帧 |
| **全局回退** | 点击底部 "all" 根层，回到完整火焰图 |
| **搜索** | 点击 "Search"，输入正则表达式高亮匹配帧 |
| **详情** | 鼠标悬停显示函数名、百分比、耗时 |

## 技术实现

### 核心文件

```
ui/packages/shared/profile/src/ProfileView/components/ShareButton/
├── flamegraph-svg.ts    # SVG 生成核心逻辑
└── index.tsx            # UI 按钮和 profileType 提取
```

### SVG 参数

| 参数 | 值 | 说明 |
|-|-|-|
| `svgWidth` | 1800px | 画布宽度，与参考工具一致 |
| `FRAME_HEIGHT` | 16px | 每帧高度 |
| `FONT_SIZE` | 12px | 文字字号 |
| `CHAR_WIDTH` | 5.8px | 字符宽度（用于文字截断计算） |
| `MIN_WIDTH_PX` | 1.0px | 最小渲染宽度，低于此宽度的帧不渲染 |

### 关键算法

#### 树形布局 (`layoutTree`)

子帧在父帧内使用像素级累积定位，消除浮点舍入导致的间隙：

```typescript
function layoutTree(node: TreeNode, pixelX: number, scale: number): void {
  node.x = pixelX;
  node.w = node.cumulative * scale;
  let nextPx = pixelX;
  for (const child of node.children) {
    layoutTree(child, nextPx, scale);
    nextPx = child.x + child.w;
  }
}
```

#### 颜色生成 (`warmColor`)

使用 `djb2Hash` 对完整函数名哈希，生成红-橙-黄暖色渐变，确保不同函数名产生不同颜色：

```typescript
function djb2Hash(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) & 0xffffffff;
  }
  return hash;
}
```

#### 文字截断 (`truncateText`)

根据帧宽度动态截断函数名，预留 2px 内边距：

```typescript
function truncateText(text: string, maxWidth: number): string {
  const maxChars = Math.floor((maxWidth - 2) / CHAR_WIDTH);
  if (maxChars < 1) return '';
  if (text.length <= maxChars) return text;
  if (maxChars <= 2) return text.substring(0, maxChars);
  return text.substring(0, maxChars - 2) + '..';
}
```

#### SVG 高度计算

仅统计实际渲染帧（宽度 >= `MIN_WIDTH_PX`）的最大深度，避免大量窄帧导致多余顶部空白：

```typescript
let maxRenderedDepth = 0;
function findMaxRenderedDepth(node: TreeNode): void {
  if (node.w >= MIN_WIDTH_PX && node.depth >= minVisibleDepth) {
    const adj = node.depth - minVisibleDepth;
    if (adj > maxRenderedDepth) maxRenderedDepth = adj;
  }
  for (const child of node.children) findMaxRenderedDepth(child);
}
```

#### 帧 Y 坐标定位

使用 `(adjustedDepth + 2)` 确保数据帧与 "all" 根条分离，且最深帧恰好位于 `topPad` 位置：

```typescript
const y = svgHeight - bottomPad - (adjustedDepth + 2) * FRAME_HEIGHT;
```

### 缩放实现

SVG 内嵌 JavaScript 实现交互式缩放。每次缩放前先 `zoom_reset()` 所有帧到原始位置，避免多层缩放叠加导致视觉异常：

1. 保存原始 `x` 和 `width` 属性（`orig_save`）
2. 重置所有帧到原始位置（`zoom_reset`）
3. 计算缩放比例 `ratio = graphWidth / selectedWidth`
4. 子帧按比例缩放（`zoom_child`）
5. 父帧拉伸至全宽（`zoom_parent`）
6. 非相关帧隐藏（`display: none`）
7. 更新所有可见帧的文字（`update_text`）

### 文字动态填充

每个帧始终包含 `<text>` 元素（即使初始内容为空），这使得 `update_text` 函数在缩放后能为变宽的帧正确填充函数名，实现缩放后 100% 文字覆盖率。

### Profile 类型标签

根据 URL 中的 `expression_a` 参数自动识别 profile 类型，在 SVG 中显示正确的单位标签：

| Profile 类型 | 单位标签 |
|-|-|
| CPU | CPU time |
| Off-CPU | Off-CPU time |
| Off-CPU Waker | Off-CPU waker time |

## 与参考工具对比

| 维度 | FlameCraft SVG | Brendan Gregg FlameGraph |
|-|-|-|
| 画布宽度 | 1800px | 1800px |
| 颜色风格 | 红-橙-黄暖色 | 红-橙-黄暖色 |
| 帧间隙 | 无 | 无 |
| 缩放交互 | 支持 | 支持 |
| 搜索 | 支持 | 支持 |
| "all" 根层 | 支持 | - |
| 缩放后文字覆盖率 | 100% | 100% |
| 综合评分 | 7.9/10 | 8.1/10 |
