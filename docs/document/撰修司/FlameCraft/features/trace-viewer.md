---
title: "Trace Viewer"
date: 2026-09-20
description: "Trace Viewer 是 FlameCraft 内置的 Linux 调度 Trace 分析模块，页面入口为 /trace-viewer。后端实现位于 pkg"
categories:
  - 撰修司
tags:
  - FlameCraft
---

# Trace Viewer

Trace Viewer 是 FlameCraft 内置的 Linux 调度 Trace 分析模块，页面入口为 `/trace-viewer`。后端实现位于 `pkg/traceviewer`，前端位于 `ui/packages/app/web/src/components/TraceViewer`。

## 处理流程

```text
上传文件 → 临时目录 → 格式检测/解析 → 内存 session
                                  ├─ CPU slices
                                  ├─ thread states
                                  ├─ sched latency / wakeup chain
                                  └─ IRQ slices / statistics
```

支持三类输入：

- pipe-delimited `trace_stream` 文本；
- `trace-cmd report` 可读取的二进制 trace；
- `trace-cmd` 不可用时的 raw ftrace 文本回退。

上传的 `.zst` 会先解压。session 和索引保存在进程内存，重启后需要重新上传；服务端需要安装 `trace-cmd` 才能解析二进制 `.dat`。

## API

基础路径：`/api/trace`。

| 方法 | 路径 | 作用 |
|-|-|-|
| POST | `/upload` | multipart 字段 `file`，返回 `traceId` |
| GET | `/sessions` | 列出内存中的 session ID |
| GET | `/{traceId}/overview` | 时间范围、CPU、进程和事件统计 |
| GET | `/{traceId}/cpu-timeline` | CPU 调度切片；`from`、`to`、可选 `cpus` |
| GET | `/{traceId}/thread-timeline` | 线程状态；`from`、`to`、`pids` |
| GET | `/{traceId}/stats` | 延迟直方图、CPU 利用率、Top 线程 |
| GET | `/{traceId}/wakeup-chain` | 指定 PID 时间范围内的唤醒事件 |
| GET | `/{traceId}/wakeup-chain-deep` | 从 PID/时间戳向后追溯唤醒链；可选 `depth` |
| GET | `/{traceId}/wakeup-graph` | waker→wakee 汇总关系；可选 `pids` |
| GET | `/{traceId}/event-context` | 指定 PID/时间戳的事件上下文 |
| GET | `/{traceId}/irq-timeline` | IRQ 区间 |

`cpu-timeline`、`thread-timeline`、`stats`、`wakeup-chain`、`irq-timeline`、`wakeup-graph` 启用 gzip middleware；调用方应支持 `Accept-Encoding: gzip`。

## 页面使用

生产/编译后访问：

```text
http://localhost:7070/trace-viewer
```

前端热开发时访问 `http://localhost:3000/trace-viewer`；Vite 将 `/api/trace` 代理到 `localhost:7071`，后端需以 `--http-address=:7071` 启动。

- 上传 `.dat`、trace stream 或 `.zst` 文件后等待解析完成。
- CPU 时间线支持框选缩放、鼠标平移和滚轮缩放。
- 从 CPU slice 或进程筛选器选择多个线程，查看线程状态时间线。
- 点击状态块可查看调度延迟、waker 和向后唤醒链；唤醒关系表用于按次数/延迟观察 waker→wakee 对。
- `Ctrl+E` 导出当前 CPU 时间线为 PNG。

## 事件和模型

解析器重点消费 `sched_switch`、`sched_wakeup`/`sched_wakeup_new`、`irq_handler_entry`、`irq_handler_exit`。后端在 ingest 阶段并行构建 CPU 切片、线程状态、调度延迟、IRQ 区间和进程信息。

状态主要包括：`running`、`sleeping`、`waiting`、`blocked`。调度延迟由 wakeup 到实际 switch-in 的时间计算，waker PID 来自 wakeup 事件的 header，而非从 CPU slice 推断。

## 限制

- session 只在当前进程存活期间存在；没有持久化 session API。
- 上传和解析上限由 handler 的 multipart 限制控制（当前为 500 MiB），超大文件需要关注内存和解析时间。
- 输入不含 `sched_switch` 时无法生成有意义的 CPU/线程时间线；缺少对应 `sched_wakeup` 时，唤醒链会提前结束。
