---
title: "sensor_radar 异常检测机制"
date: 2026-09-20
description: "基准平台：LP8650-V1-SHARE"
categories:
  - 撰修司
tags:
  - sensor_radar
---

# sensor_radar 异常检测机制

> 基准平台：LP8650-V1-SHARE  
> 生成日期：2026-04-02

---

## 1. 异常检测层次总览

| 层级 | 检测机制 | 检测维度 | 执行线程 | 输出方式 |
|-|-|-|-|-|
| L1 | lpcom SDK Topic 监控 | 帧超时 / 回调超时 / 断流 | lpcom 内部 (`topic_monitor`) | `ErrorCodeCallback` → `ReportEvent` |
| L2 | `TimestampAnomalyDetection` | 包间隔 / 系统-包时间差 / 时间回跳 | `SnrRadAsembProc` (同步调用) | `MLOG(WARN/ERROR)` + 丢帧 |
| L3 | `RadarDecoder::CheckRadarStatus` | 雷达硬件故障 | `SnrRadAsembProc` (同步调用) | `MLOG(ERROR)` + `ReportEvent` |
| L4 | `Watchdog` 看门狗 | 数据包接收超时 | `sensors_watch_dog` | `MLOG(ERROR)` + `ReportEvent` |
| L5 | `FrameRateCheck` 帧率检查 | 帧率过低 / 过高 | `sensors_frame_rate_checker` | `MLOG(ERROR/WARN)` + `ReportEvent` |
| L6 | `RadarHelper::status_thread` | 雷达在线状态 | status_thread (匿名) | `MLOG(ERROR)` |
| L7 | `RadarHelper` 队列满检测 | SPSC 队列溢出 | `thread_pool` (回调线程) | `MLOG(ERROR)` |
| C1 | Church `ChannelSuspendAlarm` | 输出通道消息停发 | Church 监控线程 | `MLOG(WARN)` |
| C2 | Church `ComProcTimeUnit` | Proc() 执行超时 | `c_anomaly_monitor` | `MLOG(ERROR)` + `CHURCH_PROC_TIMEOUT_EVENT` |
| C3 | Church `EventReporter` | 事件聚合发布 | `event_report` | `/church/module_events` |

---

## 2. L1: lpcom SDK Topic 监控

### 2.1 配置

来自 `radar_topic_monitor.json`：

```json
{
  "topic_monitor_config": [
    {
      "topic_name": "/leap/radar/front",
      "frame_timeout_threshold": 150000,
      "callback_timeout_threshold": 100000,
      "lose_timeout_threshold": 300000
    },
    {
      "topic_name": "/leap/radar/corner_rl",
      "frame_timeout_threshold": 150000,
      "callback_timeout_threshold": 100000,
      "lose_timeout_threshold": 300000
    },
    {
      "topic_name": "/leap/radar/corner_rr",
      "frame_timeout_threshold": 150000,
      "callback_timeout_threshold": 100000,
      "lose_timeout_threshold": 300000
    }
  ]
}
```

| 阈值 | 值 | 含义 |
|-|-|-|
| `frame_timeout_threshold` | 150ms | 帧间隔超时 |
| `callback_timeout_threshold` | 100ms | 回调执行超时 |
| `lose_timeout_threshold` | 300ms | 断流超时（连续无数据） |

### 2.2 错误码与事件映射

`RadarManager::ErrorCodeCallback` 按 topic 区分上报不同的事件：

**MRR 前雷达 (`/leap/radar/front`)**：

| ErrorCode | 事件 |
|-|-|
| `kFindTopicTimeout` | `LP_RADAR_FM_SRV_FIND_SERVICE_TIMEOUT` |
| `kTopicUnavailable` | `LP_RADAR_FM_SRV_UNAVAILABLE` |
| `kLoseTimeout` | `LP_RADAR_FM_TOPIC_LOSE_TIMEOUT` |
| `kFrameTimeout` | `LP_RADAR_FM_TOPIC_FRAME_TIMEOUT` |
| `kCallbackTimeout` | `LP_RADAR_FM_TOPIC_CALLBACK_TIMEOUT` |

**SRR 左后 (`/leap/radar/corner_rl`)**：

| ErrorCode | 事件 |
|-|-|
| `kFindTopicTimeout` | `LP_RADAR_RL_SRV_FIND_SERVICE_TIMEOUT` |
| `kTopicUnavailable` | `LP_RADAR_RL_SRV_UNAVAILABLE` |
| `kLoseTimeout` | `LP_RADAR_RL_TOPIC_LOSE_TIMEOUT` |
| `kFrameTimeout` | `LP_RADAR_RL_TOPIC_FRAME_TIMEOUT` |
| `kCallbackTimeout` | `LP_RADAR_RL_TOPIC_CALLBACK_TIMEOUT` |

**SRR 右后 (`/leap/radar/corner_rr`)**：

| ErrorCode | 事件 |
|-|-|
| `kFindTopicTimeout` | `LP_RADAR_RR_SRV_FIND_SERVICE_TIMEOUT` |
| `kTopicUnavailable` | `LP_RADAR_RR_SRV_UNAVAILABLE` |
| `kLoseTimeout` | `LP_RADAR_RR_TOPIC_LOSE_TIMEOUT` |
| `kFrameTimeout` | `LP_RADAR_RR_TOPIC_FRAME_TIMEOUT` |
| `kCallbackTimeout` | `LP_RADAR_RR_TOPIC_CALLBACK_TIMEOUT` |

**注意**：与 `sensor_ins_online` 中错误使用 `SENSOR_INS` 模块标识符不同，`sensor_radar` 正确使用了 `SENSOR_RADAR` 模块标识符，并且为每颗雷达的每种错误定义了独立的事件 ID。

---

## 3. L2: `TimestampAnomalyDetection` — 时间戳异常检测

### 3.1 注册参数

```cpp
// 对所有 3 颗雷达使用相同参数
RadarHelper::RegisterTimeStampCheck(
    frame_id,
    kPktIntervalMax = 100000,      // 100ms — 包间隔上限
    kPktIntervalMin = 30000,       // 30ms  — 包间隔下限
    kDiffAataAndPktMax = 1000000,  // 1s    — 系统时间与包时间戳最大偏差
    filter_zero = true             // 过滤零时间戳
);
```

### 3.2 检测项目

`TimestampAnomalyDetection::Check()` 在 `SnrRadAsembProc` 线程中被 `TimeStampCheck()` 同步调用：

| 检测项 | 条件 | 异常类型 | 处理 |
|-|-|-|-|
| 系统-包时间差过大 | `\|data_time - pkt_time\| > 1s` | `DIFF_DATA_AND_PKT_ERROR` | **丢弃帧** + MLOG(ERROR) |
| 包时间回跳 | `pkt_time <= last_pkt_time` (filter_zero) | `PKT_TIME_BACK_ERROR` | **丢弃帧** + MLOG(WARN) |
| 包间隔过大 | `pkt_interval > 100ms` | `PKT_INTERVAL_ERROR` | 仅 MLOG(WARN) |
| 包间隔过小 | `pkt_interval < 30ms` | `PKT_INTERVAL_ERROR` | 仅 MLOG(WARN) |
| 执行间隔过大 | `exe_interval > 100ms` | `EXE_INTERVAL_ERROR` | 仅 MLOG(WARN) |
| 系统-包时间差提示 | hint 阈值 (如已设置) | `DIFF_DATA_AND_PKT_WARN` | 仅 MLOG(WARN) |

### 3.3 `RadarHelper::TimeStampCheck` 处理逻辑

```
TimestampAnomalyDetection.Check(key, pkt_timestamp) → error_v
for each error:
    DIFF_DATA_AND_PKT_ERROR → return true (丢弃)
    PKT_TIME_BACK_ERROR     → return true (丢弃)
    PKT_INTERVAL_ERROR      → 不丢弃
    EXE_INTERVAL_ERROR      → 不丢弃
    其他                    → 不丢弃
```

---

## 4. L3: `CheckRadarStatus` — 雷达硬件故障检测

`lp_25u1::RadarDecoder::CheckRadarStatus()` 在每帧解码时被调用，检查 `RadarStatus` 结构体：

### 4.1 MRR 前视雷达 (`radarType=5`)

| 故障 | 检测条件 | 事件 |
|-|-|-|
| 时间同步异常 | `timeSyncError == true` | `FR_TIME_SYNCHRONIZATION_FAULT` |
| E2E 通信异常 | `messageError == true` | `FR_OBJ_E2E_ERROR` |
| 内部故障 | `hardwareError \|\| overVoltageError \|\| underVoltageError \|\| overTemperature \|\| vehicleDataError` | `FR_INTERNAL_FAILURE` |
| 遮挡故障 | `blockError == true` | `FR_BLIND_FAULT` |
| 工作模式异常 | `workMode == 1 \|\| workMode == 3` | `RADAR_FM_WORK_MODE_ABNORMAL` |
| 缺少标定参数 | `alignmentStat == 2` | `RADAR_FM_MISSING_CALIB_PARAM` |
| 标定状态异常 | `alignmentStat == 3` | `RADAR_FM_CALIB_STATUS_ABNORMAL` |

### 4.2 SRR 右后角雷达 (`radarType=4`)

| 故障 | 检测条件 | 事件 |
|-|-|-|
| E2E 通信异常 | `messageError == true` | `CR_RR_OBJ_E2E_ERROR` |
| 内部故障 | 同上 | `CR_RR_INTERNAL_FAILURE` |
| 遮挡故障 | `blockError == true` | `CR_RR_BLIND_FAULT` |
| 工作模式异常 | `workMode == 1 \|\| workMode == 3` | `RADAR_RR_WORK_MODE_ABNORMAL` |
| 标定状态异常 | `alignmentStat != 1` | `RADAR_RR_CALIB_STATUS_ABNORMAL` |

### 4.3 SRR 左后角雷达 (`radarType=3`)

| 故障 | 检测条件 | 事件 |
|-|-|-|
| E2E 通信异常 | `messageError == true` | `CR_RL_OBJ_E2E_ERROR` |
| 内部故障 | 同上 | `CR_RL_INTERNAL_FAILURE` |
| 遮挡故障 | `blockError == true` | `CR_RL_BLIND_FAULT` |
| 工作模式异常 | `workMode == 1 \|\| workMode == 3` | `RADAR_RL_WORK_MODE_ABNORMAL` |
| 标定状态异常 | `alignmentStat != 1` | `RADAR_RL_CALIB_STATUS_ABNORMAL` |

**注意差异**：

- MRR 有**时间同步异常**检测（`timeSyncError`），SRR 没有
- MRR 的标定异常区分"缺少参数"(`alignmentStat==2`) 和"参数错误"(`alignmentStat==3`)
- SRR 的标定异常统一为 `alignmentStat != 1` 即报错

---

## 5. L4: `Watchdog` 看门狗

### 5.1 触发流程

```
thread_pool → callback:
    WatchdogInstance().FeedLoop(key)  ← 每收到数据包喂一次狗

sensors_watch_dog 线程:
    Monitor():
        if last_feed_time + interval <= now:
            MLOG(ERROR) << key << " Receive packet timeout..."
            ReportEvent(module, event)
```

### 5.2 注册与 RadarManager

`sensor_radar` 中的 Watchdog 通过 `RadarHelper` 回调自动喂狗，无需手动注册。每次调用 `WatchdogInstance().FeedLoop(key)` 会更新 `last_feed_time`。

如果 RadarManager 显式调用了 `WatchdogInstance().RegisterMs()` 或 `RegisterSecond()`，则在对应 key 超时时上报事件。

---

## 6. L5: `FrameRateCheck` 帧率检查

`FrameRateCheck` 单例维护的 `sensors_frame_rate_checker` 线程按时间窗口统计帧计数：

```
if count < minCount:
    MLOG(ERROR/WARN) << "[key] has low frame rate..."
    ReportEvent(module, event)    // 如果注册了事件
elif count > maxCount:
    MLOG(ERROR/WARN) << "[key] has high frame rate..."
    ReportEvent(module, event)
count = 0  // 重置
```

RadarManager 可通过 `FrameRateCheckInstance().FrameRateCheckRegister()` 注册。

---

## 7. L6: `RadarHelper::status_thread` — 在线状态检查

```
每秒执行:
    for each decoder in key_and_decoder_map_:
        if !is_live_func():
            MLOG(ERROR) << frame_id << " radar is not live"
        if LiveStatus::OFFLINE:
            MLOG(ERROR) << frame_id << " radar is not live"
```

**LiveStatus 状态机**：

```
UNKNOWN (初始)
    │
    ├─ 收到数据 → ONLINE
    │    └─ 下次 CheckTimeoutTriggerIgnore → UNKNOWN
    │
    └─ 超过 timeout_ignore_threshold_us_ 未收到数据 → OFFLINE
         └─ 只有收到新数据才能恢复为 ONLINE
```

---

## 8. L7: 队列满检测

```cpp
// RadarHelper 回调闭包中
if (decoder_info->queue->push(data)) {
    // 入队成功
} else {
    MLOG(ERROR) << key << " Queue is full!";
}
```

当 SPSC 队列（容量 64）溢出时直接丢弃数据并输出 ERROR 日志。

---

## 9. 4D 雷达点云路径异常检测（`RadarHelperPointCloud`）

仅当使用 `RadarHelperPointCloud` 路径时生效（LP 平台未启用）：

### 9.1 时间戳检查

```cpp
// RegisterDecoderWithTimeCheck 路径
TimestampCheck(frame_id, pointcloud->header.stamp):
    PKT_INTERVAL_ERROR    → MLOG(ERROR) "radar package interval error"
    EXE_INTERVAL_ERROR    → MLOG(ERROR) 同上
    DIFF_DATA_AND_PKT_ERROR → ReportEvent(SENSOR_RADAR, FR_4D_TIME_SYNCHRONIZATION_FAULT)
                              + MLOG(ERROR) "radar time sync error, discard data"
                              → 丢弃帧 (return false)
    PKT_TIME_BACK_ERROR   → 同上
```

### 9.2 超时清空

```cpp
// RadarPcProc 线程
cv_.wait_for(200ms):
    timeout → ClearDataQueue()  // 200ms 无新数据，清空队列
    retry_counter >= 3 → ClearDataQueue()  // 连续 3 次不齐，清空
```

---

## 10. 与 sensor_ins_online / sensor_uss 的异常检测对比

| 检测维度 | sensor_ins_online | sensor_uss | sensor_radar |
|-|-|-|-|
| lpcom Topic 监控 | ✅ (IMU/GNSS) | ✅ (Probe/Obstacle) | ✅ (MRR/SRR×2) |
| 事件模块标识 | ⚠️ 错用 `SENSOR_INS` | ⚠️ 同 INS 共用代码 | ✅ 正确 `SENSOR_RADAR` |
| 每雷达/传感器独立事件 | ✅ (IMU/GNSS 分开) | ✅ (Probe/Obstacle 分开) | ✅ (FM/RL/RR 各 5 种事件) |
| C 层 event_statistics | ✅ (sys_pkt_diff 等) | ❌ | ❌ |
| TimestampAnomalyDetection | ❌ (用 C 层检测) | ❌ | ✅ (C++ 层检测) |
| 硬件故障检测 | 无（硬件在ADPU上） | ✅ (12探头+驱动芯片) | ✅ (时间同步/E2E/遮挡/工作模式/标定等) |
| Watchdog 看门狗 | ✅ | ✅ | ✅ |
| FrameRateCheck | ✅ | ✅ | ✅ |
| SPSC 队列满检测 | ✅ | ✅ | ✅ |
| 雷达在线状态监控 | ❌ | ❌ | ✅ (`status_thread`) |
| 点云路径时间同步 | ❌ | ❌ | ✅ (`FR_4D_TIME_SYNCHRONIZATION_FAULT`) |
| Church 通道/Proc 监控 | ✅ | ✅ | ✅ |

**sensor_radar 的异常检测特点**：

1. **硬件故障检测最全面**：覆盖 7 种故障类型 × 3 颗雷达，共 \~18 个独立事件
2. **双层时间戳检测**：L2 (`TimestampAnomalyDetection`) + 4D 点云路径 (`RadarHelperPointCloud::TimestampCheck`)
3. **在线状态监控**：`status_thread` + `CheckTimeoutTriggerIgnore` 提供雷达存活性判断，支持将离线雷达排除出合并逻辑
4. **无 C 层检测**：不同于 `sensor_ins_online` 的 `event_statistics.c`，radar 完全在 C++ 层实现异常检测
5. **事件命名规范**：每颗雷达 (FM/RL/RR) × 每种错误类型都有独立事件 ID，便于定位
