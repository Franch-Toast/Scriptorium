---
title: "Church 中间件详细指南"
date: 2026-09-20
description: "Church 是 Deeproute.ai 自研的自动驾驶中间件框架，主要用于自动驾驶系统中各个模块之间的数据通信和任务调度。它的设计理念类似于 ROS（Rob"
categories:
  - 正典阁
tags:
  - Church
---

# Church 中间件详细指南

## 1. 概述

### 1.1 什么是 Church？

Church 是 Deeproute.ai 自研的**自动驾驶中间件框架**，主要用于自动驾驶系统中各个模块之间的**数据通信和任务调度**。它的设计理念类似于 ROS（Robot Operating System），但针对自动驾驶场景进行了深度优化。

### 1.2 Church 与 ROS 的对比

| 特性 | Church | ROS |
|-|-|-|
| 通信模式 | 发布/订阅模式 | 发布/订阅模式 |
| 消息格式 | Protocol Buffers | 自定义 msg 格式 |
| 传输层 | 多种（ICEORYX/SHM/ROS/进程内） | DDS/TCP/UDP |
| 零拷贝支持 | 是（ICEORYX） | ROS2 支持 |
| 组件化 | 内置 Component 抽象 | ROS2 有类似概念 |
| 调度器 | 内置多种调度策略 | 依赖外部 |

### 1.3 核心优势

1. **高性能零拷贝通信**：通过 ICEORYX 共享内存实现进程间零拷贝数据传输
2. **灵活的传输层**：支持 ROS、共享内存、ICEORYX、进程内通信等多种传输方式
3. **组件化设计**：提供 Component 抽象，简化模块开发
4. **丰富的调度策略**：支持周期性、事件驱动、条件触发等多种调度方式
5. **完善的监控机制**：内置消息丢失检测、延迟监控等功能

---

## 2. 核心架构

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                          应用层 (Application Layer)                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │  Component   │  │  Component   │  │ Custom Node  │               │
│  │  (感知模块)   │  │  (规划模块)   │  │ (设备管理)   │               │
│  └──────────────┘  └──────────────┘  └──────────────┘               │
├─────────────────────────────────────────────────────────────────────┤
│                           节点层 (Node Layer)                         │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                        Node (节点)                              │ │
│  │  ┌─────────────┐           ┌──────────────┐                    │ │
│  │  │  Publisher  │           │  Subscriber  │                    │ │
│  │  │   (发布者)   │           │   (订阅者)    │                    │ │
│  │  └─────────────┘           └──────────────┘                    │ │
│  └────────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────┤
│                         传输层 (Transport Layer)                      │
│  ┌─────────────┐ ┌─────────────┐ ┌───────────┐ ┌─────────────────┐ │
│  │   ICEORYX   │ │     SHM     │ │    ROS    │ │  INTRA_PROCESS  │ │
│  │  (零拷贝)    │ │  (共享内存)  │ │  (兼容)   │ │   (进程内)      │ │
│  └─────────────┘ └─────────────┘ └───────────┘ └─────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 核心概念

#### 2.2.1 Node（节点）

`Node` 是 Church 中最基础的通信实体。每个节点可以：

- 创建多个 Publisher（发布者）
- 创建多个 Subscriber（订阅者）
- 发布和接收消息

**定义位置**：`church/node/node.h`

```cpp
namespace deeproute::church::node {

class Node {
 public:
  // 构造函数，name 是节点唯一标识
  Node(const std::string& name, uint32_t latency_threshold = kLatencyWarnThreshold);

  // 添加发布者
  template <typename M>
  bool AddPublisher(const std::string& topic, 
                    uint32_t queue_size = kQueueSize,
                    ChannelType channel_type = ChannelType::ROS);

  // 添加订阅者（带回调）
  template <typename M>
  bool AddSubscriber(const std::string& topic, 
                     const MessageCallback& callback,
                     uint32_t queue_size = kQueueSize,
                     ChannelType channel_type = ChannelType::ROS);

  // 发布消息
  bool Publish(const std::string& topic, const ProtoBaseMsg& msg);

  // ...
};

}  // namespace deeproute::church::node
```

#### 2.2.2 Publisher（发布者）

Publisher 负责向指定 topic 发送消息。

**定义位置**：`church/node/publisher.h`

```cpp
class Publisher {
 public:
  struct Options {
    Transport* transport;       // 传输层
    ChannelType channel_type;   // 通道类型
    std::string topic;          // 话题名称
    uint32_t queue_size;        // 队列大小
    std::string msg_type;       // 消息类型
    bool latch;                 // 是否锁存最后一条消息
    std::string node_name;      // 所属节点名
  };

  bool Publish(const ProtoBaseMsg& msg);
  bool PublishWithSourceTimestamp(std::shared_ptr<ProtoBaseMsg> msg, 
                                  uint64_t source_timestamp);
};
```

#### 2.2.3 Subscriber（订阅者）

Subscriber 负责从指定 topic 接收消息。

**定义位置**：`church/node/subscriber.h`

```cpp
class Subscriber {
 public:
  struct Options {
    Transport* transport;       // 传输层
    ChannelType channel_type;   // 通道类型
    std::string topic;          // 话题名称
    uint32_t queue_size;        // 队列大小
    MessageCallback callback;   // 消息回调函数
    std::string msg_type;       // 消息类型
    bool lazy_payload;          // 是否延迟解析
  };

  void Suspend();   // 暂停接收
  void Resume();    // 恢复接收
};
```

#### 2.2.4 OnboardMessage（消息）

`OnboardMessage` 是 Church 中消息的统一封装，包含：

- **Header**：消息头（时间戳、序列号、发送者等元信息）
- **Payload**：消息体（实际的 protobuf 数据）

**定义位置**：`church/node/onboard_message.h`

```cpp
class OnboardMessage {
 public:
  // 获取消息头
  std::shared_ptr<const OnboardHeader> header() const;

  // 获取消息体
  std::shared_ptr<const ProtoBaseMsg> payload() const;

  // 获取时间戳
  uint64_t GetTimestamp() const;
  uint64_t GetSourceTimestamp() const;

  // 获取发送者名称
  const std::string& sender_name() const;

  // 获取话题名
  const std::string& topic() const;

  // 获取序列号
  uint32_t sequence_num() const;
};
```

#### 2.2.5 ChannelType（通道类型）

Church 支持多种传输通道：

**定义位置**：`church/proto/channel_type.proto`

```protobuf
enum ChannelType {
  UNKNOWN = 0;
  ROS = 1;              // ROS 兼容模式
  INTRA_PROCESS = 2;    // 进程内通信（最快，无序列化）
  SHM = 3;              // 共享内存
  ICEORYX = 4;          // ICEORYX 零拷贝（推荐用于大数据）
}
```

**选择建议**：

| 场景 | 推荐通道类型 | 原因 |
|-|-|-|
| 同进程内组件通信 | INTRA_PROCESS | 无需序列化，最快 |
| 大数据包（点云、图像） | ICEORYX | 零拷贝，低延迟 |
| 小数据包 | SHM 或 ROS | 开销小 |
| 需要与 ROS 系统对接 | ROS | 兼容性 |

---

## 3. 基于 device_manager.cpp 的使用教程

现在让我们结合实际代码 `device_manager.cpp` 来理解如何使用 Church。

### 3.1 代码结构分析

```cpp
// device_manager.h 中的关键代码
class DeviceManager : public DeviceManagerBase {
 private:
  // 创建一个 Church 节点，名称为 "device_manager_node"
  Node church_node_{"device_manager_node"};

  // 设备实例
  std::shared_ptr<lp_25u1::HesaiAtxDevice> atx_device_;
  std::shared_ptr<lp_25u1::UssDevice> uss_device_;
  std::shared_ptr<lp_25u1::InsDevice> ins_device_;
};
```

### 3.2 初始化订阅者

在 `InitMessageSubscribers()` 方法中，订阅了多个 topic：

```cpp
void DeviceManager::InitMessageSubscribers() {
  // 获取通道类型（从配置中读取）
  ChannelType channel_type = SensorsUtils::CtlChannelType().GetChannelType();

  // 订阅 1: 定位信息 (Pose)
  church_node_.AddSubscriber<Pose>(
      "/localization/pose",                                    // topic 名称
      [&](const std::shared_ptr<const OnboardMessage>& msg) {  // 回调函数
        auto pose_output = std::dynamic_pointer_cast<const Pose>(msg->payload());
        if (pose_output) {
          MsgCallback(pose_output);  // 处理消息
        }
      },
      10,                // 队列大小
      channel_type       // 通道类型
  );

  // 订阅 2: 控制命令 (ControlCommand)
  church_node_.AddSubscriber<ControlCommand>(
      "/leap/state_machine/command",
      [&](const std::shared_ptr<const OnboardMessage>& msg) {
        auto apa_mode = std::dynamic_pointer_cast<const ControlCommand>(msg->payload());
        if (apa_mode) {
          MsgCallback(apa_mode);
        }
      },
      10, channel_type);

  // ... 更多订阅
}
```

### 3.3 消息回调处理

每种消息类型对应一个 `MsgCallback` 重载：

```cpp
// 处理定位数据
void DeviceManager::MsgCallback(std::shared_ptr<const Pose> data) {
  if (uss_device_) {
    uss_device_->UpdatePose(data);  // 更新超声波设备的位姿
  }
}

// 处理控制命令
void DeviceManager::MsgCallback(std::shared_ptr<const ControlCommand> data) {
  if (uss_device_) {
    uss_device_->UpdateControlCommand(data);
  }
}

// 处理车辆信息
void DeviceManager::MsgCallback(std::shared_ptr<const CarInfo> data) {
  if (ins_device_) {
    ins_device_->UpdateCarInfo(data);
  }
}
```

### 3.4 清理资源

在 `Stop()` 方法中清理所有发布者和订阅者：

```cpp
void DeviceManager::Stop() {
  atx_device_->Stop();
  uss_device_->Stop();
  ins_device_->Stop();

  // 清理 Church 节点
  church_node_.ClearAllPublishers();
  church_node_.ClearAllSubscribers();
}
```

### 3.5 完整使用模式总结

```cpp
// 1. 创建节点（通常作为类成员）
Node church_node_{"my_node_name"};

// 2. 添加发布者（如果需要发布消息）
church_node_.AddPublisher<MyMessageType>("/my/topic", queue_size, channel_type);

// 3. 添加订阅者（接收消息）
church_node_.AddSubscriber<MyMessageType>(
    "/other/topic",
    [this](const std::shared_ptr<const OnboardMessage>& msg) {
        auto data = std::dynamic_pointer_cast<const MyMessageType>(msg->payload());
        if (data) {
            ProcessMessage(data);
        }
    },
    queue_size, 
    channel_type
);

// 4. 发布消息
auto msg = std::make_shared<MyMessageType>();
msg->set_field(...);
church_node_.Publish("/my/topic", *msg);

// 5. 清理
church_node_.ClearAllPublishers();
church_node_.ClearAllSubscribers();
```

---

## 4. 发布消息示例

虽然 `device_manager.cpp` 主要是订阅者，让我们看一个发布者示例：

### 4.1 基础发布

```cpp
#include "church/node/node.h"
#include "my_proto/my_message.pb.h"

using deeproute::church::node::Node;
using MyMessage = my_proto::MyMessage;

int main() {
  // 创建节点
  Node talker_node("talker");

  // 添加发布者
  talker_node.AddPublisher<MyMessage>(
      "/channel/my_data",     // topic
      100,                    // 队列大小
      Node::ChannelType::ICEORYX  // 使用 ICEORYX 传输
  );

  // 发布消息
  while (running) {
    auto msg = std::make_shared<MyMessage>();
    msg->set_timestamp(GetCurrentTimeNs());
    msg->set_data("Hello Church!");

    talker_node.Publish("/channel/my_data", *msg);

    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }

  return 0;
}
```

### 4.2 带源时间戳发布

```cpp
// 当需要保留原始数据的时间戳时
auto msg = std::make_shared<SensorData>();
msg->CopyFrom(*sensor_raw_data);

uint64_t source_timestamp = sensor_raw_data->acquisition_time();
talker_node.PublishWithSourceTimestamp("/sensor/data", msg, source_timestamp);
```

---

## 5. Component 组件化编程

Church 提供了更高级的 `Component` 抽象，用于构建标准化的自动驾驶模块。

### 5.1 Component 概述

Component 在 Node 基础上增加了：

- **触发机制（Trigger）**：控制何时执行处理逻辑
- **输入/输出通道配置**：声明式定义
- **生命周期管理**：Init → Startup → Process → Shutdown
- **参数管理**：从配置文件读取参数

### 5.2 创建自定义 Component

```cpp
// my_component.h
#include "church/component/component.h"

namespace my_project {

class MyComponent : public deeproute::church::Component {
 public:
  MyComponent() = default;
  ~MyComponent() = default;

 protected:
  // 初始化（必须实现）
  bool Init() override;

  // 清理（可选）
  void Clear() override;

  // 处理函数（必须实现其中一个）
  bool Proc(const OnboardMessageConstPtrVector& input_msgs,
            OnboardMessagePtrVector* output_msgs) override;

 private:
  // 私有成员
  int counter_ = 0;
};

// 注册组件
CHURCH_REGISTER_COMPONENT(MyComponent);

}  // namespace my_project
```

```cpp
// my_component.cc
#include "my_component.h"

namespace my_project {

bool MyComponent::Init() {
  // 从配置读取参数
  std::string config_path;
  if (GetParam("config_path", &config_path)) {
    MLOG(INFO) << "Config path: " << config_path;
  }
  return true;
}

void MyComponent::Clear() {
  // 清理资源
}

bool MyComponent::Proc(const OnboardMessageConstPtrVector& input_msgs,
                       OnboardMessagePtrVector* output_msgs) {
  // 处理输入
  for (const auto& msg : input_msgs) {
    MLOG(INFO) << "Received message from: " << msg->topic();
    // 处理消息...
  }

  // 生成输出
  auto output = std::make_shared<OutputMessage>();
  output->set_sequence(counter_++);
  output_msgs->emplace_back(MakeOnboardMessage("/output/topic", output));

  return true;
}

}  // namespace my_project
```

### 5.3 Component 配置文件

使用 Jsonnet 格式配置：

```jsonnet
// my_component.jsonnet
{
  "namespace": "my_project",
  "component_name": "MyComponent",
  "param": {
    "config_path": "/path/to/config.yaml",
    "enable_debug": true,
  },
}
```

### 5.4 Task 配置（Proto 格式）

```protobuf
// 定义在 tasks_config.proto 中
message Task {
  optional string name = 1;

  // 触发通道（收到这些通道的消息时触发处理）
  repeated string trigger_channels = 2;

  // 触发策略
  optional TriggerPolicy trigger_policy = 3;

  // 周期（微秒，仅 PERIODIC 策略）
  optional uint64 period = 4;

  // 输入通道配置
  repeated InputChannel input_channels = 6;

  // 输出通道配置
  repeated OutputChannel output_channels = 7;
}

enum TriggerPolicy {
  ANY = 0;       // 任意输入通道收到消息即触发
  CUSTOM = 1;    // 自定义触发逻辑
  PERIODIC = 2;  // 周期性触发
  IMMEDIATE = 3; // 立即触发
}
```

---

## 6. 传输层详解

### 6.1 ICEORYX 传输

ICEORYX 是一个高性能的进程间通信中间件，Church 基于它实现零拷贝传输。

**工作原理**：

1. Publisher 向共享内存申请一块空间
2. 将消息序列化到该空间
3. 通过元数据通知 Subscriber
4. Subscriber 直接从共享内存读取，无需复制

**关键组件**：

- `IceoryxWriter`：写入器，向共享内存写数据
- `IceoryxReader`：读取器，从共享内存读数据
- `IceoryxDispatcher`：调度器，管理消息分发

```cpp
// 使用 ICEORYX
node.AddPublisher<LargePointCloud>(
    "/perception/pointcloud", 
    10, 
    ChannelType::ICEORYX  // 适合大数据
);
```

### 6.2 进程内通信（INTRA_PROCESS）

同一进程内的组件通信，无需序列化，直接传递指针。

```cpp
// 使用进程内通信
node.AddSubscriber<SmallMessage>(
    "/internal/topic",
    callback,
    10,
    ChannelType::INTRA_PROCESS  // 最快
);
```

### 6.3 共享内存（SHM）

Church 自己实现的共享内存池：

```cpp
// church/node/shm/shm_pool.h
class ShmPool {
 public:
  // 添加共享内存段
  void AddSegment(const std::string& key, 
                  uint32_t block_num = 10,
                  uint64_t ceiling_real_msg_size = 16 * 1024);

  // 获取可写块
  ShmBlockPtr AcquireWritabledBlock(const std::string& key, uint32_t size);

  // 获取可读块
  ShmBlockPtr AcquireReadabledBlock(const std::string& key, 
                                    uint32_t index, 
                                    uint64_t seq);
};
```

---

## 7. 高级特性

### 7.1 消息异常监控

Church 内置消息丢失和延迟检测：

```cpp
// 注册消息丢失观察者
node.RegisterMsgLossObserver(
    [](Node* node, const std::shared_ptr<const OnboardMessage>& msg, uint32_t lost_count) {
      MLOG(WARN) << "Topic " << msg->topic() << " lost " << lost_count << " messages!";
    }
);

// 注册传输延迟观察者
node.RegisterMsgTransLongTimeObserver(
    [](Node* node, const std::shared_ptr<const OnboardMessage>& msg, int64_t latency_ms) {
      MLOG(WARN) << "Topic " << msg->topic() << " latency: " << latency_ms << "ms";
    }
);
```

### 7.2 订阅者暂停/恢复

```cpp
// 暂停特定 topic 的订阅
node.SuspendSubscriber("/topic/to/pause");

// 恢复订阅
node.ResumeSubscriber("/topic/to/pause");

// 暂停所有订阅
node.SuspendAllSubscribers();
```

### 7.3 等待消息

```cpp
// 阻塞等待一条消息
auto msg = Node::WaitForMessage<MyMessage>(
    "/topic/name",
    std::chrono::seconds(5),  // 超时时间
    ChannelType::ICEORYX
);

if (msg) {
  MLOG(INFO) << "Received: " << msg->Utf8DebugString();
} else {
  MLOG(ERROR) << "Wait timeout!";
}
```

### 7.4 懒加载（Lazy Payload）

对于大消息，可以延迟解析 payload：

```cpp
// 配置输入通道时启用懒加载
// input_channel.set_lazy_payload(true);

// 只有在访问 payload() 时才会解析
auto onboard_msg = ...;
// 此时 payload 尚未解析
auto header = onboard_msg->header();  // 只解析 header

// 需要数据时才解析
auto data = onboard_msg->payload();  // 此时才解析 payload
```

### 7.5 Topic 黑名单

可以禁止特定 topic 的发布：

```cpp
// 在 blacklist_manager 中配置
// 被列入黑名单的 topic 不会被发布
```

---

## 8. 最佳实践

### 8.1 选择合适的通道类型

```cpp
// 1. 大数据（点云、图像）→ ICEORYX
node.AddPublisher<PointCloud>("/perception/lidar", 10, ChannelType::ICEORYX);

// 2. 小数据、高频 → INTRA_PROCESS（同进程）或 SHM
node.AddPublisher<Pose>("/localization/pose", 100, ChannelType::INTRA_PROCESS);

// 3. 需要与外部 ROS 系统对接 → ROS
node.AddPublisher<Status>("/ros/status", 10, ChannelType::ROS);
```

### 8.2 合理设置队列大小

```cpp
// 高频小消息：较大队列
node.AddSubscriber<HighFreqMsg>("/hf/topic", callback, 100, channel_type);

// 低频大消息：较小队列
node.AddSubscriber<LargeMsg>("/lf/topic", callback, 5, channel_type);
```

### 8.3 回调函数注意事项

```cpp
// ❌ 错误：在回调中做耗时操作
node.AddSubscriber<Data>("/topic", [](auto msg) {
  HeavyProcessing(msg);  // 阻塞回调线程！
});

// ✅ 正确：使用异步处理
node.AddSubscriber<Data>("/topic", [this](auto msg) {
  processing_queue_.Push(msg);  // 放入队列，另一线程处理
});
```

### 8.4 资源清理

```cpp
// 在停止时清理
void MyModule::Stop() {
  // 先停止业务逻辑
  running_ = false;
  worker_thread_.join();

  // 再清理 Church 资源
  node_.ClearAllSubscribers();  // 先停止接收
  node_.ClearAllPublishers();   // 再停止发送
}
```

---

## 9. 调试技巧

### 9.1 日志级别

Church 使用 MLOG 宏进行日志输出：

```cpp
MLOG(INFO) << "Normal info";
MLOG(WARN) << "Warning message";
MLOG(ERROR) << "Error occurred";
MLOG(FATAL) << "Fatal error, will abort";
```

### 9.2 延迟跟踪

```cpp
// 启用延迟日志
Node node("my_node", 100);  // 第二个参数是延迟警告阈值（毫秒）
```

### 9.3 拓扑信息

Church 会自动记录节点的发布/订阅拓扑：

```cpp
// 查看文件：/tmp/church_topo/
// 包含各节点的发布和订阅信息
```

---

## 10. 常见问题

### Q1: 为什么收不到消息？

检查项：

1. topic 名称是否完全一致（包括斜杠）
2. 消息类型是否匹配
3. 通道类型是否一致
4. 发布者是否正常运行

### Q2: 消息延迟很高？

可能原因：

1. 使用了 ROS 通道类型（网络开销）→ 改用 ICEORYX
2. 回调函数耗时过长 → 异步处理
3. 队列太小导致积压 → 增大队列

### Q3: 内存持续增长？

检查：

1. 是否及时释放消息引用
2. 队列大小是否过大
3. 共享内存配置是否合理

---

## 11. 附录

### A. 关键头文件

| 功能 | 头文件 |
|-|-|
| 节点 | `church/node/node.h` |
| 消息 | `church/node/onboard_message.h` |
| 组件 | `church/component/component.h` |
| 时间 | `church/common/church_time.h` |
| 初始化 | `church/common/init.h` |

### B. 目录结构

```
church/
├── base/          # 基础工具库
├── common/        # 通用工具
├── component/     # 组件框架
├── node/          # 节点和通信核心
│   ├── shm/       # 共享内存实现
│   └── topo/      # 拓扑管理
├── proto/         # Protocol Buffers 定义
├── scheduler/     # 调度器
└── examples/      # 示例代码
```

### C. 参考链接

- [ICEORYX 官方文档](https://iceoryx.io/)
- [Protocol Buffers](https://developers.google.com/protocol-buffers)
- [ROS 2 概念对比](https://docs.ros.org/)

---

## 12. 深入理解 FAQ（常见架构问题）

### 12.1 为什么需要 Component？直接用 Node 不行吗？

**问题**：既然有了 Node 节点的订阅、发布功能，只要在进程里使用这个机制，每个进程一个节点，创建发布者、订阅者不就可以了？Component 抽象有什么作用？

#### 答案：Component 解决了 Node 没有解决的问题

**Node 只解决了"通信"问题**，但自动驾驶模块还需要：

| 能力 | Node | Component |
|-|-|-|
| 发布/订阅消息 | ✅ | ✅（内置 Node） |
| 触发时机控制 | ❌ 需手动实现 | ✅ 内置触发器 |
| 输入/输出声明式配置 | ❌ 硬编码 | ✅ Jsonnet 配置 |
| 生命周期管理 | ❌ 手动管理 | ✅ Init→Startup→Process→Shutdown |
| 调度器集成 | ❌ 无 | ✅ 支持多种调度策略 |
| 消息缓存 & 帧同步 | ❌ 需自己实现 | ✅ 内置 ChannelCache |
| 参数管理 | ❌ 无 | ✅ GetParam/SetParam |
| 监控观察者 | ❌ 基础 | ✅ ProcessObserver |

#### Component 的核心价值

**1. 触发机制（Trigger）**

直接用 Node 时，你需要自己决定何时处理消息：

```cpp
// ❌ 用 Node 需要自己实现触发逻辑
class MyModule {
  void OnMessageA(msg) { cache_a_ = msg; TryProcess(); }
  void OnMessageB(msg) { cache_b_ = msg; TryProcess(); }
  void TryProcess() {
    if (cache_a_ && cache_b_) { /* 处理 */ }
  }
};
```

用 Component，触发策略由配置决定：

```jsonnet
// ✅ Component 只需配置即可
task: {
  trigger_policy: 'PERIODIC',  // 周期性触发
  period: 100000,              // 100ms
  // 或者：
  trigger_policy: 'IMMEDIATE', // 收到触发通道消息立即触发
  trigger_channels: ['/sensor/lidar'],
}
```

Church 支持 4 种触发策略（定义在 `tasks_config.proto`）：

```protobuf
enum TriggerPolicy {
  ANY = 0;       // 任意输入通道收到消息即触发（默认）
  CUSTOM = 1;    // 自定义触发逻辑
  PERIODIC = 2;  // 周期性触发（如 100ms 一次）
  IMMEDIATE = 3; // 收到 trigger_channels 消息立即触发
}
```

**2. 与调度器集成**

Component 会被 Church 的调度器（Scheduler）管理：

```
┌─────────────────────────────────────────────────────────────────┐
│                        ChurchApp (mainboard)                     │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    Scheduler 调度器                         ││
│  │   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        ││
│  │   │ Task 线程 1  │  │ Task 线程 2  │  │ Task 线程 3  │        ││
│  │   │ (感知组件)   │  │ (规划组件)   │  │ (控制组件)   │        ││
│  │   └─────────────┘  └─────────────┘  └─────────────┘        ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  每个 Component 被包装成一个 Task，由调度器管理：                │
│  - 创建独立线程                                                 │
│  - 管理消息队列                                                 │
│  - 处理启动/停止                                                │
└─────────────────────────────────────────────────────────────────┘
```

核心代码在 `church/mainboard/church_app.cc`:

```cpp
void ChurchApp::CreateAndStartTask(const ComponentConfig& config,
                                   const std::shared_ptr<Component>& component) {
  // 1. 把 Component 包装成 Task
  task = CreateComponentTask(config.task(), component);

  // 2. 启动 Task（会创建独立线程）
  uint64_t task_id = scheduler->StartOneTask(task, start_option);
  component->SetBindTaskId(task_id);

  // 3. 注册消息接收回调，将消息投递到 Task 的消息队列
  component->node()->RegisterReceiveObserver(
      [task_id](Node*, std::shared_ptr<const OnboardMessage> message) {
        SendComponentProcMessageToTask(task_id, std::move(message));
      });
}
```

**3. 帧同步和消息缓存**

Component 内置 `ChannelCache`，支持：

- 多通道数据的帧同步
- 消息暂存，等待触发时统一取出

```cpp
// Component::Assemble 方法会从 ChannelCache 组装输入数据
bool Component::Assemble(OnboardMessageConstPtrVector& generated_input, int reason) {
  return trigger_->Assemble(generated_input);  // 触发器负责组装
}
```

#### 适用场景对比

| 场景 | 推荐方式 |
|-|-|
| 简单的设备驱动/传感器模块 | **直接用 Node**（如 device_manager.cpp） |
| 复杂算法模块（感知/规划/控制） | **用 Component** |
| 需要周期性处理 | **用 Component** + PERIODIC 触发 |
| 多传感器融合（需帧同步） | **用 Component** + ChannelCache |
| 需要被 mainboard 统一管理 | **用 Component** |

---

### 12.2 IceoryxDispatcher 调度器详解

**问题**：再具体讲解一下 ICEORYX 传输中的 IceoryxDispatcher 调度器是什么意思？和底层的 OS 调度器有什么关系？这个是在 church 进程里有还是在各个使用 church 的进程里有？

#### 答案

**IceoryxDispatcher 是 Church 层面的消息分发调度器，不是 OS 线程调度器**。

#### 1. IceoryxDispatcher 在哪里？

```
每个使用 Church ICEORYX 通道的进程都有一个 IceoryxDispatcher 单例

┌─────────────────────────────────────────────────────────────────┐
│                      进程 A (感知模块)                           │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │           IceoryxDispatcher (单例)                          ││
│  │   ┌───────────────────────────────────────────────────────┐ ││
│  │   │ dispatch 线程 (名称: iceoryx_dispatch)                │ ││
│  │   │                                                       │ ││
│  │   │ 不断轮询/等待 ICEORYX 共享内存中的新消息               │ ││
│  │   │ 有消息到达时，分发给对应的 Reader                     │ ││
│  │   └───────────────────────────────────────────────────────┘ ││
│  │                         ↓                                   ││
│  │   ┌─────────────────────────────────────────────────────┐   ││
│  │   │              Observer 列表                           │   ││
│  │   │  topic1 → IceoryxReader1 → callback1()              │   ││
│  │   │  topic2 → IceoryxReader2 → callback2()              │   ││
│  │   │  topic3 → IceoryxReader3 → callback3()              │   ││
│  │   └─────────────────────────────────────────────────────┘   ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                      进程 B (规划模块)                           │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │           IceoryxDispatcher (独立的单例)                    ││
│  │           ... 类似结构 ...                                  ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

**关键点**：

- 每个进程有**独立的** IceoryxDispatcher 单例
- **不是**跨进程共享的
- 它是一个**消息分发器**，负责把 ICEORYX 收到的消息路由到正确的 Reader

#### 2. IceoryxDispatcher 的工作原理

查看 `church/node/iceoryx_dispatcher.cc` 核心代码：

```cpp
IceoryxDispatcher::IceoryxDispatcher(const TransportConfig::Iceoryx& config)
    : mode_(config.dispatcher_mode) {
  waitset_ = std::make_unique<iox::popo::WaitSet<>>();

  if (mode_ == TransportConfig::Iceoryx::DispatcherMode::kPoll) {
    // 轮询模式：固定频率检查消息
    thread_ = std::make_unique<::deeproute::base::Thread>(
        "iceoryx_dispatch", [this, poll_hz = config.dispatcher_poll_hz]() {
          DispatchRoutineInPollMode(poll_hz);
        });
  } else {
    // 触发模式：等待 ICEORYX 的事件通知
    thread_ = std::make_unique<::deeproute::base::Thread>(
        "iceoryx_dispatch", [this]() { DispatchRoutineInTriggerMode(); });
  }
}
```

**两种模式**：

| 模式 | 工作方式 | 适用场景 |
|-|-|-|
| **Poll 轮询模式** | 固定频率（如 1000Hz）检查是否有新消息 | 对延迟敏感 |
| **Trigger 触发模式** | 使用 ICEORYX 的 WaitSet，有消息才唤醒 | 节省 CPU |

```cpp
// 轮询模式
void IceoryxDispatcher::DispatchRoutineInPollMode(uint64_t poll_hz) {
  church::base::Rate rate(poll_hz);  // 如 1000Hz
  while (!stop_) {
    // 检查每个 topic 是否有数据
    for (const auto& observer : observers_) {
      if (observer->HasData()) {
        observer->ReleasePendingMessages();
        observer->ConsumeAll();  // 消费消息并调用回调
      }
    }
    rate.Sleep();  // 休眠到下一个周期
  }
}

// 触发模式
void IceoryxDispatcher::DispatchRoutineInTriggerMode() {
  auto timeout = iox::units::Duration::fromMilliseconds(10);
  while (!stop_) {
    // 等待 ICEORYX 的事件通知（阻塞）
    auto notificationVector = waitset_->timedWait(timeout);
    for (auto& notification : notificationVector) {
      (*notification)();  // 调用对应的回调
    }
  }
}
```

#### 3. 与 OS 调度器的关系

| 调度器 | 层级 | 职责 |
|-|-|-|
| **OS 线程调度器** | 操作系统层 | 调度系统中所有线程的 CPU 时间片 |
| **IceoryxDispatcher** | Church 中间件层 | 分发 ICEORYX 消息到对应的订阅者回调 |

**IceoryxDispatcher 依赖 OS 调度器**：

- IceoryxDispatcher 创建了一个线程（`iceoryx_dispatch`）
- 这个线程由 OS 调度器调度
- 当该线程被调度运行时，IceoryxDispatcher 才会检查/分发消息

```
OS 调度器视角：
┌─────────────────────────────────────────────────────────────────┐
│  OS 调度器 (Linux CFS / QNX 调度器)                              │
│    │                                                            │
│    ├─→ 主线程                                                   │
│    ├─→ Task 线程 1 (Component1)                                │
│    ├─→ Task 线程 2 (Component2)                                │
│    ├─→ iceoryx_dispatch 线程 (IceoryxDispatcher)  ←── 这里！   │
│    └─→ 其他系统线程                                             │
└─────────────────────────────────────────────────────────────────┘
```

#### 4. 消息流转全过程

```
                    ICEORYX 共享内存
                    ┌──────────────────────┐
                    │   topic: /lidar/pts  │
进程 A (Publisher)  │   [数据块1][数据块2]... │  进程 B (Subscriber)
      │             └──────────────────────┘         │
      │ 1.写入                         2.通知/检测到  │
      └─────────────────────────────────────────────┘
                                            │
                                            ↓
                               ┌────────────────────────────┐
                               │ IceoryxDispatcher (进程B内) │
                               │   dispatch 线程检测到消息   │
                               └────────────────────────────┘
                                            │
                                            ↓ 3. 分发到对应 Observer
                               ┌────────────────────────────┐
                               │ DispatcherObserver        │
                               │   topic: /lidar/pts       │
                               │   reader: IceoryxReader   │
                               └────────────────────────────┘
                                            │
                                            ↓ 4. 调用 Reader 的回调
                               ┌────────────────────────────┐
                               │ IceoryxReader::OnMessage() │
                               │   ↓                        │
                               │ Subscriber 回调            │
                               │   ↓                        │
                               │ 用户注册的 lambda          │
                               └────────────────────────────┘
```

---

### 12.3 消息丢失和延迟检测的实现

**问题**：Church 内置消息丢失和延迟检测在哪里实现了？是自动实现的吗？每个 node 都有吗？

#### 答案

**实现位置**：`church/node/subscriber.cc`

```cpp
// church/node/subscriber.cc
void Subscriber::OnMessageReceived(std::shared_ptr<const OnboardMessage> message) {
  // ⭐ 如果启用了异常检测 && 不是离线回放消息
  if (options_.enable_abnormal_check && !IsPlayMessageOnOffline(message)) {
    CheckMessageLoss(message);      // 检测消息丢失
    CheckMessageTransTime(message); // 检测传输延迟
  }
  options_.callback(message);  // 调用用户回调
}
```

#### 1. 消息丢失检测原理

```cpp
bool Subscriber::CheckMessageLoss(const std::shared_ptr<const OnboardMessage>& message) {
  // 每个发送者维护一个序列号记录
  auto& sequence_num = seq_map_[message->sender_name()];

  if (sequence_num == 0) {
    // 首次收到该发送者的消息
    sequence_num = message->sequence_num();
    return false;
  }

  // 期望的序列号应该是上次 +1
  if (++sequence_num != message->sequence_num()) {
    // ⚠️ 序列号不连续，说明丢失了消息
    MLOG(ERROR) << "[" << options_.topic << "] [" << message->sender_name()
                << "] send to [" << options_.node_name
                << "] loss msg, expect seq: " << sequence_num
                << ", recv seq: " << message->sequence_num();

    // 通知观察者
    if (options_.msg_loss_observer) {
      options_.msg_loss_observer(message, sequence_num);
    }
    sequence_num = message->sequence_num();  // 更新到当前序列号
    return true;
  }
  return false;
}
```

**原理**：

- Publisher 发布消息时会自动递增 `sequence_num`
- Subscriber 跟踪每个发送者的序列号
- 如果收到的序列号跳跃了（不连续），说明中间消息丢失

#### 2. 传输延迟检测原理

```cpp
constexpr int64_t kMsgTransTimeout = 500 * 1000 * 1000;  // 500ms 阈值

bool Subscriber::CheckMessageTransTime(const std::shared_ptr<const OnboardMessage>& message) {
  // 获取当前时间
  uint64_t now = ChurchDataPlaneClockCoarseNow().ToNSec();

  // 计算消息从发送到接收的时间差
  int64_t diff = now > message->header()->dataplane_timestamp()
                     ? (now - message->header()->dataplane_timestamp())
                     : 0;

  if (diff > kMsgTransTimeout) {  // 超过 500ms
    // ⚠️ 传输耗时过长
    MLOG(ERROR) << "[" << options_.topic << "] [" << message->sender_name()
                << "] send to [" << options_.node_name
                << "] trans long time, seq: " << message->sequence_num()
                << ", spent(ns): " << diff;

    // 通知观察者
    if (options_.msg_trans_long_time_observer) {
      options_.msg_trans_long_time_observer(message, diff);
    }
    return true;
  }
  return false;
}
```

**原理**：

- Publisher 发送时在 Header 中记录 `dataplane_timestamp`
- Subscriber 收到时比较当前时间与发送时间
- 差值超过阈值（默认 500ms）则报警

#### 3. 是否默认开启？

**不是默认开启的**，需要在配置中显式启用：

```cpp
// Subscriber::Options 中
struct Options {
  // ...
  bool enable_abnormal_check = true;  // 需要设为 true
  // ...
};
```

对于 Component，在 `input_channels` 配置中启用：

```jsonnet
// tasks_config.proto 中的定义
message InputChannel {
  // ...
  optional bool enable_abnormal_check = 15 [default = false];  // 默认关闭
}
```

```jsonnet
// 在配置文件中启用
input_channels: [
  {
    name: '/sensor/lidar',
    msg_type: 'PointCloud',
    enable_abnormal_check: true,  // ⭐ 显式启用
  },
]
```

#### 4. 如何在 Node 中使用

```cpp
// 方法1：注册全局观察者（所有 topic）
node.RegisterMsgLossObserver(
    [](Node* node, const std::shared_ptr<const OnboardMessage>& msg, uint32_t expected_seq) {
      MLOG(ERROR) << "消息丢失！Topic: " << msg->topic() 
                  << ", 期望序列号: " << expected_seq
                  << ", 实际: " << msg->sequence_num();
    }
);

node.RegisterMsgTransLongTimeObserver(
    [](Node* node, const std::shared_ptr<const OnboardMessage>& msg, int64_t latency_ns) {
      MLOG(ERROR) << "传输延迟过高！Topic: " << msg->topic()
                  << ", 延迟: " << latency_ns / 1000000 << "ms";
    }
);
```

**注意**：这些观察者会被所有启用了 `enable_abnormal_check` 的 Subscriber 调用。

---

### 12.4 完整的 Component 示例分析

**问题**：能找一个例子来讲解 node、component、proto 等的机制的具体实现和过程吗？

#### 答案：以 `component_example` 为例

完整示例位于 `church/examples/component_example/`，让我们逐步解析。

#### 1. 目录结构

```
church/examples/component_example/
├── BUILD                      # Bazel 构建文件
├── common.jsonnet             # 组件配置（输入/输出/触发策略）
├── param.jsonnet              # 组件参数
├── component_example.h        # 组件头文件
└── component_example.cc       # 组件实现
```

#### 2. Proto 消息定义

位于 `church/examples/proto/examples.proto`：

```protobuf
syntax = "proto2";
package deeproute.church.examples.proto;

message Driver {
  optional uint64 timestamp = 1;
  optional string content = 2;
}

message Chatter {
  optional uint64 timestamp = 1;
}

message Context {
  optional string content = 1;
}

message ModuleStatus {
  optional uint64 timestamp = 1;
  optional string module = 2;
  optional string note = 3;
}

message Output {
  optional uint64 timestamp = 1;
  optional uint32 seq = 2;
}
```

#### 3. 组件配置（common.jsonnet）

```jsonnet
{
  components: [
    {
      class_name: 'ComponentExample',  // 对应 CHURCH_REGISTER_COMPONENT 的名称
      config: {
        name: 'Example',               // 组件名称
        param_file_path: "church/examples/component_example/param.jsonnet",
        task: {
          name: 'Example',

          // ⭐ 触发配置
          trigger_channels: ['/channel/driver', '/channel/chatter'],
          trigger_policy: 'PERIODIC',   // 周期性触发
          period: 1000000,              // 1秒 (微秒)

          // ⭐ 输入通道
          input_channels: [
            {
              name: '/channel/driver',
              msg_type: 'deeproute.church.examples.proto.Driver',
              type: 'optional',  // 可选输入
            },
            {
              name: '/channel/chatter',
              msg_type: 'deeproute.church.examples.proto.Chatter',
              type: 'optional',
            },
          ],

          // ⭐ 输出通道
          output_channels: [
            {
              name: '/channel/context',
              msg_type: 'deeproute.church.examples.proto.Context',
            },
            {
              name: '/common/modulestatus',
              msg_type: 'deeproute.church.examples.proto.ModuleStatus',
            },
            {
              name: '/channel/output',
              msg_type: 'deeproute.church.examples.proto.Output',
            },
          ],
        },
      },
    },
  ],
}
```

#### 4. 组件头文件（component_example.h）

```cpp
#include "church/component/component.h"

namespace deeproute::church::examples {

class ComponentExample : public Component {
 public:
  ComponentExample() { MLOG(INFO) << "Registered component."; }

  // ⭐ 必须实现：初始化
  bool Init() override;

  // ⭐ 必须实现：处理函数
  bool Proc(const OnboardMessageConstPtrVector& input_msgs,
            OnboardMessagePtrVector* output_msgs) override;

  // 可选：清理
  void Clear() override;

 private:
  int context_proc_count_{0};
};

// ⭐ 注册组件到全局工厂
CHURCH_REGISTER_COMPONENT(ComponentExample)

}  // namespace deeproute::church::examples
```

#### 5. 组件实现（component_example.cc）

```cpp
#include "component_example.h"
#include "church/examples/proto/examples.pb.h"

using deeproute::church::examples::proto::Context;
using deeproute::church::examples::proto::ModuleStatus;
using deeproute::church::examples::proto::Output;

namespace deeproute::church::examples {

bool ComponentExample::Init() {
  context_proc_count_ = 1;
  MLOG(INFO) << "Component init";

  // 从配置读取参数
  std::string dir;
  if (GetParam("config_dir", &dir)) {
    MLOG(INFO) << "config_dir: " << dir;
  }

  return true;
}

void ComponentExample::Clear() {
  // 清理资源
}

bool ComponentExample::Proc(const OnboardMessageConstPtrVector& input_msgs,
                            OnboardMessagePtrVector* output_msgs) {
  MCHECK(output_msgs != nullptr);

  // 1. 处理输入消息
  for (const auto& msg : input_msgs) {
    MLOG(INFO) << "Received from: " << msg->topic() 
               << ", content: " << msg->payload()->Utf8DebugString();
  }

  // 2. 生成输出消息

  // 输出1: Context
  auto context = std::make_shared<Context>();
  context->set_content("example context: " + std::to_string(context_proc_count_));
  context_proc_count_++;
  output_msgs->emplace_back(MakeOnboardMessage("/channel/context", context));

  // 输出2: ModuleStatus  
  auto module_status = std::make_shared<ModuleStatus>();
  module_status->set_timestamp(deeproute::base::Time::Now().ToNSec());
  module_status->set_module("Example");
  module_status->set_note("example module status");
  output_msgs->emplace_back(MakeOnboardMessage("/common/modulestatus", module_status));

  // 输出3: Output
  auto output = std::make_shared<Output>();
  output->set_timestamp(deeproute::base::Time::Now().ToNSec());
  output->set_seq(context_proc_count_);
  output_msgs->emplace_back(MakeOnboardMessage("/channel/output", output));

  return true;
}

}  // namespace deeproute::church::examples
```

#### 6. 完整执行流程

```
┌────────────────────────────────────────────────────────────────────────┐
│                            启动流程                                     │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  1. mainboard 启动                                                     │
│     │                                                                  │
│     ↓                                                                  │
│  2. ChurchApp::LoadModule()                                            │
│     │ - 加载 .so 动态库                                                │
│     │ - 读取 common.jsonnet 配置                                       │
│     ↓                                                                  │
│  3. ComponentRegistry::Create("ComponentExample")                      │
│     │ - 通过 CHURCH_REGISTER_COMPONENT 注册的工厂创建组件实例          │
│     ↓                                                                  │
│  4. Component::Initialize(node, config)                                │
│     │ - 创建 Node 实例                                                 │
│     │ - 初始化 ChannelCache                                            │
│     │ - 初始化 Trigger (根据 trigger_policy)                           │
│     ↓                                                                  │
│  5. Component::Startup()                                               │
│     │ - 调用 RegisterAllPublishers() 根据 output_channels 创建发布者   │
│     │ - 调用 Init() (用户实现)                                         │
│     │ - 调用 RegisterAllSubscribers() 根据 input_channels 创建订阅者   │
│     ↓                                                                  │
│  6. Scheduler::StartOneTask()                                          │
│     │ - 为 Component 创建独立的 Task 线程                              │
│     │ - Task 线程循环：WaitForTrigger() → Process() → ...              │
│     ↓                                                                  │
└────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│                          运行时消息流                                   │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│   talker 进程                      ComponentExample 进程               │
│   ┌──────────┐                    ┌──────────────────────────┐        │
│   │ Publisher│──────────────────→ │ Subscriber               │        │
│   │ /driver  │   ICEORYX共享内存  │ /channel/driver          │        │
│   └──────────┘                    └──────────┬───────────────┘        │
│                                              │                         │
│                                              ↓                         │
│                                   ┌──────────────────────────┐        │
│                                   │ IceoryxDispatcher        │        │
│                                   │ dispatch 线程            │        │
│                                   └──────────┬───────────────┘        │
│                                              │                         │
│                                              ↓                         │
│                                   ┌──────────────────────────┐        │
│                                   │ Trigger.PushMessage()    │        │
│                                   │ 缓存到 ChannelCache      │        │
│                                   └──────────┬───────────────┘        │
│                                              │                         │
│                   (周期触发 1s)               │                         │
│                                              ↓                         │
│                                   ┌──────────────────────────┐        │
│                                   │ Trigger.Wait() 返回      │        │
│                                   │ 触发 Proc()             │        │
│                                   └──────────┬───────────────┘        │
│                                              │                         │
│                                              ↓                         │
│                                   ┌──────────────────────────┐        │
│                                   │ Component::Assemble()    │        │
│                                   │ 从 ChannelCache 取出输入 │        │
│                                   └──────────┬───────────────┘        │
│                                              │                         │
│                                              ↓                         │
│                                   ┌──────────────────────────┐        │
│                                   │ ComponentExample::Proc() │        │
│                                   │ - 处理 input_msgs        │        │
│                                   │ - 生成 output_msgs       │        │
│                                   └──────────┬───────────────┘        │
│                                              │                         │
│                                              ↓                         │
│                                   ┌──────────────────────────┐        │
│                                   │ Component::Dispatch()    │        │
│                                   │ - node->PublishWithHeader│        │
│                                   │ - 发布到对应 topic       │        │
│                                   └──────────────────────────┘        │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

#### 7. 关键代码对应

| 配置/代码 | 对应的 Church 内部动作 |
|-|-|
| `class_name: 'ComponentExample'` | `ComponentRegistry::Create("ComponentExample")` |
| `trigger_policy: 'PERIODIC'` | 创建 `PeriodicTrigger` |
| `period: 1000000` | 触发器每 1 秒唤醒一次 |
| `input_channels` | `RegisterAllSubscribers()` 自动创建订阅者 |
| `output_channels` | `RegisterAllPublishers()` 自动创建发布者 |
| `MakeOnboardMessage(topic, msg)` | 创建带 Header 的消息 |

---

## 13. 与 device_manager.cpp 的对比总结

| 方面 | device_manager.cpp (Node) | ComponentExample (Component) |
|-|-|-|
| **创建方式** | 手动 `new Node(...)` | `CHURCH_REGISTER_COMPONENT` 宏注册 |
| **订阅/发布** | 手动 `AddSubscriber/AddPublisher` | 配置文件声明，自动创建 |
| **触发机制** | 无，回调直接触发处理 | 配置触发策略 (PERIODIC/IMMEDIATE等) |
| **生命周期** | 手动管理 | 框架管理 (Init→Startup→Process→Shutdown) |
| **线程模型** | 消息回调在 dispatch 线程执行 | 独立 Task 线程，与消息接收解耦 |
| **适用场景** | 简单设备驱动、传感器接口 | 复杂算法模块、需统一管理的组件 |

---

---

## 14. ICEORYX 与 RouDi 深度解析

### 14.1 什么是 ICEORYX？

ICEORYX（意为"冰龙"）是由 Robert Bosch GmbH 和 Apex.AI 开发的开源**高性能进程间通信（IPC）中间件**，专为实时系统和自动驾驶场景设计。

#### 核心特点

| 特性 | 说明 |
|-|-|
| **真零拷贝** | 数据只写入共享内存一次，订阅者直接读取，无需任何数据复制 |
| **确定性延迟** | 发送操作为 O(1) 复杂度，不受订阅者数量影响 |
| **内存池预分配** | 启动时预分配所有内存，运行时无动态分配 |
| **实时友好** | 适用于 QNX、Linux 等实时操作系统 |
| **多订阅者支持** | 一个发布者可以同时服务多个订阅者 |

#### ICEORYX 架构图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            ICEORYX 整体架构                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        RouDi 守护进程                                │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────┐ │   │
│  │  │ 进程管理器   │  │ 端口管理器   │  │      共享内存管理器          │ │   │
│  │  │ ProcessMgr  │  │ PortManager │  │     MemoryManager           │ │   │
│  │  └─────────────┘  └─────────────┘  └─────────────────────────────┘ │   │
│  │                           │                                        │   │
│  │                           ↓                                        │   │
│  │  ┌─────────────────────────────────────────────────────────────┐  │   │
│  │  │                    服务发现 (Service Discovery)               │  │   │
│  │  │  匹配 Publisher/Subscriber, 管理 Service Registry            │  │   │
│  │  └─────────────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              ↑ IPC 通道                                     │
│                              │ (Unix Domain Socket)                        │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                          共享内存区域                                  │  │
│  │  ┌────────────────────────────────────────────────────────────────┐ │  │
│  │  │                    Segment (内存段)                             │ │  │
│  │  │  ┌────────────────────────────────────────────────────────┐   │ │  │
│  │  │  │ MemPool (128B)  │ MemPool (1KB)  │ MemPool (1MB)  │ ...│   │ │  │
│  │  │  │ [chunk][chunk]  │ [chunk][chunk] │ [chunk][chunk] │    │   │ │  │
│  │  │  └────────────────────────────────────────────────────────┘   │ │  │
│  │  └────────────────────────────────────────────────────────────────┘ │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                              ↑                                              │
│  ┌─────────────────────┐    │    ┌─────────────────────┐                   │
│  │    进程 A (发布者)   │────┴────│    进程 B (订阅者)   │                   │
│  │  ┌───────────────┐  │         │  ┌───────────────┐  │                   │
│  │  │ PoshRuntime   │  │  直接   │  │ PoshRuntime   │  │                   │
│  │  │ Publisher     │──────────────│ Subscriber    │  │                   │
│  │  └───────────────┘  │  访问   │  └───────────────┘  │                   │
│  └─────────────────────┘         └─────────────────────┘                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 14.2 RouDi（Runtime Object Discovery）详解

RouDi 是 ICEORYX 的**中央守护进程**，负责整个系统的资源管理和服务发现。

#### RouDi 的核心职责

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           RouDi 核心职责                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. 共享内存生命周期管理                                                     │
│     ┌─────────────────────────────────────────────────────────────────┐    │
│     │ • 启动时创建共享内存段 (Segment)                                  │    │
│     │ • 根据配置初始化不同大小的内存池 (MemPool)                         │    │
│     │ • 管理 chunk 的分配和回收                                         │    │
│     │ • 退出时清理所有共享内存资源                                       │    │
│     └─────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  2. 进程注册与监控                                                           │
│     ┌─────────────────────────────────────────────────────────────────┐    │
│     │ • 应用进程启动时向 RouDi 注册                                     │    │
│     │ • 维护进程列表 (ProcessManager)                                   │    │
│     │ • 定期检查进程心跳 (Keep-Alive)                                   │    │
│     │ • 检测进程异常退出并清理其资源                                     │    │
│     └─────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  3. 端口发现与匹配                                                           │
│     ┌─────────────────────────────────────────────────────────────────┐    │
│     │ • 管理 Publisher/Subscriber 端口的创建和销毁                      │    │
│     │ • 维护服务注册表 (Service Registry)                               │    │
│     │ • 自动匹配同名 topic 的发布者和订阅者                              │    │
│     │ • 支持动态服务发现                                                 │    │
│     └─────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  4. 系统内省 (Introspection)                                                 │
│     ┌─────────────────────────────────────────────────────────────────┐    │
│     │ • 发布内存池使用情况                                              │    │
│     │ • 发布进程列表信息                                                │    │
│     │ • 发布端口连接状态                                                │    │
│     │ • 支持运行时监控和调试                                            │    │
│     └─────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### RouDi 启动流程

```cpp
// 源码位置：church/third_party/iceoryx/iceoryx_posh/source/roudi/roudi.cpp

RouDi::RouDi(RouDiMemoryInterface& roudiMemoryInterface,
             PortManager& portManager,
             RoudiStartupParameters roudiStartupParameters) noexcept
    : m_portManager(&portManager)
    , m_prcMgr(/* 进程管理器初始化 */)
    , m_mempoolIntrospection(/* 内存池内省初始化 */) {

    LogInfo() << "RouDi is initializing";

    // 1. 初始化进程内省
    m_processIntrospection.registerPublisherPort(...);
    m_prcMgr->initIntrospection(&m_processIntrospection);
    m_processIntrospection.run();

    // 2. 初始化内存池内省
    m_mempoolIntrospection.registerEventPublisherPort(...);
    m_mempoolIntrospection.run();

    // 3. 将 RouDi 自己加入进程列表
    m_processIntrospection.addProcess(getpid(), IPC_CHANNEL_ROUDI_NAME);

    // 4. 启动监控和发现线程
    m_monitoringAndDiscoveryThread = std::thread(&RouDi::monitorAndDiscoveryUpdate, this);

    // 5. 启动运行时消息处理线程
    startProcessRuntimeMessagesThread();
}
```

#### RouDi 配置文件示例

```toml
# 配置文件位置：roudi_config.toml

[general]
version = 1

# 共享内存段配置
[[segment]]

# 内存池配置 - 小消息
[[segment.mempool]]
size = 128        # 每个 chunk 128 字节
count = 10000     # 预分配 10000 个 chunk

# 内存池配置 - 中等消息
[[segment.mempool]]
size = 1024       # 1KB
count = 5000

# 内存池配置 - 大消息（如点云）
[[segment.mempool]]
size = 1048576    # 1MB
count = 100

# 内存池配置 - 超大消息（如图像）
[[segment.mempool]]
size = 4194304    # 4MB
count = 20
```

### 14.3 零拷贝通信原理

#### 传统 IPC vs ICEORYX 零拷贝

```
传统 IPC（如 TCP/UDP/消息队列）：
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│  Publisher  │      │    内核     │      │  Subscriber │
│             │      │             │      │             │
│  用户空间   │─────→│  内核空间   │─────→│  用户空间   │
│  buffer     │ 复制1│  buffer     │ 复制2│  buffer     │
└─────────────┘      └─────────────┘      └─────────────┘
              至少 2 次数据复制！

ICEORYX 零拷贝：
┌─────────────┐      ┌─────────────────────────────────┐      ┌─────────────┐
│  Publisher  │      │         共享内存 (SHM)           │      │  Subscriber │
│             │      │                                 │      │             │
│  用户空间   │─写入→│    chunk（数据直接写在这里）     │←读取─│  用户空间   │
│             │      │  [pointer]─────────────────────→│      │             │
└─────────────┘      └─────────────────────────────────┘      └─────────────┘
                    只写入 1 次，无复制！
```

#### 零拷贝数据流

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        ICEORYX 零拷贝数据流                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Publisher 端：                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ 1. 请求 chunk                                                        │   │
│  │    auto chunk = publisher.loan(sizeof(MyMessage));                  │   │
│  │    // 从预分配的 MemPool 中获取一块内存                               │   │
│  │                                                                      │   │
│  │ 2. 写入数据（直接写入共享内存，无需复制）                              │   │
│  │    auto* msg = static_cast<MyMessage*>(chunk->userPayload());       │   │
│  │    msg->timestamp = ...;                                            │   │
│  │    msg->data = ...;                                                 │   │
│  │                                                                      │   │
│  │ 3. 发布（仅传递指针元信息，不传数据）                                  │   │
│  │    publisher.publish(std::move(chunk));                             │   │
│  │    // RouDi 将 chunk 信息通知给订阅者                                 │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ↓ 元数据通知（仅指针）                    │
│                                                                             │
│  Subscriber 端：                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ 4. 接收通知                                                          │   │
│  │    subscriber.take() // 获取 chunk 引用                              │   │
│  │                                                                      │   │
│  │ 5. 直接访问共享内存（零拷贝！）                                        │   │
│  │    const auto* msg = static_cast<const MyMessage*>(chunk.userPayload());│
│  │    process(msg->timestamp, msg->data);                               │   │
│  │                                                                      │   │
│  │ 6. 释放 chunk                                                        │   │
│  │    // chunk 析构时自动释放，归还给 MemPool                            │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 14.4 Church 对 ICEORYX 的封装

Church 在 ICEORYX 基础上做了进一步封装，提供更易用的 API。

#### 封装层次

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Church ICEORYX 封装层次                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  应用层：                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Node API: AddPublisher<T>(), AddSubscriber<T>(), Publish()         │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                      │                                      │
│                                      ↓                                      │
│  Church 封装层：                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  IceoryxTransportImpl (传输层实现)                                   │   │
│  │  ├── IceoryxWriter (发布者封装)                                      │   │
│  │  │   └── 集成 Protobuf Arena 优化                                   │   │
│  │  ├── IceoryxReader (订阅者封装)                                      │   │
│  │  │   └── 支持回调机制                                               │   │
│  │  ├── IceoryxDispatcher (消息分发器)                                  │   │
│  │  │   └── 支持 Poll/Trigger 两种模式                                 │   │
│  │  └── KeepAlivePoshRuntime (心跳维护)                                 │   │
│  │       └── 支持线程优先级设置（QNX）                                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                      │                                      │
│                                      ↓                                      │
│  ICEORYX 原生层：                                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  iox::popo::Publisher / iox::popo::Subscriber                       │   │
│  │  iox::runtime::PoshRuntime                                          │   │
│  │  iox::popo::WaitSet                                                 │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### 关键实现代码

**IceoryxTransportImpl（传输层实现）**：

```cpp
// 源码位置：church/node/iceoryx_transport_impl.cc

IceoryxTransportImpl::IceoryxTransportImpl(
    const std::string& name, const TransportConfig::Iceoryx& config)
    : name_(name), config_(config) {

  // 1. 获取/创建 PoshRuntime 实例（与 RouDi 建立连接）
  KeepAlivePoshRuntime::GetKeepAliveRuntimeInstance(
      {iox::cxx::TruncateToCapacity, name.data()});

  // 2. 获取消息分发器单例
  dispatcher_ = IceoryxDispatcher::GetInstance(config);
}

std::shared_ptr<Writer> IceoryxTransportImpl::CreateWriter(
    const Writer::Options& options) {
  return std::make_shared<IceoryxWriter>(options);
}

std::shared_ptr<Reader> IceoryxTransportImpl::CreateReader(
    const Reader::Options& options) {
  return std::make_shared<IceoryxReader>(options, dispatcher_);
}
```

**KeepAlivePoshRuntime（心跳机制）**：

```cpp
// 源码位置：church/node/iceoryx_transport_impl.cc

class KeepAlivePoshRuntime : public PoshRuntimeImpl {
 private:
  void KeepAliveRoutine() noexcept {
    while (!stop_) {
      // 定期向 RouDi 发送心跳
      sendKeepAliveAndHandleShutdownPreparation();
      std::this_thread::sleep_for(kKeepAliveInterval);  // 300ms
    }
  }
};
```

**IceoryxDispatcher（消息分发器）**：

```cpp
// 源码位置：church/node/iceoryx_dispatcher.cc

void IceoryxDispatcher::DispatchRoutineInPollMode(uint64_t poll_hz) {
  church::base::Rate rate(poll_hz);  // 如 1000Hz
  while (!stop_) {
    // 轮询检查每个 topic 是否有数据
    for (const auto& observer : observers_) {
      if (observer->HasData()) {
        observer->ReleasePendingMessages();
        observer->ConsumeAll();  // 调用回调处理消息
      }
    }
    rate.Sleep();
  }
}

void IceoryxDispatcher::DispatchRoutineInTriggerMode() {
  while (!stop_) {
    // 使用 WaitSet 等待事件通知（更省 CPU）
    auto notificationVector = waitset_->timedWait(timeout);
    for (auto& notification : notificationVector) {
      (*notification)();
    }
  }
}
```

### 14.5 RouDi 与应用进程的交互

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     RouDi 与应用进程交互流程                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  应用进程启动                                                                 │
│      │                                                                      │
│      ↓                                                                      │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ 1. 进程注册                                                          │  │
│  │    PoshRuntime::initRuntime(name)                                    │  │
│  │    └── 通过 IPC 通道连接 RouDi                                       │  │
│  │    └── RouDi 将进程加入管理列表                                       │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│      │                                                                      │
│      ↓                                                                      │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ 2. 创建 Publisher                                                    │  │
│  │    runtime.getMiddlewarePublisher(service, options)                  │  │
│  │    └── 向 RouDi 请求创建发布端口                                      │  │
│  │    └── RouDi 在 PortManager 中注册端口                                │  │
│  │    └── RouDi 尝试匹配已存在的订阅者                                   │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│      │                                                                      │
│      ↓                                                                      │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ 3. 创建 Subscriber                                                   │  │
│  │    runtime.getMiddlewareSubscriber(service, options)                 │  │
│  │    └── 向 RouDi 请求创建订阅端口                                      │  │
│  │    └── RouDi 在 PortManager 中注册端口                                │  │
│  │    └── RouDi 尝试匹配已存在的发布者                                   │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│      │                                                                      │
│      ↓                                                                      │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ 4. 运行时（数据通信通过共享内存，不经过 RouDi）                         │  │
│  │    Publisher.loan() → 写数据 → Publisher.publish()                   │  │
│  │                ↓ 共享内存直接访问                                     │  │
│  │    Subscriber.take() → 读数据 → 处理                                 │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│      │                                                                      │
│      ↓                                                                      │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ 5. 心跳维护（周期性）                                                 │  │
│  │    sendKeepAliveAndHandleShutdownPreparation()                       │  │
│  │    └── 每 300ms 向 RouDi 发送心跳                                    │  │
│  │    └── RouDi 检测心跳超时则认为进程异常                               │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│      │                                                                      │
│      ↓                                                                      │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ 6. 进程退出                                                          │  │
│  │    runtime.disconnectFromRoudi()                                     │  │
│  │    └── 通知 RouDi 进程即将退出                                        │  │
│  │    └── RouDi 清理该进程的所有端口和资源                               │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 14.6 ICEORYX 使用注意事项

| 注意事项 | 说明 |
|-|-|
| **RouDi 必须先启动** | 应用进程启动前 RouDi 必须已运行，否则无法注册 |
| **内存池大小规划** | 根据消息大小合理配置 MemPool，避免分配失败 |
| **心跳超时** | 如果进程被阻塞过久（如卡在断点），可能导致心跳超时被 RouDi 踢出 |
| **资源清理** | 进程异常退出时 RouDi 会自动清理其资源 |
| **32位系统不支持** | ICEORYX 不支持 32 位系统 |

---

## 15. Church 项目代码结构与学习指南

### 15.1 项目整体架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Church 项目整体架构                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                            ┌─────────────────┐                              │
│                            │   mainboard     │  ← 应用入口                  │
│                            │   (主程序)       │                              │
│                            └────────┬────────┘                              │
│                                     │                                        │
│                    ┌────────────────┼────────────────┐                      │
│                    ↓                ↓                ↓                      │
│           ┌───────────────┐ ┌───────────────┐ ┌───────────────┐             │
│           │   component   │ │   scheduler   │ │     task      │             │
│           │   (组件框架)   │ │   (调度器)     │ │   (任务封装)   │             │
│           └───────┬───────┘ └───────┬───────┘ └───────┬───────┘             │
│                   │                 │                 │                      │
│                   └─────────────────┼─────────────────┘                      │
│                                     ↓                                        │
│                            ┌─────────────────┐                              │
│                            │      node       │  ← 通信核心                  │
│                            │   (节点通信)     │                              │
│                            └────────┬────────┘                              │
│                                     │                                        │
│          ┌──────────────────────────┼──────────────────────────┐            │
│          ↓                          ↓                          ↓            │
│   ┌─────────────┐          ┌─────────────┐          ┌─────────────┐        │
│   │  iceoryx    │          │    intra    │          │     ros     │        │
│   │ (零拷贝IPC)  │          │ (进程内通信) │          │  (ROS兼容)  │        │
│   └─────────────┘          └─────────────┘          └─────────────┘        │
│                                                                             │
│  ──────────────────────────── 支撑模块 ────────────────────────────         │
│                                                                             │
│   ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐              │
│   │  base   │ │ common  │ │  cache  │ │  proto  │ │ logger  │              │
│   │(基础库) │ │(公共工具)│ │(消息缓存)│ │(配置定义)│ │ (日志)  │              │
│   └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 15.2 目录结构详解

```
/sandbox/platform/church/
│
├── mainboard/                     # 【主程序入口】
│   ├── mainboard.cc               # main() 函数入口
│   ├── church_main.h/cc           # Church 主函数封装
│   ├── church_app.h/cc            # Church 应用类（核心！）
│   │                              # - 加载模块和组件
│   │                              # - 初始化调度器
│   │                              # - 管理生命周期
│   └── config_utils.h/cc          # 配置解析工具
│
├── component/                     # 【组件框架】
│   ├── component.h/cc             # Component 基类（重要！）
│   │                              # - 定义 Init/Proc/Clear 接口
│   │                              # - 管理输入/输出通道
│   ├── component_api.h/cc         # 组件 API 封装
│   ├── trigger.h/cc               # 触发器基类
│   ├── periodic_trigger.h         # 周期性触发器（PERIODIC 策略）
│   ├── immediate_trigger.h        # 立即触发器（IMMEDIATE 策略）
│   ├── context_manager.h          # 上下文管理
│   ├── schedule_monitor.h/cc      # 调度监控
│   ├── event_reporter.h/cc        # 事件上报
│   └── anomaly_monitor.h/cc       # 异常监控
│
├── node/                          # 【节点通信核心】
│   ├── node.h/cc                  # Node 类（最重要！）
│   │                              # - 创建 Publisher/Subscriber
│   │                              # - 管理消息发布/订阅
│   ├── publisher.h/cc             # 发布者实现
│   ├── subscriber.h/cc            # 订阅者实现（含异常检测）
│   ├── transport.h/cc             # 传输层抽象
│   ├── onboard_message.h/cc       # 消息封装（Header + Payload）
│   ├── init.h/cc                  # 节点初始化
│   │
│   ├── iceoryx_*.h/cc             # 【ICEORYX 传输实现】
│   │   ├── iceoryx_transport_impl # 传输层实现
│   │   ├── iceoryx_writer         # ICEORYX 写入器
│   │   ├── iceoryx_reader         # ICEORYX 读取器
│   │   ├── iceoryx_dispatcher     # 消息分发器
│   │   └── iceoryx_constants      # 常量定义
│   │
│   ├── intra_*.h/cc               # 【进程内传输实现】
│   │   ├── intra_transport_impl   # 进程内传输
│   │   ├── intra_writer           # 进程内写入器
│   │   └── intra_reader           # 进程内读取器
│   │
│   ├── ros_*.h/cc                 # 【ROS 传输实现】
│   │
│   ├── zmq_*.h/cc                 # 【ZMQ 传输实现】
│   │
│   ├── shm/                       # 【共享内存（Church 自研）】
│   │   ├── shm_pool.h/cc          # 共享内存池
│   │   ├── segment.h/cc           # 内存段
│   │   ├── block.h/cc             # 内存块
│   │   └── notifier_*.h/cc        # 通知机制
│   │
│   ├── topo/                      # 【拓扑管理】
│   │   ├── topo_info.h/cc         # 拓扑信息
│   │   ├── topo_reader.h/cc       # 拓扑读取
│   │   └── file_topo_writer.h/cc  # 文件拓扑记录
│   │
│   └── stream/pmem/               # 【持久化内存流】
│
├── scheduler/                     # 【调度器】
│   ├── scheduler_interface.h      # 调度器接口定义
│   ├── scheduler_ddl.h/cc         # DDL 调度器（用于仿真）
│   ├── scheduler_one_task_one_thread.*  # 单任务单线程调度器
│   ├── conditional_scheduler.*    # 条件调度器
│   ├── message_queue_interface.h  # 消息队列接口
│   └── task_interface.h           # 任务接口
│
├── task/                          # 【任务封装】
│   ├── component_task.h/cc        # 组件任务基类
│   ├── component_task_ddl.*       # DDL 模式任务
│   ├── component_task_custom_mode.*  # 自定义模式任务
│   ├── component_task_any_mode.*  # 任意模式任务
│   ├── component_task_factory.*   # 任务工厂
│   └── component_task_helper.*    # 任务辅助函数
│
├── cache/                         # 【消息缓存】
│   ├── channel_cache.h/cc         # 通道缓存
│   ├── cache_config.h/cc          # 缓存配置
│   ├── cache_helper.h/cc          # 缓存辅助
│   ├── cache_algorithm.h          # 缓存算法
│   └── frame_sync_helper.*        # 帧同步辅助
│
├── graph/                         # 【图调度（可选高级功能）】
│   ├── graph_scheduler.h/cc       # 图调度器
│   ├── graph_executor.h           # 图执行器
│   ├── calculator_framework.h     # 计算器框架
│   └── calculators/               # 具体计算器实现
│
├── base/                          # 【基础工具库】
│   ├── class_loader/              # 动态库加载
│   ├── common/                    # 通用工具
│   ├── container/                 # 容器（循环缓冲区、阻塞队列等）
│   ├── file/                      # 文件操作
│   ├── latency/                   # 延迟测量
│   ├── proto_util/                # Protobuf 工具
│   ├── signal/                    # 信号处理
│   ├── synchronization/           # 同步原语
│   ├── thread/                    # 线程工具
│   └── time/                      # 时间工具
│
├── common/                        # 【公共模块】
│   ├── church_time.h              # Church 时间定义
│   ├── church_clock.h/cc          # Church 时钟（支持仿真时钟）
│   ├── arg_parser.h/cc            # 命令行参数解析
│   ├── env.h                      # 环境变量
│   └── version.h                  # 版本信息
│
├── proto/                         # 【Protobuf 定义】
│   ├── church_config.proto        # Church 主配置
│   ├── component_conf.proto       # 组件配置
│   ├── channel_type.proto         # 通道类型枚举
│   ├── tasks_config.proto         # 任务配置（触发策略等）
│   └── scheduler_type.proto       # 调度器类型
│
├── logger/                        # 【日志模块】
│   └── church_logger.h/cc         # 日志封装
│
├── module/                        # 【模块管理】
│   ├── module_crash_reporter.*    # 崩溃报告
│   └── module_readiness_reporter.*# 就绪状态报告
│
├── ara/                           # 【AUTOSAR Adaptive 适配】
│   ├── exec/                      # 执行管理
│   └── core/                      # 核心功能
│
├── python/                        # 【Python 绑定】
│   ├── internal/impl/             # C++ 绑定实现
│   └── internal/wrapper/          # Python 包装器
│
├── tools/                         # 【工具集】
│   ├── church_node/               # 节点管理工具
│   ├── church_record/             # 数据录制
│   ├── church_dump/               # 数据转储
│   ├── church_channel/            # 通道工具
│   └── church_player/             # 数据回放
│
├── examples/                      # 【示例代码】
│   ├── component_example/         # 组件示例（必看！）
│   ├── custom_example/            # 自定义示例
│   ├── multi_component_example/   # 多组件示例
│   └── performance/               # 性能测试示例
│
├── tests/                         # 【测试代码】
│   ├── talker/                    # 发布者测试
│   ├── listener/                  # 订阅者测试
│   └── benchmark/                 # 基准测试
│
├── third_party/                   # 【第三方库】
│   └── iceoryx/                   # ICEORYX 中间件
│       ├── iceoryx_posh/          # POSH 核心库
│       │   ├── source/roudi/      # RouDi 实现
│       │   └── include/           # 头文件
│       ├── iceoryx_hoofs/         # 基础工具库
│       └── tools/                 # 构建工具
│
└── BUILD                          # Bazel 主构建文件
```

### 15.3 核心模块依赖关系

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          模块依赖关系图                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                              mainboard                                      │
│                                  │                                          │
│                    ┌─────────────┼─────────────┐                           │
│                    │             │             │                           │
│                    ↓             ↓             ↓                           │
│               component     scheduler        task                          │
│                    │             │             │                           │
│                    │             │             │                           │
│                    │             └──────┬──────┘                           │
│                    │                    │                                   │
│                    ↓                    ↓                                   │
│                  cache ←─────────── trigger                                │
│                    │                                                        │
│                    ↓                                                        │
│                  node ←───────────────────────────────────────────────┐    │
│                    │                                                  │    │
│      ┌─────────────┼─────────────┬────────────────┐                  │    │
│      ↓             ↓             ↓                ↓                  │    │
│  iceoryx_impl  intra_impl   ros_impl        zmq_impl                │    │
│      │                                                               │    │
│      ↓                                                               │    │
│  third_party/iceoryx                                                 │    │
│                                                                      │    │
│  ─────────────────────── 基础依赖 ───────────────────────            │    │
│                                                                      │    │
│      base ←─────────────────────────────────────────────────────────┘    │
│        │                                                                  │
│        ├── common                                                        │
│        ├── proto                                                         │
│        └── logger                                                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 15.4 学习路径建议

#### 阶段一：入门基础（1-2 天）

```
推荐学习顺序：
1. 先阅读本文档的前半部分（第 1-4 章）
2. 查看 proto/ 目录下的定义文件，理解配置结构
   - church_config.proto
   - channel_type.proto
   - tasks_config.proto

3. 阅读示例代码
   - examples/component_example/    # 最简单的组件示例
   - tests/talker/talker.cc         # 发布者示例
   - tests/listener/                # 订阅者示例
```

#### 阶段二：核心机制（3-5 天）

```
推荐学习顺序：
1. node/ 模块（通信核心）
   ├── node.h/cc            # 理解 Node 的 API
   ├── publisher.h/cc       # 理解发布机制
   ├── subscriber.h/cc      # 理解订阅机制（含异常检测）
   └── onboard_message.h/cc # 理解消息格式

2. component/ 模块（组件框架）
   ├── component.h/cc       # 理解 Component 生命周期
   ├── trigger.h/cc         # 理解触发机制
   └── periodic_trigger.h   # 理解周期触发

3. mainboard/ 模块（启动流程）
   └── church_app.cc        # 理解应用初始化流程
```

#### 阶段三：传输层深入（2-3 天）

```
推荐学习顺序：
1. 理解传输层抽象
   └── node/transport.h/cc

2. 深入 ICEORYX 传输
   ├── node/iceoryx_transport_impl.cc  # 传输层实现
   ├── node/iceoryx_writer.cc          # 写入器
   ├── node/iceoryx_reader.cc          # 读取器
   └── node/iceoryx_dispatcher.cc      # 分发器

3. 了解 RouDi
   └── third_party/iceoryx/iceoryx_posh/source/roudi/
```

#### 阶段四：调度与任务（2-3 天）

```
推荐学习顺序：
1. scheduler/ 模块
   ├── scheduler_interface.h      # 调度器接口
   └── scheduler_one_task_one_thread.*

2. task/ 模块
   ├── component_task.h/cc        # 任务基类
   └── component_task_factory.*   # 任务创建

3. cache/ 模块
   └── channel_cache.h/cc         # 消息缓存机制
```

#### 阶段五：高级特性（可选）

```
可选学习内容：
1. graph/ 模块 - 图调度（更复杂的调度场景）
2. ara/ 模块 - AUTOSAR Adaptive 适配
3. tools/ - 各种调试和运维工具
```

### 15.5 关键代码阅读指南

#### 1. ChurchApp 启动流程

```cpp
// 文件：mainboard/church_app.cc
// 理解 Church 应用如何启动

bool ChurchApp::Initialize() {
  // 1. 加载所有模块（从配置文件）
  for (const auto& module : church_config_.json_module()) {
    LoadModule(module);  // 加载 .so 动态库
  }

  // 2. 安装调度监控
  schedule_monitor_->InstallOnNodes(MakeNodePointerVector());
  schedule_monitor_->InstallOnComponents(MakeComponentPointerVector());

  // 3. 初始化异常监控
  anomaly_monitor_->Initialize(...);
}

bool ChurchApp::Run() {
  // 1. 启动监控
  schedule_monitor_->Start();
  event_reporter_->Start();
  anomaly_monitor_->Start();

  // 2. 启动调度器
  StartScheduler();  // 启动所有组件的 Task 线程

  // 3. 等待退出信号
  WaitForSignal();
}
```

#### 2. Component 生命周期

```cpp
// 文件：component/component.h
// 理解组件的生命周期方法

class Component {
 protected:
  // 用户必须实现：
  virtual bool Init() = 0;    // 初始化
  virtual bool Proc(...) = 0; // 处理函数
  virtual void Clear() {}     // 清理（可选）

 public:
  // 框架调用：
  bool Initialize(Node* node, const ComponentConfig& config);
  bool Startup();   // 启动（注册发布者、订阅者）
  bool Process();   // 处理（框架调用 Proc）
  void Shutdown();  // 关闭
};
```

#### 3. 消息异常检测

```cpp
// 文件：node/subscriber.cc
// 理解消息丢失和延迟检测

void Subscriber::OnMessageReceived(std::shared_ptr<const OnboardMessage> message) {
  if (options_.enable_abnormal_check) {
    CheckMessageLoss(message);      // 检测丢包
    CheckMessageTransTime(message); // 检测延迟
  }
  options_.callback(message);
}

bool Subscriber::CheckMessageLoss(const std::shared_ptr<const OnboardMessage>& message) {
  // 通过序列号判断是否丢包
  auto& sequence_num = seq_map_[message->sender_name()];
  if (++sequence_num != message->sequence_num()) {
    // 丢包！通知观察者
    options_.msg_loss_observer(message, sequence_num);
  }
}
```

### 15.6 调试技巧

#### 1. 拓扑信息查看

```bash
# Church 自动记录拓扑信息到文件
ls /tmp/church_topo/
# 包含各节点的发布/订阅信息
```

#### 2. ICEORYX 内省

```bash
# 使用 iceoryx 内省工具
iox-roudi-inspect  # 查看 RouDi 状态
```

#### 3. 日志调试

```cpp
// 使用 MLOG 输出日志
MLOG(INFO) << "Debug info: " << value;
MLOG(WARN) << "Warning: " << warning;
MLOG(ERROR) << "Error: " << error;
```

#### 4. 常用环境变量

| 环境变量 | 说明 |
|-|-|
| `CHURCH_CHANNEL_TYPE` | 默认通道类型 |
| `CHURCH_LOG_LEVEL` | 日志级别 |
| `IOX_ROUDI_CONFIG_FILE` | RouDi 配置文件路径 |

---

## 16. 总结

### Church 核心设计理念

1. **分层抽象**：Node（通信）→ Component（组件）→ Task（调度）
2. **传输层可插拔**：支持 ICEORYX、SHM、ROS、进程内等多种传输
3. **配置驱动**：通过 Jsonnet/Protobuf 配置，减少硬编码
4. **监控完善**：内置消息丢失检测、延迟监控、异常检测

### ICEORYX + RouDi 的价值

1. **零拷贝高性能**：大数据包传输无复制开销
2. **集中管理**：RouDi 统一管理资源和服务发现
3. **实时友好**：预分配内存，确定性延迟

### 学习建议

1. 从 `examples/component_example/` 开始动手实践
2. 先掌握 Node API，再深入 Component
3. 理解 ICEORYX 原理有助于排查性能问题
4. 多看测试代码，理解边界情况

---

*文档版本：3.0*  
*最后更新：2026-01-31*
