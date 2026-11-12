---
title: "附录 A 名词、数据对象与源码阅读地图"
date: 2026-11-10
description: "按职责整理术语、对象、源码入口与现象索引，作为整个系列的检索工具。"
categories:
  - 撰修司
tags:
  - E2E
  - Planning
  - 架构拆解
---

# 附录 A 名词、数据对象与源码阅读地图

> **这一篇讲什么**：按职责整理术语、对象、源码入口与现象索引，作为整个系列的检索工具。
>
> **读完你能回答**：陌生类名属于哪一层？某种现象应从哪个入口开始读？
>
> **前置知识**：可随时查阅，无需顺序读完。

## 1. 先按概念找章节

| 名词 | 一句话解释 | 深入位置 |
|---|---|---|
| planner head | 网络的自车规划任务分支，交付模型候选 | 第 01、09 篇 |
| planning | 消费输入、组织候选、求解并输出的软件系统 | 第 01、03 篇 |
| Planner | 规划器接口及其 EM / OpenSpace / ReverseTracking 实现 | 第 11、14 篇 |
| Task | 规划器内部的一道计算工序 | 第 11 篇 |
| reference line | 衡量道路位置与偏移的参考曲线 | 第 02、07 篇 |
| path | 空间几何走向 | 第 02 篇 |
| trajectory | 带时间与运动状态的未来方案 | 第 02、13 篇 |
| SL / Frenet | 沿参考线距离与横向偏移 | 第 02 篇 |
| ST | 时间与沿路径/相关基准距离构成的图 | 第 02、11 篇 |
| θ / κ / jerk | 朝向 / 曲率 / 加速度的时间变化率 | 第 02、12 篇 |
| modality | 表达某种可能运动模式的候选 | 第 09 篇 |
| passable area | 为后续处理提供可通行空间的表达 | 第 07 篇 |
| prediction | 对其他对象未来运动的估计 | 第 08 篇 |
| LevelK | 交互假设相关处理，不是模型训练频率 | 第 08 篇 |
| virtual stop wall | 用虚拟对象与停止决策表达停车约束 | 第 10 篇 |
| DP / QP | 离散递推搜索 / 二次规划 | 第 11 篇 |
| iLQR | 用迭代最优控制方法优化状态与控制序列 | 第 12 篇 |
| stitching / reinit | 衔接历史与新规划 / 条件不合适时重置起点 | 第 06、13 篇 |
| fallback / backup | 失败时的具体备选处理 / 可用备份数据 | 第 11、13 篇 |
| fan-out / barrier | 分发多个工作 / 等待结果完成的汇合点 | 第 03、11 篇 |
| wall time | 开始到结束经历的时间，包含等待 | 附录 B |

### 读分支代码前，先认这些缩写

以下按本系列中的用途解释；功能的完整产品定义和适用范围还要看业务协议。

| 缩写 | 在本文中的含义 | 读代码时怎样使用 |
|---|---|---|
| HPI | HumanPlanningInterface，业务与规划之间的接口组织 | 看请求、状态、模式和限制怎样影响规划 |
| EM | EmPlanner 的名称，历史上与路径/速度迭代规划有关 | 不凭名称假定当前只跑传统算法 |
| OSP | OpenSpace Planning，开放空间规划 | 看目标、搜索、结果与生命周期 |
| APA | 自动泊车相关功能/模式 | 与泊车目标、重规划和执行状态一起读 |
| VPA | 代码中相关泊车业务的行驶及衔接模式 | `is_vpa_driving` 会影响任务与求解器；不能等同于“当前在倒车” |
| ACC | 自适应巡航相关功能 | 关注纵向跟车与限速等条件 |
| LCC | 车道居中辅助相关功能 | 关注其启用状态与专用规则条件 |
| RAS / ras_map | 项目中的道路/语义结构消息族名称 | 按具体消息字段和解码器理解，不把所有地图消息视为同一对象 |
| ADC / ego | 这里用于指自动驾驶自车 | 与 obstacle/agent 所指其他对象区分 |
| raw / flat / nested | 原始表示 / 扁平布局 / 嵌套布局 | 说明数据形态，不直接说明质量好坏 |
| cost / constraint | 优化偏好或惩罚 / 需要满足的限制 | 查具体实现，确认是惩罚、边界还是外部检查 |
| warm start / rollout | 利用已有解初始化 / 按模型向前推演 | 是数值求解过程，不是车端训练 |

## 2. 再按代码对象找职责

| 对象 | 主要角色 | 典型持有或处理内容 |
|---|---|---|
| PlanningFrameData | 算法输入与子图流转结构 | 感知、定位、自车、地图、请求等 |
| Frame | 当前帧算法工作台 | 起点、对象、候选、选中结果、上下文 |
| FrameContext / Context | 跨帧状态载体 / C++ 包装访问 | 历史选择、状态、轨迹及相关缓存 |
| ReferenceLine | 候选参考几何 | 曲线、投影、道路相关信息 |
| ReferenceLineInfo | 候选资料夹 | 参考线、对象关联、决策、成本、路径/速度/轨迹 |
| Object | 规划侧物理/虚拟对象 | 几何、运动、预测及相关标记 |
| PathObstacle | 对象与特定候选的关联 | SL、决策和候选关系 |
| ModelCombinedTrajectory | 模型路径与纵向候选的组合表达 | 组合轨迹及相关评估 |
| HPIPlanningInterface | 业务与规划间的输入表达 | 功能、模式、请求、限制与目标 |
| ADCTrajectory | 对外轨迹消息 | 轨迹点、状态、行为、控制模式等 |

这些对象不是一一对应的消息 topic，也不是每帧都深拷贝一次。共享指针、可变对象与只读视图的真实关系，应以具体定义及调用方为准。

## 3. 源码阅读顺序

从 planning 仓库根目录开始，以下路径均相对此仓库；外部装配文件单独注明。

| 顺序 | 文件 / 目录 | 带着什么问题读 |
|---|---|---|
| 1 | driver 的 `config/component/planning_graph.cfg` | 输入怎样装配，完成后怎样放行下一帧 |
| 2 | `planning/config/planning_sub_graph.cfg` | 四段主链和 Request 支路在哪里 |
| 3 | `planning/planning_api.h` | 传给算法的结构包含什么 |
| 4 | `planning/planning_core.cpp` | Process / RunOnce / InternalRun 各负责哪段 |
| 5 | `planning/planning_frame_management.cpp` | 怎样建立 Frame、起点和前处理 |
| 6 | `planning/frame/frame_lifecycle.cpp` | Init 与 Preprocess 具体依赖 |
| 7 | `planning/frame/frame_reference_line.cpp`、`frame_init_utils.cpp` | 候选、对象、场景怎样组织 |
| 8 | `planning/frame/frame_modal_selection.cpp` | 模型候选怎样进入每个道路方案 |
| 9 | `planning/planner/em_planner.cpp` | 实际任务条件、失败、汇合与选线 |
| 10 | `planning/tasks/ilqr/ilqr_optimizer.cpp` | 模式分支、输入构造与结果回写 |
| 11 | `planning/tasks/ilqr/driving/driving_ilqr_solver_v2.cpp` | 当前行车问题的分阶段组织 |
| 12 | `planning/tasks/ilqr/solver/ilqr.cpp` | 通用数值迭代 |
| 13 | `planning/planning_trajectory_process.cpp`、`planning_core.cpp` | 检查、异常与外层后处理 |
| 14 | `planning/calculators/planning_post_process_calculator.cc` | 最终消息怎样放进输出集合 |
| 15 | `planning/planner_manager.cpp`、`planning/open_space_planning_async_manager.cpp` | 模式替换及后台生命周期 |

第一次阅读不要钻进每个数学实现。先画出“谁创建对象、谁修改它、谁读取结果、失败谁处理”，再下钻单个任务。

## 4. 从现象反查入口

| 现象 | 建议定位链 | 章节 |
|---|---|---|
| 不知道为何没有开始下一帧 | trigger → Any 缓存/装配 → planning_done 回边 | 03、05 |
| 轨迹用了新模型但旧障碍物 | 消息组装 → 原始测量时间 → 条件性时间处理 | 04、05、09 |
| 某条变道候选消失 | 参考线构造 → 模型匹配 → 候选过滤 → 行为与选线 | 07、09～11 |
| 邻车影响不合理 | Object → PathObstacle → 预测/交互 → 决策/成本 | 08、10、12 |
| 路径合理但刹停不舒服 | 纵向候选 → DP/QP → iLQR → OptimalJerk → 最终输出 | 09、11～13 |
| 有成功日志却没轨迹点 | Plan 返回 → run_success → 清点/构造 → PostProcess | 13 |
| 耗时突然增大 | Frame 分层计时 → 最慢候选/等待 → 求解阶段 | 附录 B |
| 泊车结果迟迟不来 | 请求/目标 → 搜索提交 → 完成/取消 → LoadResult | 14 |

## 5. 常见单位与容易混淆的两两关系

位置通常用米，速度 m/s，加速度 m/s²，jerk m/s³；角度、曲率及其导数应核对字段定义。时间在接口之间可能是纳秒、微秒或秒，不能因为都叫 timestamp 就直接相减。

模型 history condition 与 FrameContext 不同；`StitchMap` 与轨迹 stitching 不同；Task UNKNOWN 与整帧失败不同；输出槽编号与发布优先级不同；点间隔与运行频率不同。以上是本系列最值得反复检查的几组边界。


## 证据与延伸

以下链接固定到本系列分析的源码提交；行号指向关键实现，不代表整段行为只由这一行决定。

| 要核实的行为 | 源码入口 |
|---|---|
| 输入对象 | [planning/planning/planning_api.h · `struct PlanningFrameData`](https://code.deeproute.ai/deeproute-org/pnc/planning/planning/-/blob/dd7cbf35a83fa1f5fb5dc078563235e671365327/planning/planning_api.h#L51) |
| 候选组织 | [planning/planning/frame/frame_lifecycle.cpp · `Frame::Init(`](https://code.deeproute.ai/deeproute-org/pnc/planning/planning/-/blob/dd7cbf35a83fa1f5fb5dc078563235e671365327/planning/frame/frame_lifecycle.cpp#L211) |
| 任务组织 | [planning/planning/planner/em_planner.cpp · `EmPlanner::EmPlanner(`](https://code.deeproute.ai/deeproute-org/pnc/planning/planning/-/blob/dd7cbf35a83fa1f5fb5dc078563235e671365327/planning/planner/em_planner.cpp#L202) |
| 数值优化 | [planning/planning/tasks/ilqr/driving/driving_problem/driving_state_layout.h · `enum class DrivingProblemLayout`](https://code.deeproute.ai/deeproute-org/pnc/planning/planning/-/blob/dd7cbf35a83fa1f5fb5dc078563235e671365327/planning/tasks/ilqr/driving/driving_problem/driving_state_layout.h#L64) |


---

[返回 Planning 导读](./index.md) · [上一篇：15 用完整场景串起来：从输入变化到车辆行为](./15%20%E7%94%A8%E5%AE%8C%E6%95%B4%E5%9C%BA%E6%99%AF%E4%B8%B2%E8%B5%B7%E6%9D%A5%EF%BC%9A%E4%BB%8E%E8%BE%93%E5%85%A5%E5%8F%98%E5%8C%96%E5%88%B0%E8%BD%A6%E8%BE%86%E8%A1%8C%E4%B8%BA.md) · [下一篇：附录 B 配置、线程与运行证据](./%E9%99%84%E5%BD%95%20B%20%E9%85%8D%E7%BD%AE%E3%80%81%E7%BA%BF%E7%A8%8B%E4%B8%8E%E8%BF%90%E8%A1%8C%E8%AF%81%E6%8D%AE.md)
