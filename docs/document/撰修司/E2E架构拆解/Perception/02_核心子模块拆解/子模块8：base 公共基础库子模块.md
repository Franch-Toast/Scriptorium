---
title: "子模块8：base 公共基础库子模块"
date: 2026-09-20
description: "代码位置：/sandbox/perception/submodules/base（子仓检出分支 Stable_Master_3.2，与主仓 Stable_Mas"
categories:
  - 撰修司
tags:
  - Perception
  - E2E
---

# 子模块8：base 公共基础库子模块

> 代码位置：`/sandbox/perception/submodules/base`（子仓检出分支 **Stable_Master_3.2**，与主仓 Stable_Master_4.0_new 的差异仅系 repo 子仓管理，未做改动）。README 仅一句话："Perception base，Depends to dl/common"。

## 1. 定位与职责

base 是感知仓库的**公共基础库**：向 camera/lidar/tracker/aeb/avp 等算法子模块和 perception 主仓 calculator 提供三类资产——

1. **通用数据结构**：跨传感器统一的目标表示 `base::Object`/`CameraObject`、帧容器 `ResultFrame`/`MultiModalityPreprocessOutput`、各传感器帧/参数结构；
2. **通用工具**：计时、路径环境变量替换、容器转字符串、图像缓冲、CUDA/OpenCL NMS 与算子（ops）、GPU IO 辅助等；
3. **可复用 calculator**：`calculators/nn_common/` 下的 NN 推理编排节点（C01 主图 `uni_model` 节点直接使用的 `NNInternalCalculator` 即出自此处，base 因此**不只是头文件库**）。

## 2. 核心工具类清单（分类）

| 分类 | 代表类/文件 | 一句话说明 |
|-|-|-|
| 数据结构 | `object.h`：`base::Object`（L114 起）、`CameraObject`（L342 起） | 全仓库统一的 3D 目标/相机目标结构（center、size、theta、velocity、type、attribute_type 等），tracker 输入输出即 `ObjectPtr` |
| 数据结构 | `object_types.h`：`ObjectType/ObjectSubType/AttributeType/TrafficSignType` 等枚举 | 全部目标类别、属性、红绿灯状态枚举的唯一权威定义 |
| 数据结构 | `frame/multi_modality_base.h`：`MultiModalityPreprocessOutput`（L19 起） | tracker 输入的多模态打包容器（lidar/radar/camera/uss objects + tf + 地面参数） |
| 数据结构 | `frame/result_frame.h`：`CombinedObstacles`（L12 起） | 行/泊两路障碍物合并的最终输出容器 |
| 数据结构 | `camera/`（traffic_light.h、lane_struct.h、image_struct.h 等）、`lidar/`（lidar_object.h、lidar_frame.h 等） | 相机（红绿灯 `TLColor/LightRegion`、车道线）与雷达（点云旗标 point_flag）侧结构 |
| 数学/几何 | `nms/nms.h、nms.cuh、nms_cuda.cu、nms_opencl.cpp` | NMS（非极大值抑制）的三后端实现（CPU/CUDA/OpenCL），供检测后处理复用 |
| 数学/几何 | `ops/`（crop.cu、matmul.cu、decode.cu、batch_image_preprocess_op.cu 等） | CUDA 预处理/后处理算子库（裁剪、矩阵乘、解码、批量图像预处理） |
| 时间 | `base_utils/timer.h`：`Timer`（L17 起） | `steady_clock` 计时器，`EndMilli(bool reset)` 返回毫秒耗时，perception 各 calculator 通用 |
| 线程/GPU | `base_utils/gpu_io_helper.h、cuda_utils.h、nvtx_helper.h` | GPU 内存/流 IO 辅助、CUDA 工具、NVTX 打点辅助（tracker 的 `MTRACE_GPU_SCOPE` 生态） |
| 配置/路径 | `base_utils/path_overwrite.h`：`GetReplacedPathByEnv()`（L15）、`ModifyStringFields()`（L30） | 用环境变量替换配置串/protobuf 字符串字段中的路径前缀（tracker `Load()` 就靠它改写参数路径） |
| 配置/日志 | `log.h`（仅 `#include "common/log.h"`）、`report_event_keys_values.h` | 日志宏转发至 dl/common；感知事件上报的 key-value 常量表 |
| 其他 | `base_utils/`：`container_to_str.h、image_buffer.h、frame_counter.h、simple_json_str.h、calculator_recorder.h、air_susp.h` | 容器打印、图像缓冲、帧计数、轻量 JSON、calculator 录制、空气悬架参数 |

## 3. 被其他子模块依赖的方式

- **Bazel 外部仓引用**：主仓 `/sandbox/perception/WORKSPACE` L116-118 将本仓注册为 `local_repository(name = "perception_base", path = "submodules/base")`；下游一律以 **`@perception_base//<target>`** 引用，例如：

  - `perception/perception/util/BUILD.bazel`：`"@perception_base//:object"`、`"@perception_base//camera:box"`、`"@perception_base//base_utils:container_to_str"`；
  - `perception/perception/test/calculators/BUILD.bazel`：`"@perception_base//calculators/nn_common:unimodel_preprocess_calculator"` 等；
  - tracker 子仓经 deb 安装路径引用同款头文件（tracker.hpp include `object.h`、`base/trace/trace.h`、`base/hpc_hal/...`）。
- **include 路径形态**：源码中以 `#include "object.h"`（相对 base 根）或 `"base_utils/path_overwrite.h"` 书写，由 perception_cc_wrapper 注入 include 路径。
- **自身依赖**：base 依赖 dl/common（`@common//common:geometry_polygon/point/log`，见 BUILD.bazel object 目标 deps），并提供 proto（`proto/` 各参数 proto，如 `image_preprocess_param`）。
- **发布**：`base_release_package` 仅打包 `bin`（nn_internal_calculator_test_bin）与 `cfg`；头文件随 target 可见性暴露（BUILD.bazel L49-72）。

## 4. 关键数据结构与工具函数（附证据）

### 4.1 base::Object（全仓库目标统一表示）

> 文件路径：/sandbox/perception/submodules/base/object.h  
> 结构体：base::Object（L114 起）  
> 核心逻辑：
> 
> ```cpp
> struct alignas(16) Object {
>   Object() { id = -1; detection_id = -1; sensor_name.clear(); ... }
>   ...
>   Eigen::Vector3f direction = Eigen::Vector3f(1, 0, 0);  // 主方向
>   float theta = 0.0f;                                    // 航向角
>   Eigen::Vector3d center = Eigen::Vector3d(0, 0, 0);     // 包围盒中心
>   Eigen::Vector3d barycenter = Eigen::Vector3d(0, 0, 0); // 点云质心
>   Eigen::Vector3f size = Eigen::Vector3f(0, 0, 0);       // [长,宽,高]
>   Eigen::Vector3d corners[8];                            // 3D 包围盒 8 角点
>   Eigen::Vector3d anchor_point = Eigen::Vector3d(0, 0, 0); // 锚点
>   ObjectType type = ObjectType::UNKNOWN;
>   ObjectSubClass subtype = ObjectSubClass::UNKNOWN_SUBTYPE;
>   ObjectMotion object_motion = ObjectMotion::UNKNOWN;
>   std::`vector<ObstacleLightStatus>` obstacle_light_status;  // 车灯状态
>   ...
> };
> using ObjectPtr = std::`shared_ptr<Object>`;   // L339
> ```
> 
> 逻辑说明：`alignas(16)` 对齐 Eigen；id/detection_id 双 ID（跟踪 id 与检测 id，tracker 直接写入）；车灯状态以"状态→score"映射承载（L225 附近）。tracker 输入输出的 `tracked_objects` 即 `std::vector<ObjectPtr>`。

### 4.2 MultiModalityPreprocessOutput（tracker 输入容器）

> 文件路径：/sandbox/perception/submodules/base/frame/multi_modality_base.h  
> 类名：base::MultiModalityPreprocessOutput（L19 起）  
> 核心逻辑：
> 
> ```cpp
> enum class MultiModalityPreprocessType { ... };        // L13：NULL/LIDAR/... 帧类型
> class MultiModalityPreprocessOutput {
>  public:
>   MultiModalityPreprocessType preprocess_type() const; // L25
>   void set_preprocess_type(MultiModalityPreprocessType type);  // L42
>  private:
>   MultiModalityPreprocessType preprocess_type_;        // L47
> };
> ```
> 
> 逻辑说明：C01 图中 `MultiModalityPreprocessCalculator` 产出该容器（流名 `preprocess_output`），`PerceptionTrackerProcessCalculator` 按 `preprocess_type()` 分派（MMPT_LIDAR_TYPE 走主跟踪流程）。完整成员（各传感器 objects、tf、ground_plane_params）由该类封装并经 `mutable_lidar_objects()` 等访问器交给 tracker（见 calculator L317-L326）。

### 4.3 Timer（时间工具）

> 文件路径：/sandbox/perception/submodules/base/base_utils/timer.h  
> 函数名：base_utils::Timer::EndMilli()（L34 起）  
> 核心逻辑：
> 
> ```cpp
> double EndMilli(bool reset = false) {
>   auto now = std::chrono::steady_clock::now();
>   auto duration = `duration_cast<microseconds>`(now - start_).count();
>   if (reset) { Start(); }
>   return `static_cast<double>`(duration) / 1000.0;
> }
> ```
> 
> 逻辑说明：monotonic 时钟毫秒计时；`prediction_with_planner_calculator.cc` 即用 `timer.EndMilli()` 统计预测耗时（L2540）。

### 4.4 GetReplacedPathByEnv / ModifyStringFields（配置路径工具）

> 文件路径：/sandbox/perception/submodules/base/base_utils/path_overwrite.h  
> 函数名：GetReplacedPathByEnv()（L15）/ ModifyStringFields()（L30）  
> 核心逻辑：
> 
> ```cpp
> inline std::string GetReplacedPathByEnv(const std::string& path) {
>   std::string new_path = path;
>   ... // 按环境变量替换路径前缀
> }
> inline void ModifyStringFields(google::protobuf::Message* message) {
>   ... // 递归遍历 proto 所有 string 字段做路径改写
> }
> ```
> 
> 逻辑说明：配置文件中的 `/opt/deeproute/...` 等路径可按部署环境改写；tracker `Tracker::Load()` 第一件事就是 `::perception::base::ModifyStringFields(&param_)`（tracker.hpp L62），是 base 工具被算法子模块直接调用的实例。

### 4.5 NNInternalCalculator（可复用 NN 推理节点）

> 文件路径：/sandbox/perception/submodules/base/calculators/nn_common/nn_internal_calculator.cc  
> 函数名：NNInternalCalculator / REGISTER_CALCULATOR（L164 / L576）  
> 核心逻辑：
> 
> ```cpp
> class NNInternalCalculator : public graphpipe::CalculatorBase { ... };  // L164
> REGISTER_CALCULATOR(NNInternalCalculator);                              // L576
> ```
> 
> 逻辑说明：graphpipe/mediapipe 风格的通用 NN 推理节点（多输入流 INFER_IN、单/多输出流、side packet 传模型参数），C01 主图 `uni_model` 节点（graph_l2avp.cfg L594-654，50 路 INFER_IN）正是它的实例化——证明 base 是被主图直接链接运行的基础组件，而非纯头文件集。

## 5. 代码证据汇总

- 数据结构权威性：第 4.1、4.2 节（object.h / multi_modality_base.h）；
- 依赖方向：第 3 节 WORKSPACE L116-118 与 `@perception_base//` 引用实例（perception/util/BUILD.bazel L93-L104）；
- 被算法子模块调用：tracker.hpp L19-L26（include `object.h`、`base/trace/trace.h`、`base/hpc_hal/memory/mem_utils.h`）与 L62（`ModifyStringFields`）；
- 被主图直接使用：第 4.5 节 NNInternalCalculator ↔ graph_l2avp.cfg L595 `calculator: "NNInternalCalculator"`；
- NMS/ops 多后端：`submodules/base/nms/`（nms_cpu.cpp/nms_cuda.cu/nms_opencl.cpp）与 `submodules/base/ops/`（目录清单见任务记录，CUDA 预处理算子族）。
