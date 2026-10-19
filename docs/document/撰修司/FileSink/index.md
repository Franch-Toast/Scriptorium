---
title: FileSink 异步 I/O 设计与接入指南
date: 2026-10-19
categories: 撰修司
tags: [FileSink, 异步IO, Planning, QNX, C++]
---

# FileSink 异步 I/O 设计与接入指南

这组文档说明 common/base/file_sink 的异步文件基础设施：如何把文件写入、替换、删除、重命名和轮转从业务帧线程移至后台，以及业务如何处理入队失败、异步失败与停机。

起因是 RPA 泊入时，planning 帧线程同步保存恢复缓存，在慢盘或满盘条件下阻塞并影响轨迹心跳。设计目标是隔离文件系统等待，保住帧输出；异步化本身不提供硬实时保证，也不等于每个已接收任务都已持久化。

## 阅读顺序

| 文档 | 回答的问题 |
| --- | --- |
| [设计与一致性](./设计指南.md) | 为什么这样分层？顺序、背压、重试、持久化和生命周期如何定义？ |
| [接口与重要类](./api接口.md) | FileSink、Executor、Cache、Proto、FileWriter 分别有什么接口和约束？ |
| [接入示例与验证](./接入指南.md) | 怎样初始化、帧内提交、观察结果、关闭，以及迁移 planning？ |

## 先选正确的入口

| 需求 | 推荐入口 | 业务要承担的语义 |
| --- | --- | --- |
| 连续文本/压缩记录，批量写入、文件轮转和旧文件清理 | FileSink 的显式 Async 接口 | 入队失败时丢弃或在业务侧降频；flush/close 决定尾批完整性 |
| 恢复缓存，只需要最终保存最新状态 | AsyncFileCache | 中间版本可合并；写入和删除都表示最新期望状态 |
| 单次写入、原子替换、删除、重命名、严格有序的操作序列 | AsyncFileExecutor | 为有依赖的操作复用同一 stream，明确失败处理策略 |
| protobuf ASCII/binary 文件 | async_proto_file + Executor/Cache | 提交不可变快照；明确复制成本与落盘格式 |
| 兼容原有 FdGuard 文件描述符写接口 | FileWriter | 旧适配层仍有普通互斥锁及回调约束，不作为新帧路径首选 |

## 文档基线

- 整理日期：2026-10-19。
- common：/sandbox/common，分支 feat/file_sink，基线提交 0428f57266b3c4e1558e066d9be33d4dea38fb9f。
- planning：/sandbox/planning，分支 monorepo/prod_157037_Release_LP_D19OS_0904，基线提交 721369d3efa26c52e384b24e61c1c5c5008ccc0b。
- 本文描述的是以上基线上本次实现后的**未提交工作区代码**，并非这些提交本身已经包含新接口。最终发布时应补充实际合入提交。
- 源码真值位于 common/base/file_sink 的头文件和实现；验证范围及仍需完成的车端验收见[接入示例与验证](./接入指南.md#验证范围与上线验收)。
