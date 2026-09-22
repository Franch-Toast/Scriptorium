---
title: "260910 SIL 环境 cbw_control 卡顿/超时根因案例（procnto 高负载 × church 通信延迟）"
date: 2026-09-20
categories:
  - 纪事寮
tags:
  - Church
  - cbw_control
  - procnto
---

# 260910 SIL 环境 cbw_control 卡顿/超时根因案例（procnto 高负载 × church 通信延迟）

- **记录日期**：2026-09-10
- **现象类别**：进程卡顿 / 控制超时 / 上游时间戳失效
- **根因分类**：系统级 CPU 竞争（procnto-smp-instr-safety 高占用）叠加 SIL 环境缺线程绑核配置，导致低优先级控制线程被饿调度
- **涉及模块**：perf_collector、procnto-smp-instr-safety（QNX 内核进程）、church 中间件（iceoryx）、cbw_control、canbus 上游
- **运行环境**：QNX 微内核架构（procnto-smp-instr-safety），SIL（Software-in-the-Loop）环境
- **结论状态**：根因已定位，遗留点已标注（见文末）

---

## 一、现象概述

SIL 环境运行中，同一时刻出现两簇"无关"告警，最终定位为**同一场系统级事件的两个侧面**：

1. **perf_collector**（性能采集进程）：

   - `Pidstat runonce elapsed 9529 ms`——一次常规 5s 周期内的全系统进程统计采集，卡死约 9.5s；
   - 期间伴随大量 `/proc/<pid>/as` 打开失败、"Comm changed"、pid 高频 churn（短命进程 sleep/date/ls/netstat 反复出现）。
2. **cbw_control**（线控控制进程，church Component 调度）：

   - `CbwControl proc time out !!!` 持续爆发（20\~168ms 不等，约定 20ms），从 begin time 估算约 27s 起到 43s 止；
   - `IOX::Parse/canbus/car_state` 解析延迟 **118ms**（on-cpu 仅 22.6us）；
   - 上游 canbus `car_state` 时间戳 gap 跳到 0.32s（应 \~20ms 一帧）；
   - 随后 `upstream_checker` 连续 fatal：canbus 失效 → `CONTROL_LOCALIZATION_TIMESTAMP_INVALID` 安全事件刷屏 → `ControlAdapter Process failed`。

**时间窗对齐**：perf_collector 的内核请求风暴基本覆盖 26\~43s；cbw_control 超时启动窗口（≈27s 起）落在其内部，并持续到 \~43s。两者显著重叠。

---

## 二、关键日志证据

### 2.1 perf_collector 侧（问题来源）

```
I03:29:26.269895 9 pid_monitor.cc:574] [Pidstat] Collecting sched_info #2 at 40s after startup
        （sched_info #2 全量采集触发 → 主线程 9 阻塞约 9.4s）
I03:29:35.681471 9 pid_monitor.cc:417] Pidstat runonce elapsed 9529 ms
I03:29:15~43  大量 9 utils.cc:290] Failed to open /proc/<pid>/as ...（进程高频 churn）
```

- perf_collector 的 `Proc::run()` 是**单线程串行** 5s tick：`vmstat → thermal → cpu_cores → gpu → dsp → pidstat → record`，任何一个模块卡死会拖垮整个周期；
- `sched_info #2` 对白名单进程（本 repo 配置含 128 个 assign）**每个线程做一次 devctl DCMD_PROC_THREADCTL / \_\_getset_thread_name**，请求量达上千次；
- 叠加系统级进程 churn → 形成对 procnto 的 **procfs/devctl 请求风暴**，是本次高负载的最可疑来源（**疑似 perf_collector 导致**，见 §五 遗留确认点）。

### 2.2 cbw_control 侧（受害方）

```
I03:29:31.458911 11 lon_controller_mpc.cpp:987] ...（控制算法正常，osqp 仅 1~17ms）
W03:29:31.479911 10 proc_time_unit.cc:193] CbwControl proc time out !!! proc run id: 746, begin time: 306072701, duration: 20 ms
W03:29:31.479911 10 proc_time_unit.cc:193] CbwControl proc time out !!! proc run id: 753, begin time: 306254701, duration: 23 ms
...（同一时间戳批量刷 9~14 条）
W03:29:36.787910 7 scope_latency_log.h:38] Scope [IOX::Parse/canbus/car_state] latency(ns): 118000000 GE threshold, on cpu time(ns): 22656
E03:29:42.870906 11 upstream_checker.cpp:552] canbus timestamp check ... time_gap: 0.32
E03:29:42.872906 11 control_manager.cpp:1199] report safety event:CONTROL_LOCALIZATION_TIMESTAMP_INVALID
```

**三个机制必须澄清**（避免误读日志）：

1. **时间戳语义**：行首 `03:29:31.479911` 是抛日志的墙钟，**不是 proc 调用时刻**；`begin time` 才是 proc ProcessBegin 的单调时钟微秒。同一批日志时间戳完全相同，是因为 `ComProcTimeUnit` 由 anomaly 监测线程（线程 10）**每 1000ms 检查一次**，把上一秒内累积的所有超时记录一次性 dump（`anomaly_monitor.cc:50` 每 100ms tick、`counts%1000==0` 时 `UnitRoutine`）。
2. **run id 语义**：`proc_number_`，church `Component::Process()`（`component.cc:78-101`）每触发一轮自增；batch 内 run id 断层 = 中间那些轮没超时（<20ms）所以不打印。run id 746→1173 在 \~13s 内 +427，约 20ms/次触发 —— **CBW proc 本身按正常节拍被触发，只是相当一部分跑超了**。
3. **1026/1052/1171 等 duration 168ms**：proc 墙钟远超 20ms，配合 IOX::Parse 的"墙钟 118ms / on-cpu 22us"，说明该批线程大部分时间**未被调度（饿调度/挂起）**，而非 CPU 算不动。

### 2.3 控制算法正常佐证

```
lat ctrl Time cost [ms]: 8, osqp solver[ms]: 1   （正常）
lon control Time cost [ms]: overall 17, osqp 17   （正常）
mpc tracker time cost(ms): 18
```

算法纯计算不慢 ⇒ proc 超时原因在**输入准备 / 消息收发 / 线程调度等待**，不在控制算法本体。

---

## 三、排查链条与根因推导

### 第 1 步：perf_collector 自身为何卡 9.5s

- `Pidstat::runonce` 对每个已跟踪进程串行执行 `StatMonitor::runonce`（open `/proc/pid/as` + devctl + 读全部线程）+ `collect_new_pids` 扫描并 `insert_new_pid_info`；进程越多、churn 越猛越慢。
- `sched_info #2`（40s 定时全量采集）把白名单进程全部线程的 runmask devctl 循环叠加上 → 使本轮从正常 168\~808ms 飙到 9529ms。
- 这些请求全部发给 **procnto-smp-instr-safety**（QNX 内核对 /proc、devctl、信号量、调度、唤醒的仲裁者）→ procnto 处理不过来，CPU 占用上升。

### 第 2 步：cbw_control 为何一起遭殃

- CBW 控制线程是 `SCHED_RR priority 6`，但**这是实车配置**（`driver/config/thread_config/<车型>/cbw_control.json`：t_CbwControl SCHED_RR prio 6, cpuset 6-8）。
- SIL 环境没有对应 `thread_config` 目录条目（`thread_config/` 下只有车型目录：C01/HY11/LP8650 等，无 SIL/默认）→ cbw_control 拿不到绑核/优先级配置，**以默认优先级在跑**。
- procnto 忙时，低/默认优先级线程的唤醒、调度被大幅推迟 ⇒ CBW proc 墙钟 20ms → 30\~168ms；iceoryx 解析回调线程同样被饿 ⇒ `IOX::Parse` 118ms；canbus 输入处理被拖延 ⇒ `car_state` 时间戳 gap 0.32s ⇒ 上游检查 fatal ⇒ 安全事件刷屏。

### 第 3 步：实车 vs SIL 的进程/配置差异

| 项 | 实车 | SIL |
|-|-|-|
| cbw_control 进程/启动 | 车型 node 配置，带 `THREAD_CONFIG_PATH` 绑核 json | SIL 部署（`sil_config.jsonnet` skip 掉 cbw/control 等节点后的替代进程），**无绑核配置** |
| 线程优先级 | SCHED_RR prio 6 / cpuset 6-8 | 默认优先级、未绑核 |
| 对 procnto 高负载的耐受 | 高（RT 优先级，受饿概率低） | **低（默认优先级，易被饿调度）** |

> 注：SIL 上 cbw_control 的具体启动形态（是否同一个 binary、由谁拉起、为何未走 THREAD_CONFIG_PATH）为本案例**遗留待确认点**（见 §六）。

---

## 四、根因因果链

```
perf_collector sched_info #2 全量采集 + 进程高频 churn
        │  （上千次 /proc open / devctl DCMD_PROC_THREADCTL / __getset_thread_name）
        ▼
procnto-smp-instr-safety 处理请求风暴，CPU 占用过高，调度/唤醒/中断响应被拖慢
        │
        ├──→ perf_collector 主线程 9 在 procfs 请求上阻塞 → pidstat 9529ms
        │
        └──→ 【SIL 环境缺失】cbw_control 未绑核、默认优先级运行
                  │
                  ├──→ CBW 控制线程被饿调度 → proc 墙钟 20→168ms → "proc time out" 批量刷
                  ├──→ iceoryx 解析线程被饿 → IOX::Parse 118ms（on-cpu 22us）
                  └──→ canbus 上游处理被拖延 → car_state 时间戳 gap 0.32s
                        → upstream_checker fatal → CONTROL_LOCALIZATION_TIMESTAMP_INVALID
                        → ControlAdapter Process failed → 安全事件刷屏
```

**一句话结论**：问题时刻 `procnto-smp-instr-safety` CPU 占用过高（疑似 perf_collector 的 procfs/devctl 请求风暴触发），显著拖慢了 QNX 内核的调度与通信；而 **SIL 上的 cbw_control 没有像实车那样配置线程绑核/优先级**，以默认优先级运行，于是在内核高负载下成为最易被饿调度的受害者，表现为自身 proc 超时、church（iceoryx）通信延迟放大、最终上游时间戳失效并触发安全事件。**这是环境差异（SIL 缺配置）+ 触发源（procnto 高负载）叠加的结果，而非 CBW 控制算法本身的问题。**

---

## 五、为什么"proc 超时"与"procnto 风暴"是同一件事的整体

- CBW 的算法计算（MPC/osqp）**不碰 procnto**，但 proc 编排依赖：iceoryx 收发（共享内存 + 同步原语）、线程挂起/唤醒、时钟读取、互斥竞争——这些在 QNX 上**都经内核 procnto 仲裁**。
- 调度链证据：`IOX::Parse` 墙钟 118ms / on-cpu 22us，证明线程被挂起/饿调度而非算不动；canbus 时间戳 gap 0.32s 证明上游数据流处理被拖延。
- 因此"CBW 超时"和"perf_collector 卡死"共享同一内核繁忙根因，属于一次系统级事件在两个进程上的表现差异：**谁更抗饿谁不超时，谁优先级低谁先崩**。

---

## 六、遗留确认点 / 建议整改

### 遗留待验证

1. **procnto CPU 占用直接量化**：本文档基于两份 glog + 时间窗重叠 + 机制链推断，未能直接拿到 procnto 当时的 CPU/排队数据。建议补 `pidin` / `/proc` 快照或 QNX `tracelogger` 对齐确认。
2. **SIL cbw_control 启动形态**：确认 SIL 上 cbw_control 由谁拉起、为何不加载 `THREAD_CONFIG_PATH`（是部署遗漏还是 SIL 有独立启动路径）。
3. **churn 来源**：当时高频 fork 的 `sleep/date/ls/netstat` 短命进程出自哪个服务，是否本身也是该轮问难的诱因。

### 整改建议

- **修复（SIL 侧）**：为 SIL 的 cbw_control（及 cbw_canbus 等实时关联进程）补齐绑核/优先级配置，与实车一致（如 SCHED_RR prio 6 / 独立 cpuset），消除在默认优先级下被饿调度的窗口。
- **缓解（perf_collector 侧）**：

  - `sched_info` 一次性全量采集属启动期固定动作，建议限速/分批/移出主线程链路，避免单轮打爆 procnto；
  - 排查并治理短命进程 churn 的来源。
- **加固（观测侧）**：对 QNX 内核进程（procnto-\*）增加 CPU/排队监控，出现高负载时可与各组件超时事件做时间窗关联告警。

---

## 附：涉及代码位置

| 组件 | 文件 | 说明 |
|-|-|-|
| perf_collector | `deep_os_tool_cpp/proc/pid/pid_monitor.cc:409` \~ `:578` | runonce / update_current_pids / sched_info 采集 |
| perf_collector | `deep_os_tool_cpp/proc/proc_main.cc:222` \~ `:318` | 单线程串行 5s tick 主循环 |
| church | `platform/church/component/proc_time_unit.cc:83` \~ `:141` | ProcessBegin/End 计时 + CheckState 批量取超时 |
| church | `platform/church/component/anomaly_monitor.cc:50` \~ `:67` | 监测线程 100ms tick / 1000ms UnitRoutine |
| church | `platform/church/node/iceoryx_dispatcher.cc:371` | IOX::Parse 延迟打点 |
| CBW | `control-by-wire/manager/control_manager.cpp:334` \~ `:378` | ControlProcess/ThreadFunction |
| CBW | `driver/integration/components/cbw_control_component.cc:38` \~ `:85` | church Component::Proc 桥接 |
| CBW | `driver/config/thread_config/<车型>/cbw_control.json` | 实车绑核/优先级配置（SIL 缺失） |
| 配置 | `driver/config/sil_config.jsonnet` | SIL 节点跳过清单 |
