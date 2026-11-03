---
title: "自动驾驶芯片 GPU/NPU 推理能力评估全面调研报告"
date: 2026-09-20
description: "背景说明：本报告基于飞书云文档《GPU Benchmark 工具开发与实验报告》（NVIDIA Thor / Orin X 平台实测数据）的已有调研，进一步从学"
categories:
  - 撰修司
tags:
  - GPU
  - NPU
---

# 自动驾驶芯片 GPU/NPU 推理能力评估全面调研报告

> 编制日期：2026-08-07
> 
> 背景说明：本报告基于飞书云文档《GPU Benchmark 工具开发与实验报告》（NVIDIA Thor / Orin X 平台实测数据）的已有调研，进一步从学术界、开源社区、工业界、跨平台对比等维度展开全方位调研，为自动驾驶芯片的 GPU/NPU 推理能力评估提供系统性的方法论和工具建议。

---

## 目录

- 第一章 背景与痛点分析
- 第二章 业界权威基准测试方法论
- 第三章 开源 Benchmark 工具生态
- 第四章 主流自动驾驶芯片平台对比
- 第五章 跨平台性能对比的核心难点
- 第六章 自动驾驶场景下的推理能力衡量
- 第七章 推荐评估框架设计
- 第八章 参考文献

---

## 第一章 背景与痛点分析

### 1.1 为什么需要这份报告

作为自动驾驶公司，我们需要在多个芯片平台上部署推理模型（感知、预测、规划），这些平台来自不同厂商（NVIDIA、高通、地平线、华为等），各有各的硬件架构和编程接口。在做芯片选型、性能优化、容量规划时，我们面临一个核心问题：

> **如何标准、清晰、合理地衡量不同芯片平台的 GPU/NPU 推理能力？**

这个问题看似简单——"看 TOPS 不就行了？"——但实际上充满了陷阱。

### 1.2 核心痛点

#### 痛点一：TOPS 数字是个"水分很大"的指标

芯片厂商宣传的 TOPS（每秒万亿次操作）是**理论峰值**，就像汽车标称的最高时速——你在真实道路上几乎永远跑不到。实际能用多少，取决于：

- **利用率**：典型 GPU 利用率在 30%\~70%，NPU 可能更低
- **内存带宽**：数据搬运太慢时，计算单元只能"饿着等"
- **算子类型**：不同类型的计算（矩阵乘法 vs 卷积 vs 注意力机制）利用率差异巨大
- **稀疏加速**：部分厂商的 TOPS 包含稀疏加速（假设权重有很多零），实际模型不一定满足这个条件

**通俗类比**：就像两家餐厅都说"日接待能力 1000 人"，但一家有 50 个厨师（计算单元多）配 2 个传菜员（内存带宽窄），另一家有 10 个厨师配 20 个传菜员——实际翻台率完全不同。

#### 痛点二：不同平台的"同精度"含义不同

- NVIDIA 的 INT8 TOPS 是基于 Tensor Core 的密集计算
- 某些 NPU 的 INT8 TOPS 可能包含稀疏加速（2:4 结构化稀疏，TOPS 翻倍）
- 有的平台用 MAC（Multiply-Accumulate，一次乘加）算 2 次操作，有的算 1 次

**直接比较 TOPS 就像比较"两个不同度量衡体系下的重量"——需要先统一单位。**

#### 痛点三：编程接口碎片化

| 平台 | 编程接口 | 类比 |
|-|-|-|
| NVIDIA | CUDA（专有） | 方言，只在本地好使 |
| 高通 | SNPE/QNN | 另一种方言 |
| 地平线 | 天工开物 | 又一种方言 |
| 华为 | CANN/ACL | 再一种方言 |
| 跨平台 | OpenCL/SYCL/Vulkan | "普通话"，各地口音不同 |

同一模型在不同平台上的性能差异，往往不是因为硬件差距，而是**软件生态和编译器优化水平的差距**。

#### 痛点四：自动驾驶 workload 的特殊性

自动驾驶的推理负载与通用 AI benchmark（如 ResNet 图像分类、BERT 文本处理）有本质区别：

- 需要处理**多传感器融合**（相机 + 激光雷达 + 毫米波雷达）
- 包含**BEV（鸟瞰图）变换**、**稀疏卷积**、**Deformable Attention** 等特殊算子
- 有严格的**实时性要求**（通常 30 FPS，端到端延迟 < 100ms）
- 对**尾部延迟**（偶尔出现的慢帧）极度敏感——安全关键场景不能容忍"偶尔卡顿"

### 1.3 已有工作的基础

我们团队已经在 NVIDIA Drive Thor 和 Orin X 平台上完成了初步的 GPU Benchmark 工具开发，包括：

| 工具 | 用途 | 已验证结果 |
|-|-|-|
| gpu_bench（自研） | GPU 算力 + 带宽综合测试 | Thor FP16 132.63 TFLOPS，INT8 168.55 TOPS |
| gpu_bench DLA suite | DLA 算力直测 | Orin X 双核 INT8 \~32.4 TOPS |
| CUTLASS Profiler | Tensor Core GEMM 交叉验证 | 确认 Blackwell INT8 dense 上限 \~172 TOPS |
| BabelStream | DDR 带宽压测 | Thor 265.8 GB/s（理论 273 GB/s，效率 97.4%） |

**已有的局限性**（来自飞书文档）：

- 无多流并发测试
- 无功耗/频率采集
- 仅方阵 GEMM，缺少推理场景的非方阵
- 无卷积测试
- 延迟画像薄弱
- 无长时间稳定性测试

本报告的目标就是在此基础上，从更宏观的视角回答：**除了我们已经做的 micro-benchmark，还应该做什么、怎么做、用什么工具做。**

---

## 第二章 业界权威基准测试方法论

### 2.1 MLPerf Inference——AI 推理性能的行业"黄金标尺"

#### 是什么

MLPerf Inference 是目前业界**最权威的 AI 推理性能基准测试套件**，由 MLCommons 组织（成员包括 Google、NVIDIA、Intel、Meta 等 80+ 家机构）维护。

**通俗理解**：如果说 GPU benchmark 是测"发动机转速"，MLPerf 就是测"整车在真实赛道上的圈速"——它不只看硬件多快，还看端到端的推理效果。

#### 核心论文

- **"MLPerf Inference Benchmark"**，作者 VJ Reddi 等（30+ 家组织联合），2019 年发表（arXiv:1911.02549），已被引用 930+ 次
- GitHub: [https://github.com/mlcommons/inference](https://github.com/mlcommons/inference)

#### 四大测试场景

MLPerf 定义了四种场景，覆盖不同的部署模式：

| 场景 | 通俗解释 | 核心指标 | 适用场景 |
|-|-|-|-|
| **Single Stream** | 一个接一个处理，像收银台排队 | 第 90 百分位延迟（p90） | 边缘设备 |
| **Multi Stream** | 每批发 8 个一起处理 | 第 99 百分位延迟（p99） | 边缘设备 |
| **Server** | 模拟真实在线服务，请求随机到达 | p99 延迟 + 最大吞吐 | 数据中心 |
| **Offline** | 所有数据一次性发，测最大批处理能力 | 总吞吐量（samples/sec） | 数据中心+边缘 |

#### 两个提交分区

- **Closed Division**（封闭组）：必须用相同的模型、数据集、预处理——"苹果对苹果"的公平比较
- **Open Division**（开放组）：允许不同模型和优化方法——鼓励创新

#### 为什么对自动驾驶重要

MLPerf 的**方法论**（场景定义、精度约束、延迟百分位、可复现性）是目前最成熟的参考框架。即使我们不正式提交 MLPerf 结果，也应该借鉴其测量方法来设计内部 benchmark。

### 2.2 MLPerf Automotive——首个标准化自动驾驶 ML 基准（2025 年发布）

#### 是什么

这是 MLCommons 与 AVCC（自动驾驶计算联盟）联合推出的**第一个专门面向自动驾驶的公开标准基准**，2025 年发布。

**核心论文**："MLPerf Automotive"（arXiv:2510.27065，2025 年 10 月）

#### 三个核心工作负载

| 模型 | 任务 | 为什么选它 |
|-|-|-|
| **BEVFormer-tiny** | 3D 目标检测（BEV 视角） | 代表最前沿的 BEV 感知范式 |
| **SSD** | 2D 目标检测 | 经典检测任务，输入 4K 高分辨率 |
| **DeepLabv3+** | 2D 语义分割 | 道路场景理解的基础任务 |

#### 关键设计决策

- **Constant Stream 场景**（新增）：按固定帧率发送请求（BEVFormer 12 FPS，SSD/DeepLabv3+ 15 FPS），模拟真实传感器采样——这比"暴力测最大吞吐"更贴近自动驾驶场景
- **p99.9 尾部延迟**作为核心指标：安全关键场景不能容忍偶尔的慢帧
- **严格精度约束**：精度不能低于 FP32 参考值的 99%\~99.9%——不允许通过牺牲精度来"刷速度"
- **数据集**：nuScenes（公开）+ Cognata 合成数据

#### 对我们的意义

**这是本次调研中最值得优先对齐的基准**。它直接回答了"自动驾驶芯片应该用什么模型、什么指标来评估"这个问题。

### 2.3 MLPerf Tiny——嵌入式超低功耗基准

面向 MCU、嵌入式 NPU 等超低功耗设备（arXiv:2106.07597，2021）。虽然不直接适用于自动驾驶主算力平台，但其方法论（能耗度量、精度约束）对评估 always-on 感知模块有参考价值。

GitHub: [https://github.com/mlcommons/tiny](https://github.com/mlcommons/tiny)

### 2.4 Roofline 模型——理解 GPU 性能瓶颈的"透视镜"

#### 是什么

Roofline 模型是 2009 年由 UC Berkeley 的 Samuel Williams 等人提出的**性能可视化分析模型**（被引用 3969+ 次），它能帮你一眼看出一个计算任务到底是"算不过来"还是"数据搬不过来"。

**论文**："Roofline: An Insightful Visual Performance Model for Multicore Architectures"，Communications of the ACM，2009

#### 核心思想

```
         ┌─────────────────────────────────────┐
         │        计算天花板 (Peak FLOPS)       │
性能 ────┤              ┌────────────────────── │
(GFLOPS) │             /                        │
         │            / ← Ridge Point（拐点）    │
         │           /                          │
         │          / 带宽天花板                 │
         │         / (AI × Memory BW)           │
         └────────┴────────────────────────────┘
                   运算强度 (FLOP/Byte)
```

- **横轴**：Arithmetic Intensity（运算强度）= 每搬运 1 字节数据需要做多少次运算
- **纵轴**：实际可达到的性能
- **两条线**：

  - 水平线 = 计算峰值（再快也快不过硬件上限）
  - 斜线 = 带宽限制（数据搬运速度 × 运算强度）
- **拐点（Ridge Point）**= 计算峰值 / 带宽峰值

#### 在自动驾驶中的应用

| 典型推理算子 | 运算强度 (FLOP/Byte) | 瓶颈类型 | 优化方向 |
|-|-|-|-|
| 大矩阵乘法 GEMM (N>1024) | 100\~1000 | 计算瓶颈 | 已经很快了 |
| 小矩阵乘法 GEMM (N<256) | 1\~10 | 带宽瓶颈 | 需要增大 batch 或融合算子 |
| 卷积 Conv2d (3×3) | 10\~100 | 取决于 batch size | 视情况而定 |
| Element-wise (ReLU, Add) | < 1 | 严重带宽瓶颈 | 必须做算子融合 |
| Attention（decode 阶段） | 1\~10 | 带宽瓶颈 | KV Cache 管理是关键 |

**通俗理解**：Roofline 就像给 GPU 做"体检"——不仅告诉你"能跑多快"，还告诉你"为什么跑不快"以及"该练哪块肌肉"。

### 2.5 HPC 传统基准（HPL/STREAM）的适用性

| 基准 | 测什么 | 对 AI 推理的参考价值 | 建议 |
|-|-|-|-|
| HPL（LINPACK） | 大规模浮点矩阵分解 | ★★☆ 低 | 仅用于验证硬件是否正常 |
| STREAM | 顺序内存带宽 | ★★★☆ 中 | 作为 Roofline 带宽基线 |
| HPCG | 稀疏矩阵求解 | ★★☆ 低 | 比 HPL 平衡但仍不反映 AI |

**结论**：HPC 基准可以作为"硬件验证"的补充，但不适合作为 AI 推理能力评估的主力。

---

## 第三章 开源 Benchmark 工具生态

### 3.1 工具总览

我们将工具按"微基准 → 模型推理 → 端到端 → 跨平台"四个层次梳理，并标注与自动驾驶芯片评估的相关性。

### 3.2 第一层：微基准测试工具（算力/带宽/延迟）

#### 3.2.1 CUTLASS Profiler（NVIDIA 开源）

| 项目 | 信息 |
|-|-|
| GitHub | [https://github.com/NVIDIA/cutlass](https://github.com/NVIDIA/cutlass) |
| Stars | \~3,500 |
| 推荐度 | ★★★★★ |

**是什么**：NVIDIA 的高性能线性代数模板库，自带 `cutlass_profiler` 命令行工具。它可以对指定的矩阵尺寸、数据类型、tile 配置做**全空间扫描**，找到最优 kernel 并输出 TFLOPS。

**与已有工具的关系**：我们已经用 cuBLAS 测了"库的上限"，CUTLASS 能测到"硬件原生 Tensor Core 指令的上限"——两者互补。CUTLASS 4.4.1 已明确支持 DRIVE Thor（sm_110）。

**优点**：能诊断 Tensor Core 利用率、发现 cuBLAS 未选到最优 kernel 的情况  
**缺点**：仅支持 NVIDIA；C++ 模板编译时间长

#### 3.2.2 BabelStream（已在用）

| 项目 | 信息 |
|-|-|
| GitHub | [https://github.com/UoB-HPC/BabelStream](https://github.com/UoB-HPC/BabelStream) |
| Stars | \~250 |
| 推荐度 | ★★★★☆ |

**是什么**：STREAM 基准的 GPU 版本，测全局显存带宽。支持 CUDA、OpenCL、SYCL、HIP 等多后端——这意味着同一套代码可以在不同平台上跑，是一把"公平尺"。

**建议**：补充 FP16/INT8 带宽测试，并加 PCIe/NVLink 传输测试。

#### 3.2.3 mixbench（Roofline 利器）

| 项目 | 信息 |
|-|-|
| GitHub | [https://github.com/ekondis/mixbench](https://github.com/ekondis/mixbench) |
| Stars | \~250 |
| 推荐度 | ★★★★☆ |

**是什么**：评估 GPU 在**不同运算强度**下的性能，绘制运算强度 vs 性能的曲线，直接定位 Roofline 拐点。支持 CUDA、OpenCL、HIP、SYCL 多后端。

**对我们的价值**：正好填补"峰值算力"和"实际算子性能"之间的可观察区间，适合做多芯片 Roofline 对比。

#### 3.2.4 clpeak（跨平台峰值探测）

| 项目 | 信息 |
|-|-|
| GitHub | [https://github.com/krrishnarraj/clpeak](https://github.com/krrishnarraj/clpeak) |
| Stars | \~450 |
| 推荐度 | ★★★★☆ |

**是什么**：合成微基准，测 GPU/CPU 的峰值算力、带宽、延迟。已演进为**跨 API**（OpenCL / Vulkan / CUDA / Metal）单二进制。

**对我们的价值**：**评估非 NVIDIA 平台**（高通 Adreno GPU、Arm Mali GPU、国产 NPU）时，这是少数可用的跨平台工具之一。

#### 3.2.5 gpu-burn（烤机/稳定性测试）

| 项目 | 信息 |
|-|-|
| GitHub | [https://github.com/wilicc/gpu-burn](https://github.com/wilicc/gpu-burn) |
| Stars | \~700 |
| 推荐度 | ★★★☆☆ |

**是什么**：多 GPU 压力测试工具，基于大 GEMM 持续满载。有 Jetson 适配版。

**对我们的价值**：用于车规芯片的**长时间满载降频/热稳定性**测试，与性能基准互补。

### 3.3 第二层：AI 推理基准工具

#### 3.3.1 MLPerf Inference（行业标准）

| 项目 | 信息 |
|-|-|
| GitHub | [https://github.com/mlcommons/inference](https://github.com/mlcommons/inference) |
| Stars | \~2,500 |
| 推荐度 | ★★★★★ |

**是什么**：业界最权威的 AI 推理基准套件，提供 LoadGen（负载生成器）引擎，负责生成请求、记录延迟、计算指标。

**对我们的价值**：方法论参考 + Automotive 基准直接可用。

#### 3.3.2 ONNX Runtime（跨平台推理评估的最佳载体）

| 项目 | 信息 |
|-|-|
| GitHub | [https://github.com/microsoft/onnxruntime](https://github.com/microsoft/onnxruntime) |
| Stars | \~15,000 |
| 推荐度 | ★★★★★ |

**是什么**：微软维护的跨平台推理引擎，通过 **Execution Provider（EP）** 机制接入各种硬件后端：CUDA、TensorRT、OpenVINO（Intel）、QNN（高通 NPU）、CANN（华为昇腾）等。

**通俗理解**：ONNX Runtime 就像一个"万能插座"——同一个模型文件，切换不同的"插头"（EP）就能在不同硬件上跑，这样就能公平比较了。

**对我们的价值**：**强烈建议作为多平台推理评估的主框架**。把 BEV/PointPillars/YOLO 转成 ONNX，用各 EP 在不同芯片上跑，得到可比的端到端延迟/吞吐。

#### 3.3.3 TensorRT / trtexec（NVIDIA 推理金标准）

| 项目 | 信息 |
|-|-|
| GitHub | [https://github.com/NVIDIA/TensorRT](https://github.com/NVIDIA/TensorRT) |
| Stars | \~10,000 |
| 推荐度 | ★★★★★ |

**是什么**：NVIDIA 的高性能推理引擎，附带 `trtexec` 命令行工具，可对 ONNX 模型测延迟、吞吐、算子层耗时。

**对我们的价值**：NVIDIA 系车规芯片（Orin/Thor）推理评估的必备工具，是 micro-benchmark 到端到端推理之间的桥梁。

### 3.4 第三层：自动驾驶专用基准

#### 3.4.1 MLPerf Automotive（最相关）

| 项目 | 信息 |
|-|-|
| 来源 | [https://mlcommons.org/2025/04/auto-inference-v5/](https://mlcommons.org/2025/04/auto-inference-v5/) |
| 论文 | arXiv:2510.27065 |
| 推荐度 | ★★★★★ |

核心内容已在第二章详述。**这是本次调研最值得优先落地的一项**。

#### 3.4.2 nuScenes / KITTI / Waymo Open Dataset

这些数据集可以作为 benchmark 的输入：

- **nuScenes**：1000 场景，多传感器，NDS/mAP 指标
- **KITTI**：经典学术基准，7481+7518 帧
- **Waymo Open Dataset**：规模最大、MLPerf Automotive 已采用

### 3.5 第四层：跨平台抽象层

#### 3.5.1 SYCL / oneAPI

**是什么**：基于 C++17 的单源异构编程模型，Intel 主推。可以写一份代码在 CUDA/AMD/Intel GPU 上跑。BabelStream 和 mixbench 都有 SYCL 后端。

**局限**：对国产 NPU/车规 SoC 支持薄弱。

#### 3.5.2 Vulkan Compute

**是什么**：Vulkan 图形 API 的计算扩展，是高通 Adreno、Arm Mali 等非 NVIDIA GPU 的现代跨平台接口。llama.cpp 也提供 Vulkan 后端。

**对我们的价值**：评估高通/Arm 等非 NVIDIA 平台时，Vulkan 是当前最现代的跨厂商路径。

### 3.6 工具实用性速查表

| # | 工具 | 类别 | 推荐度 | 跨平台 | 与 AD 芯片相关性 |
|-|-|-|-|-|-|
| 1 | MLPerf Inference | 行业基准 | 5 | 多平台 | 高（含 Automotive） |
| 2 | CUTLASS Profiler | NVIDIA 微基准 | 5 | 仅 NVIDIA | 高（支持 Thor） |
| 3 | ONNX Runtime | 跨平台推理 | 5 | 多 EP | 高（多 NPU 接入） |
| 4 | TensorRT/trtexec | NVIDIA 推理 | 5 | 仅 NVIDIA | 高（Orin/Thor） |
| 5 | MLPerf Automotive | AD 专用 | 5 | 多平台 | **极高** |
| 6 | BabelStream | 带宽微基准 | 4 | 多后端 | 中（已用） |
| 7 | mixbench | Roofline | 4 | 多后端 | 中高 |
| 8 | clpeak | 跨 API 峰值 | 4 | Vulkan/CL/CUDA | 高（非 NVIDIA） |
| 9 | Nsight Compute | NVIDIA profiler | 5 | 仅 NVIDIA | 高（调优必备） |
| 10 | gpu-burn | 稳定性测试 | 3 | 仅 NVIDIA | 中（车规压测） |

---

## 第四章 主流自动驾驶芯片平台对比

### 4.1 七大平台速查对照表

| 平台 | 芯片 | 架构 | 标称算力 | 内存/带宽 | 编程接口 | 功耗 |
|-|-|-|-|-|-|-|
| **NVIDIA** | Drive Thor | Blackwell GPU + 第5代 TC | 1000 INT8 TOPS (sparse) | 64-128GB LPDDR5X, 273 GB/s | CUDA, TensorRT | \~130W |
| **NVIDIA** | Drive Orin X | Ampere GPU + 第3代 TC | 275 INT8 TOPS (sparse) | 32/64GB LPDDR5, 204-273 GB/s | CUDA, TensorRT | 15-60W |
| **高通** | SA8797 | Hexagon NPU + Adreno GPU | 320 TOPS (dense) | LPDDR5X | SNPE/QNN, OpenCL/Vulkan | 模块化 |
| **地平线** | 征程 6P | BPU 纳什（第4代） | 560 TOPS | — | 天工开物 4.0 | — |
| **地平线** | 征程 5 | BPU 贝叶斯（第3代） | 128 TOPS | LPDDR4 | 天工开物 | 20-35W |
| **华为** | MDC 610 | Da Vinci 达芬奇核 | 200 TOPS (dense INT8) | — | CANN, ACL | — |
| **Mobileye** | EyeQ6H | 专有 CNN 加速器 | \~128 TOPS | — | EyeQ Kit SDK | 低功耗 |
| **黑芝麻** | 华山 A2000 Pro | 九韶 NPU | 1000+ TOPS | — | 自研工具链 | — |
| **特斯拉** | FSD HW4 | 自研 NPU（3核/SoC） | \~243 TOPS（双SoC） | 每核 32MB SRAM | 完全封闭 | — |

> ⚠️ 注意：表中算力数字口径混杂（稀疏 vs 稠密、INT8 vs FP8），不可直接横比，详见第五章分析。

### 4.2 各平台架构特点（通俗解读）

#### NVIDIA：通用 GPU + 最成熟生态

NVIDIA 走的是"通用 GPU + 成熟软件生态"路线。CUDA 是事实标准，cuDNN/cuBLAS/TensorRT 几乎"开箱即用且接近峰值"。

**优势**：灵活性最高，几乎什么模型都能跑，开发者生态最大  
**劣势**：功耗相对高（通用硬件的代价），价格贵

**Thor 的亮点**：第 5 代 Tensor Core 原生支持 FP8 和 FP4（Transformer Engine），这是为 Transformer 大模型上车专门设计的。我们的实测已验证 Blackwell 架构的 INT8 效率达 96.1%。

#### 高通：异构 + 低功耗

高通走"异构计算 + 低功耗"路线。Hexagon NPU 内部有标量、矢量、张量三类加速器，配合 Adreno GPU 做异构分工。

**优势**：能效比好，座舱-智驾融合（舱驾一体）能力强  
**劣势**：SDK 从 SNPE 过渡到 QNN 再到 QAIRT，生态碎片化；算子库成熟度不如 NVIDIA

#### 地平线：软硬件结合 + 效能优先

地平线不追求暴力堆算力，而是为自动驾驶视觉任务定制 BPU 架构。征程 5 强调"从 TOPS 到 FPS 的效能突围"——同样 128 TOPS，实际帧率可能比通用 NPU 更高。

**优势**：针对 AD 感知任务深度优化，性价比高  
**劣势**：通用性受限，非常规算子可能需要厂商 FAE 深度介入

#### 华为：对标 CUDA 的完整生态

华为的 Da Vinci 架构 + CANN 软件栈是对标 NVIDIA CUDA 最完整的国产方案。提供了"从 CUDA 到 CANN 的迁移指南"，算子库 CATLASS 对标 cuBLAS。

**优势**：国产自主可控，生态相对完整  
**劣势**：国际市场认可度有限，部分算子优化仍在追赶

#### 特斯拉：算法定义硬件

特斯拉是"全栈自研自用"的极端案例。NPU 专为自家神经网络定制，每核 32MB SRAM 存权重减少 DRAM 访问。账面算力（\~243 TOPS）远低于 Thor（1000+ TOPS），但靠算法-硬件深度协同保持竞争力。

**特点**：完全封闭，第三方无法编程，不可作为选型参考。

### 4.3 编程接口对比

| 维度 | CUDA (NVIDIA) | OpenCL/SYCL | 厂商专有 SDK |
|-|-|-|-|
| 类比 | 方言，本地好使 | 普通话，各地口音不同 | 各地方言 |
| 生态成熟度 | 事实标准 | 标准统一但库薄 | 各自为政 |
| 跨平台 | 仅 NVIDIA | 理论跨厂商 | 完全不通用 |
| 性能上限 | 最高 | 接近原生但不保证 | 对本地硬件优化最深 |

### 4.4 量化精度支持矩阵

| 平台 | INT8 | FP16 | BF16 | FP8 | FP4 |
|-|-|-|-|-|-|
| NVIDIA Thor | ✅ | ✅ | ✅ | ✅ | ✅ |
| NVIDIA Orin | ✅ | ✅ | 部分 | ✗ | ✗ |
| 高通 SA8797 | ✅ | ✅ | ✗ | 部分 | ✗ |
| 地平线征程6 | ✅ | ✅ | ✗ | 部分 | ✗ |
| 华为昇腾 | ✅ | ✅ | ✅ | 部分 | ✗ |
| 黑芝麻 A2000 | ✅ | ✅ | ✗ | ✅ | ✗ |
| 特斯拉 HW4 | ✅ | ✅ | ✗ | ✗ | ✗ |

**关键发现**：FP8/FP4 是新战场，主要被 NVIDIA Thor 推动（为 Transformer 推理设计），国产芯片正在跟进。

---

## 第五章 跨平台性能对比的核心难点

### 5.1 为什么 TOPS 不能直接横比

这是整个报告最关键的问题之一。TOPS 数字严重依赖以下假设，而这些假设在不同平台间差异巨大：

#### 原因一："一次操作"的定义不同

- NVIDIA Tensor Core 将 4×4 矩阵乘法视为一组 fused operation
- 某些 NPU 将 MAC（乘加）计为 2 次操作
- 稀疏加速可将 TOPS 翻倍（见下文）

#### 原因二：利用率差异巨大

| 平台类型 | GEMM 利用率 | 混合推理利用率 |
|-|-|-|
| NVIDIA GPU（TensorRT） | 70-90% | 40-60% |
| 高通 Hexagon NPU | 50-70% | 30-50% |
| 地平线 BPU | 60-80% | 35-55% |

#### 原因三：稀疏加速的"水分"

NVIDIA Ampere 及之后架构支持 **2:4 结构化稀疏**：每 4 个元素中有 2 个为零，官方宣称 INT8 TOPS 翻倍。

**实际情况**：

- 并非所有模型都能达到 2:4 稀疏而不损失精度
- 实际加速通常在 1.3\~1.7×，而非理论 2×
- 不同平台的稀疏策略不同（NVIDIA 2:4 vs 其他厂商的 block sparsity）

**建议**：比较 TOPS 时必须明确标注**是否包含稀疏加速**，同时给出 dense TOPS 和 sparse TOPS。

#### 原因四：内存子系统的隐性瓶颈

即使两个芯片标称相同 TOPS，如果内存带宽差异大，实际性能可能相差数倍。

| 内存类型 | 典型带宽 | 实际可用比例 |
|-|-|-|
| HBM3 | \~3.35 TB/s | 80-90% |
| GDDR6X | \~1 TB/s | 75-85% |
| LPDDR5X | \~273 GB/s | 60-80% |

车载 SoC 普遍用 LPDDR，带宽远低于数据中心 GPU 的 HBM——这意味着车载推理更容易成为**带宽瓶颈**。

### 5.2 算子覆盖率的影响

即使一个 NPU 在 GEMM 上达到 80% 利用率，如果模型中有 30% 的计算在不支持的算子上（fallback 到 CPU），整体性能将大打折扣——这是**Amdahl 定律**的体现。

| 算子类型 | NVIDIA GPU | 高通 NPU | 地平线 BPU |
|-|-|-|-|
| GEMM/MatMul | ★★★★★ | ★★★★☆ | ★★★★☆ |
| Conv2d/Conv3d | ★★★★★ | ★★★★☆ | ★★★★☆ |
| Attention (MHA) | ★★★★★ | ★★★☆☆ | ★★☆☆☆ |
| Deformable Conv | ★★★★☆ | ★★★☆☆ | ★★★☆☆ |
| 自定义算子 | ★★★★★ | ★★☆☆☆ | ★★☆☆☆ |

### 5.3 "等效算力"是否可行？

**结论：理论上诱人，实践中极难建立公认的换算系数。**

难点：

1. 算子依赖性——同一芯片对不同算子利用率不同，单一系数无法代表
2. 带宽/算力耦合——瓶颈类型决定等效系数
3. 精度格式差异——FP8 换算 INT8 没有理论比例
4. 生态成熟度不可量化——软件优化是最大变量
5. 缺乏中立测试机构

**更务实的替代方案**：放弃"等效 TOPS"，直接用"标准化智驾 workload 的实测 FPS / 延迟 / 能效"做对比。

---

## 第六章 自动驾驶场景下的推理能力衡量

### 6.1 自动驾驶模型的 Workload 特征

#### 算子分布差异大

| 模型类型 | 主要算子 | 运算强度特点 |
|-|-|-|
| ResNet/EfficientNet（图像分类） | Conv2d + BN + ReLU | Conv 占 95%+ 计算量 |
| BEVFormer（3D 检测） | Deformable Attention + GEMM | Attention 不规则访存，严重 memory-bound |
| CenterPoint（激光检测） | 稀疏卷积 + GEMM | 稀疏卷积导致利用率波动 |
| PointPillars（点云检测） | PillarScatter + Conv + GEMM | Scatter 操作 memory-bound |

#### Batch=1 是常态

自动驾驶最常见的是 **batch=1**（逐帧处理），此时 GPU 利用率可能仅 0\~1%——这与 MLPerf 数据中心场景（大 batch）截然不同。

#### 实时性要求

| 评估维度 | 典型指标 | L4 目标值 |
|-|-|-|
| 感知延迟 | 单帧处理时间 | < 33ms（30 FPS） |
| 端到端延迟 | 传感器输入到控制输出 | < 100ms |
| 尾延迟 | p99.9 延迟 | < 2× 平均延迟 |
| 功耗 | 系统总功耗 | < 300W（乘用车） |

### 6.2 为什么传统指标不够

#### FLOPS/OPS 的局限

> "A stalled processor delivers zero effective TOPS" —— Fixstar 博客

一个被数据搬运阻塞的处理器，算力再高也是零。TOPS 只衡量"理论能力"，不衡量"实际发挥"。

#### "峰值" vs "实际可用"的鸿沟

| 场景 | 典型利用率 |
|-|-|
| 大 GEMM（矩阵乘法） | 70-90% |
| 卷积运算 | 50-70% |
| 混合 AI 推理 | 30-50% |
| Batch=1 推理 | 0-10% |

#### Roofline 模型在深度学习中的局限

经典 Roofline 模型假设规则的内存访问模式，但深度学习中有大量**不规则访存**（如 Deformable Attention 的采样点、稀疏卷积的非零元素），这些开销在 Roofline 中无法体现。

### 6.3 更好的衡量方法

#### 方法一：Workload-Specific Benchmark

基于真实模型 profile 的 benchmark——不用通用 ResNet，而是用我们自己的 BEV/PointPillars 模型作为测试负载。

**优点**：结果直接可指导决策  
**缺点**：不可跨公司比较

#### 方法二：End-to-End Inference Benchmark

端到端推理延迟——从输入一帧图像到输出检测结果的全链路时间。

**优点**：最贴近真实使用场景  
**缺点**：包含预处理/后处理开销，不纯粹

#### 方法三：Constant Stream（MLPerf Automotive 的做法）

按固定帧率发送请求，测量在该帧率下的延迟分布——这比"暴力测最大吞吐"更有意义，因为自动驾驶传感器是固定帧率采样的。

#### 方法四：Power-Aware Benchmark

功耗约束下的性能——在固定功耗预算（如 60W）下测最大推理吞吐。

**关键指标**：FPS/Watt（每瓦帧率）或 TOPS/Watt

#### 方法五：Sustained Performance 测试

长时间运行（如 1 小时）后性能是否衰减——车规芯片在高温下会**热节流（thermal throttling）**。

**关键指标**：Sustained Performance Ratio = 持续性能 / 峰值性能

#### 方法六："Usable TOPS" 概念

综合利用率、持续因子、workload 匹配度的"可用算力"：

> **Usable TOPS = Peak TOPS × Utilization × Sustained Factor × Workload Match Factor**

其中：

- Utilization：目标 workload 下的平均利用率
- Sustained Factor：热稳定后的性能保持比
- Workload Match Factor：算子库对该 workload 的覆盖度

### 6.4 业界最佳实践

#### Tesla

- 使用自研 TPU/NPU + 自研算法的深度协同
- 核心指标：端到端感知-规划流水线延迟
- 从公开信息看，重视尾延迟（p99.9）和多传感器融合的延迟预算

#### Waymo

- 自研 TPU + NVIDIA GPU 组合
- 端到端感知-规划-控制流水线延迟作为核心指标
- 通常端到端延迟预算 < 100ms

#### 百度 Apollo

- 使用 NVIDIA Orin 作为主要计算平台
- 关注帧率（FPS）和端到端延迟
- 在 MLPerf 中有参与提交

#### 行业通用的做法

不只看厂商 PPT 上的 TOPS，而是要求在**真实模型 + 真实数据**上实测 FPS/延迟/能效。

---

## 第七章 推荐评估框架设计

### 7.1 分层评估策略

基于调研结果，我们推荐采用**三层 + 两翼**的评估框架：

```
                    ┌───────────────────────────┐
                    │   第三层：System-Level      │
                    │   多任务并发/功耗/热稳定性   │
                    └──────────┬────────────────┘
                               │
                    ┌──────────┴────────────────┐
                    │   第二层：Workload-Level    │
                    │   真实AD模型端到端推理       │
                    └──────────┬────────────────┘
                               │
                    ┌──────────┴────────────────┐
                    │   第一层：Micro-Benchmark   │
                    │   算力峰值/带宽/Roofline    │
                    └───────────────────────────┘

          ┌─────────────────┐    ┌──────────────────┐
          │  左翼：功耗效率   │    │  右翼：精度验证    │
          │  FPS/W, 降频曲线  │    │  量化精度损失评估  │
          └─────────────────┘    └──────────────────┘
```

### 7.2 各层详细设计

#### 第一层：Micro-Benchmark（我们已有的基础 + 补强）

| 测试项 | 已有/新增 | 推荐工具 | 目的 |
|-|-|-|-|
| GPU 算力峰值（各精度） | ✅ 已有 | gpu_bench + CUTLASS profiler | 验证硬件峰值 |
| 内存带宽 | ✅ 已有 | BabelStream | 获取实际可用带宽 |
| Roofline 曲线 | 🆕 新增 | mixbench + gpu_bench roofline suite | 构建完整的运算强度-性能曲线 |
| 跨平台峰值 | 🆕 新增 | clpeak（Vulkan/OpenCL） | 非 NVIDIA 平台的基线 |
| 延迟测试 | ⬆ 扩展 | gpu_bench latency suite + 补充 CUDA Graph | kernel launch、空包传输延迟曲线 |
| DLA 测试 | ✅ 已有 | gpu_bench DLA suite | Orin X DLA 子单元评估 |

#### 第二层：Workload-Level Benchmark（关键缺口）

| 测试项 | 推荐方法 | 工具 |
|-|-|-|
| MLPerf Automotive 对齐 | BEVFormer-tiny + SSD + DeepLabv3+ | MLPerf LoadGen + TensorRT |
| 自有模型 benchmark | BEV/Occupancy/PointPillars 端到端 | ONNX Runtime（多 EP） + trtexec |
| 非方阵 GEMM | 推理 shape 的 GEMM 测试 | gpu_bench 扩展 |
| 卷积测试 | cuDNN Conv 算力测试 | gpu_bench 扩展 Phase 3 |

#### 第三层：System-Level Benchmark

| 测试项 | 方法 | 关键指标 |
|-|-|-|
| 多任务并发 | 感知+规划+控制同时运行 | 各任务端到端延迟是否满足 budget |
| 功耗效率 | NVML 采集满载功耗 | FPS/Watt |
| 热节流 | 1小时持续满载 | Sustained Performance Ratio |
| 多流并发 | 多 stream GEMM 并发 | GPU 真实占用率天花板 |

#### 左翼：功耗与热稳定性

| 测试项 | 工具 | 关键指标 |
|-|-|-|
| 实时功耗/频率/温度 | NVML（NVIDIA） | GFLOPS/Watt |
| 长时间降频曲线 | gpu-burn + NVML | 降频起始时间、稳态频率 |
| 不同功耗模式对比 | nvpmodel（NVIDIA） | 各模式下性能/功耗 Pareto |

#### 右翼：精度验证

| 测试项 | 方法 | 关键指标 |
|-|-|-|
| INT8 量化精度损失 | FP32 vs INT8 mAP/NDS | 精度下降百分比 |
| FP8 精度评估 | FP8 vs FP16 对比 | 精度-性能 trade-off |
| GEMM 数值正确性 | 与 FP64 reference 对比 | 最大误差、平均误差 |

### 7.3 建议的测试矩阵

```
精度维度:    FP32 × FP16 × BF16 × INT8 × FP8（按平台支持）
算子维度:    GEMM × Conv2d × Attention × Element-wise × 混合
Shape维度:   方阵(4096²) × 非方阵(batch=1~64) × 推理实际shape
并发维度:    单流 × 2流 × 4流 × 8流
时间维度:    短跑(warmup+20次) × 中跑(10min) × 长跑(1h)
```

### 7.4 指标体系设计

| 指标类别 | 具体指标 | 说明 |
|-|-|-|
| **吞吐** | FPS, samples/sec, TFLOPS/TOPS | 单位时间处理量 |
| **延迟** | p50, p90, p99, **p99.9** | 延迟百分位（p99.9 是安全关键） |
| **效率** | 利用率(%), 效率(实测/理论) | 硬件利用程度 |
| **能效** | FPS/Watt, TOPS/Watt | 功耗约束下性能 |
| **稳定性** | Sustained Ratio, 降频曲线 | 长时间运行能力 |
| **精度** | mAP/NDS 下降比 | 量化后精度保持 |

### 7.5 可视化方法建议

1. **Roofline 图**：每个平台一条曲线，直观对比计算/带宽瓶颈
2. **Radar 图**：多维度对比（吞吐、延迟、能效、精度、稳定性、生态）
3. **Pareto 前沿图**：性能 vs 功耗、性能 vs 精度的 trade-off 可视化
4. **时间序列图**：长时间运行的性能/温度/频率曲线

### 7.6 平台维度工具选型速查

| 目标芯片平台 | 推荐主力工具 |
|-|-|
| NVIDIA Orin / Thor | CUTLASS profiler + trtexec + Nsight + MLPerf Auto |
| 高通 SA8797 (Adreno + Hexagon) | ONNX Runtime(QNN EP) + clpeak(Vulkan) |
| Arm Mali / 国产 NPU | clpeak + mixbench(SYCL/OpenCL) + ONNX Runtime |
| 跨平台统一对比 | ONNX Runtime(多EP) + BabelStream + mixbench + MLPerf |

### 7.7 落地优先级建议

| 优先级 | 任务 | 理由 |
|-|-|-|
| **P0** | 对齐 MLPerf Automotive | 唯一标准化公开 AD 基准 |
| **P0** | 引入 CUTLASS profiler | 诊断 Tensor Core 利用率 |
| **P0** | 引入 NVML 功耗/频率采集 | 补齐效率与能耗维度 |
| **P1** | 部署 ONNX Runtime 多 EP 评估 | 多平台可比性 |
| **P1** | 补充非方阵 GEMM + Conv 测试 | 覆盖推理真实 shape |
| **P1** | 多流并发测试 | 测 GPU 真实占用率 |
| **P2** | 引入 mixbench 构建 Roofline | 多芯片深度对比 |
| **P2** | 长时间热稳定性测试 | 车规验证 |
| **P3** | 跨平台 clpeak 部署 | 非 NVIDIA 平台基线 |

---

## 第八章 参考文献

### 学术论文

| # | 论文 | 作者 | 年份 | 核心贡献 |
|-|-|-|-|-|
| 1 | "MLPerf Inference Benchmark" (arXiv:1911.02549) | VJ Reddi et al. | 2019 | AI 推理基准测试工业标准，930+ 引用 |
| 2 | "MLPerf Tiny Benchmark" (arXiv:2106.07597) | Banbury, Reddi et al. | 2021 | TinyML 嵌入式基准 |
| 3 | "MLPerf Automotive" (arXiv:2510.27065) | Shojaei, Owens et al. | 2025 | 首个标准化自动驾驶 ML 基准 |
| 4 | "Roofline: An Insightful Visual Performance Model for Multicore Architectures" | Williams, Waterman, Patterson | 2009 | Roofline 性能模型，3969+ 引用 |
| 5 | "An Investigation of FP8 Across Accelerators for LLM Inference" (arXiv:2502.01070) | — | 2025 | FP8 跨平台性能对比 |
| 6 | "A Survey on Deep Learning Hardware Accelerators" (arXiv:2306.15552) | — | 2023 | 加速器架构综合综述 |
| 7 | "SHOC: A Scalable HeterOgeneous Computing Benchmark Suite" | Danial et al. | 2010 | 异构计算基准，800+ 引用 |

### 开源项目

| # | 项目 | URL |
|-|-|-|
| 1 | MLPerf Inference | [https://github.com/mlcommons/inference](https://github.com/mlcommons/inference) |
| 2 | MLPerf Tiny | [https://github.com/mlcommons/tiny](https://github.com/mlcommons/tiny) |
| 3 | Collective Knowledge (CK) | [https://github.com/mlcommons/ck](https://github.com/mlcommons/ck) |
| 4 | NVIDIA CUTLASS | [https://github.com/NVIDIA/cutlass](https://github.com/NVIDIA/cutlass) |
| 5 | NVIDIA cuda-samples | [https://github.com/NVIDIA/cuda-samples](https://github.com/NVIDIA/cuda-samples) |
| 6 | NVIDIA TensorRT | [https://github.com/NVIDIA/TensorRT](https://github.com/NVIDIA/TensorRT) |
| 7 | BabelStream | [https://github.com/UoB-HPC/BabelStream](https://github.com/UoB-HPC/BabelStream) |
| 8 | SHOC | [https://github.com/vetter/shoc](https://github.com/vetter/shoc) |
| 9 | gpu-burn | [https://github.com/wilicc/gpu-burn](https://github.com/wilicc/gpu-burn) |
| 10 | mixbench | [https://github.com/ekondis/mixbench](https://github.com/ekondis/mixbench) |
| 11 | clpeak | [https://github.com/krrishnarraj/clpeak](https://github.com/krrishnarraj/clpeak) |
| 12 | ai-benchmark | [https://github.com/Project-HAMi/ai-benchmark](https://github.com/Project-HAMi/ai-benchmark) |
| 13 | ONNX Runtime | [https://github.com/microsoft/onnxruntime](https://github.com/microsoft/onnxruntime) |
| 14 | llama.cpp | [https://github.com/ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp) |
| 15 | Kompute (Vulkan Compute) | [https://github.com/KomputeProject/kompute](https://github.com/KomputeProject/kompute) |

### 厂商文档与资源

| # | 资源 | URL |
|-|-|-|
| 1 | NVIDIA DRIVE AGX Thor 文档 | [https://developer.nvidia.com/drive/downloads](https://developer.nvidia.com/drive/downloads) |
| 2 | NVIDIA Jetson AGX Orin 技术简报 | [https://www.nvidia.com/content/dam/en-zz/Solutions/gtcf21/jetson-orin/nvidia-jetson-agx-orin-technical-brief.pdf](https://www.nvidia.com/content/dam/en-zz/Solutions/gtcf21/jetson-orin/nvidia-jetson-agx-orin-technical-brief.pdf) |
| 3 | NVIDIA Deep Learning Performance Guide | [https://docs.nvidia.com/deeplearning/performance/](https://docs.nvidia.com/deeplearning/performance/) |
| 4 | NVIDIA Nsight Compute | [https://developer.nvidia.com/nsight-compute](https://developer.nvidia.com/nsight-compute) |
| 5 | NVIDIA Nsight Systems | [https://developer.nvidia.com/nsight-systems](https://developer.nvidia.com/nsight-systems) |
| 6 | Qualcomm Snapdragon Ride | [https://www.qualcomm.com/automotive/solutions/snapdragon-ride](https://www.qualcomm.com/automotive/solutions/snapdragon-ride) |
| 7 | Qualcomm Neural Processing SDK | [https://www.qualcomm.com/developer/software/neural-processing-sdk-for-ai](https://www.qualcomm.com/developer/software/neural-processing-sdk-for-ai) |
| 8 | 地平线征程 6 系列 | [https://www.horizon.auto/solutions/horizon-journey/horizon-journey6](https://www.horizon.auto/solutions/horizon-journey/horizon-journey6) |
| 9 | 华为昇腾计算 | [https://e.huawei.com/cn/products/computing/ascend](https://e.huawei.com/cn/products/computing/ascend) |
| 10 | 华为 CANN 学习中心 | [https://www.hiascend.com/cann/learn](https://www.hiascend.com/cann/learn) |
| 11 | Mobileye EyeQ 芯片 | [https://www.mobileye.com/technology/eyeq-chip/](https://www.mobileye.com/technology/eyeq-chip/) |
| 12 | 黑芝麻华山系列 | [https://www.blacksesame.com](https://www.blacksesame.com) |
| 13 | Tesla Autopilot Hardware | [https://en.wikipedia.org/wiki/Tesla_Autopilot_hardware](https://en.wikipedia.org/wiki/Tesla_Autopilot_hardware) |
| 14 | MLPerf Automotive 官方页面 | [https://mlcommons.org/2025/04/auto-inference-v5/](https://mlcommons.org/2025/04/auto-inference-v5/) |
| 15 | STREAM Benchmark | [https://www.cs.virginia.edu/stream/](https://www.cs.virginia.edu/stream/) |
| 16 | nuScenes 数据集 | [https://www.nuscenes.org](https://www.nuscenes.org) |
| 17 | KITTI 数据集 | [https://www.cvlibs.net/datasets/kitti/](https://www.cvlibs.net/datasets/kitti/) |
| 18 | Waymo Open Dataset | [https://waymo.com/open/](https://waymo.com/open/) |

### 行业分析

| # | 来源 | 说明 |
|-|-|-|
| 1 | SemiAnalysis | Tesla AI 芯片分析 |
| 2 | EET-China | "1000 TOPS 之后算力竞赛" |
| 3 | 42how.com | 算力利用率讨论 |
| 4 | Embedded Vision Summit | 行业会议相关演讲 |

---

## 附录：关键术语速查表

| 术语 | 全称 | 通俗解释 |
|-|-|-|
| TOPS | Tera Operations Per Second | 每秒万亿次操作，衡量计算"马力" |
| TFLOPS | Tera Floating-Point Operations Per Second | 每秒万亿次浮点运算 |
| GEMM | General Matrix Multiply | 通用矩阵乘法，AI 推理最常见的计算 |
| Tensor Core | — | NVIDIA GPU 中专门做矩阵乘法的硬件单元 |
| DLA | Deep Learning Accelerator | NVIDIA 的深度学习专用加速器（Orin 有，Thor 没有） |
| NPU | Neural Processing Unit | 神经网络处理单元，AI 专用硬件 |
| BPU | Brain Processing Unit | 地平线自研的 AI 处理器名称 |
| Roofline | — | 性能分析模型，判断计算瓶颈是"算不过来"还是"搬不过来" |
| Arithmetic Intensity | — | 运算强度，每字节数据对应多少次运算 |
| Ridge Point | — | Roofline 拐点，计算瓶颈和带宽瓶颈的分界线 |
| PTQ | Post-Training Quantization | 训练后量化，把 FP32 模型转成 INT8 |
| QAT | Quantization-Aware Training | 量化感知训练，训练时就考虑量化误差 |
| Memory Bound | — | 带宽瓶颈，数据搬运速度限制了计算速度 |
| Compute Bound | — | 计算瓶颈，计算单元本身不够快 |
| Thermal Throttling | — | 热节流，温度太高自动降频保护 |
| Sustained Performance | — | 持续性能，长时间运行后能保持的性能水平 |
| Tail Latency | — | 尾部延迟，偶尔出现的最慢的那些请求的延迟 |
| BEV | Bird's Eye View | 鸟瞰图视角，自动驾驶常用的感知表示方式 |
