---
title: Async_File API 参考
date: 2026-10-20
description: 公共类型、完整接口、配置默认值、结果、状态与统计语义。
categories: [撰修司]
tags: [AsyncFile, API, C++]
---

# API 参考

所有类型位于 `deeproute::base::async_file`。本页按公共头文件说明当前接口；调用示例见[接入指南](./接入指南.md)，输出策略见[连续输出机制](./连续输出机制.md)。

## 通用调用规则

| 项目 | 约定 |
| --- | --- |
| 异步提交返回值 | `true` 表示被接收，`false` 表示拒绝；拒绝不执行、不回调 |
| 完成结果 | 接收后的结果经可选 `Completion` 返回，错误同时进入统计 |
| 回调线程 | 所属 service 的 worker，不持内部锁；不要同步等待本 service 或做耗时工作 |
| 数据所有权 | 值传递字符串由后台持有；`string_view` 在调用期间复制 |
| 二进制数据 | 使用带长度的 `std::string` / `string_view`；`const char*` 按零结尾字符串处理 |
| 路径 | 非空、不含内嵌 NUL；路径有效性和 IO 错误通常在后台报告，不能由接收结果判断 |
| 对象使用 | 不可复制；文件对象单次打开、关闭后不可重开 |
| 创建对象 | `MakeFile/MakeOutput` 不做 IO；service 已开始关闭时返回 `nullptr` |
| 配置错误 | 非法服务/输出配置在构造时抛 `std::invalid_argument` |

回调中收到的 `const FileResult&` 只在回调调用期间有效；异步转交结果时应复制。回调异常会被捕获并记录为 `kCallback`，worker 继续执行。

## AsyncFileService

头文件：`base/async_file/async_file_service.h`。一个实例拥有一个串行 worker，没有默认全局实例。

```cpp
explicit AsyncFileService(const ServiceOptions& options = {});
~AsyncFileService();

bool AsyncWriteFile(std::string path, std::string data,
                    WriteOptions options = {}, Completion completion = {});
bool AsyncAppendFile(std::string path, std::string data,
                     WriteOptions options = {}, Completion completion = {});
bool AsyncRemove(std::string path, Completion completion = {});
bool AsyncRename(std::string from, std::string to, Completion completion = {});
bool AsyncCreateDirectories(std::string path, Completion completion = {});

std::unique_ptr<AsyncFile> MakeFile();
std::unique_ptr<AsyncFileOutput> MakeOutput(const OutputOptions& options);

void AsyncShutdown(ShutdownMode mode = ShutdownMode::kDrain);
bool Wait(std::chrono::milliseconds timeout);
bool Shutdown(ShutdownMode mode = ShutdownMode::kDrain);
ServiceStats GetStats() const;
```

| 方法 | IO 语义 |
| --- | --- |
| `AsyncWriteFile` | 同目录唯一临时文件 → 写完整 → 可选文件 fsync → close → rename 替换目标；失败清理临时文件，保留原目标 |
| `AsyncAppendFile` | 打开并直接追加，然后可选 fsync、关闭；失败可能已写部分内容 |
| `AsyncRemove` | unlink 单个文件；不存在视为成功；不递归删除目录 |
| `AsyncRename` | 原生 rename，可覆盖目标；跨文件系统失败，不退回复制；不自动创建目标父目录 |
| `AsyncCreateDirectories` | 递归创建目录；目录已存在视为成功 |
| `AsyncShutdown` | 关闭服务入口，给注册资源安排关闭；Drain 可以升级为 Fast，不能反向恢复 |
| `Wait` | 等 worker 退出；先请求 shutdown；负值无限等待，0 立即检查；worker 内调用返回 false |
| `Shutdown` | `AsyncShutdown` 加无限 `Wait`，适合管理线程，可能长时间阻塞 |

`AsyncWriteFile` 的“原子”指 rename 发布的可见性。它创建新 inode，不继承旧 inode 的属主、权限或扩展属性；通过 `fchmod` 使用指定权限，不受 umask 调整。普通 open/append 创建文件时遵循 umask。没有父目录 fsync，因此它不承诺完整的掉电事务。

### ServiceOptions

| 字段 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `max_pending_tasks` | `size_t` | 1000 | 普通任务及尾批记录总额度，必须大于 0 |
| `max_pending_bytes` | `size_t` | 10 MiB | 未完成输入负载额度，必须大于 0 |
| `destructor_timeout` | `milliseconds` | 200 ms | 析构请求 Fast 后的等待预算，不可为负；0 表示不等待 |

### WriteOptions

用于单次写入、追加和 Proto 输出。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `create_parent` | `true` | 自动递归创建父目录 |
| `sync_file` | `false` | 成功写完后请求文件 fsync |
| `permissions` | `0644` | 创建文件的权限；原子替换与普通创建的 umask 行为见上文 |

## AsyncFile

头文件：`base/async_file/async_file.h`，通过 `service.MakeFile()` 创建。它表示业务指定路径上的一个普通写文件，负责 fd 生命周期，不自动加分隔符、批量、压缩或轮转。

```cpp
bool AsyncOpen(std::string path, OpenOptions options = {},
               Completion completion = {});
bool AsyncWrite(std::string data, Completion completion = {});
bool AsyncWrite(std::string_view data, Completion completion = {});
bool AsyncWrite(const char* data, Completion completion = {});
bool AsyncFlush(Completion completion = {});
bool AsyncSync(Completion completion = {});
bool AsyncClose(Completion completion = {});
bool AsyncClose(ShutdownMode mode, Completion completion = {});
FileStats GetStats() const;
```

必须先成功接收 Open，才能提交写入；无需先等待 Open 回调。普通 `AsyncFlush` 没有用户态尾批可刷，相当于此前请求的顺序屏障；`AsyncSync` 检查打开状态后执行 fsync。Close 默认 Drain。

### OpenOptions

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `mode` | `Mode::kAppend` | `kAppend` 追加，`kTruncate` 打开时截断，`kCreateNew` 独占创建、已有则失败 |
| `create_parent` | `true` | 自动递归创建父目录 |
| `permissions` | `0644` | 新建文件权限，遵循 umask |

`kTruncate` 直接截断目标，不具备 `AsyncWriteFile` 的替换保护。需要“写失败仍保留旧版本”时，应选 service 的单次原子替换接口。

## AsyncFileOutput

头文件：`base/async_file/async_file_output.h`，通过 `service.MakeOutput(options)` 创建。输出目录、命名和策略在创建前配置，之后不可动态修改。

```cpp
bool AsyncOpen(Completion completion = {});
bool AsyncWrite(std::string record, Completion completion = {});
bool AsyncWrite(std::string_view record, Completion completion = {});
bool AsyncWrite(const char* record, Completion completion = {});
bool AsyncFlush(Completion completion = {});
bool AsyncSync(Completion completion = {});
bool AsyncClose(Completion completion = {});
bool AsyncClose(ShutdownMode mode, Completion completion = {});
FileStats GetStats() const;
```

每条 Write 的回调在该记录所在批次写出、失败或取消后执行。Manual 模式下不主动 Flush/Close，尾批就会一直保留。

`AsyncFlush` 写出当前尾批，不额外强制 fsync；但写出过程达到 `sync_interval_bytes` 阈值时仍可能自动 fsync。`AsyncSync` 先 Flush，再明确请求文件 fsync。

### OutputOptions

| 字段 | 默认值 | 含义与边界 |
| --- | --- | --- |
| `directory` | `/tmp` | 输出目录，非空且不能含 NUL，打开时自动创建 |
| `prefix` | `data` | 文件名前缀，非空且不能含 `/` 或 NUL |
| `format` | `Format::kText` | `kText` 原字节输出；`kZstd` 标准 zstd 多帧 |
| `compression_level` | 1 | 1 到当前 zstd 最大压缩级别，构造时校验 |
| `batch_mode` | `BatchMode::kAuto` | `kNone` 逐条；`kAuto` 数量/时间触发；`kManual` 显式刷新 |
| `batch_records` | 100 | Auto 批量记录阈值，必须大于 0 |
| `flush_interval` | 200 ms | Auto 首条尾批开始计时，必须大于 0 |
| `delimiter` | `"\n"` | 同批记录之间补分隔符，末记录不补 |
| `file_header` | 空字符串 | 非空时每个新文件写入，缺少末尾换行时补 `\n` |
| `max_file_bytes` | 50 MiB | 编码后文件轮转阈值，0 关闭；批次不拆，允许超限 |
| `sync_interval_bytes` | 2 MiB | 累计实际写入字节触发 fsync，0 关闭周期 fsync |
| `rolling_deletion` | `true` | 是否启用旧文件清理 |
| `max_file_count` | 0 | 已完成文件数量上限，0 不限 |
| `max_total_bytes` | 0 | 已完成文件总大小上限，0 不限 |
| `cleanup_interval` | 30 min | 写出时的清理检查间隔；0 每次检查，不可为负 |

即使选择 None/Manual 或 Text，当前构造也统一校验数量、刷新间隔和压缩级别。相同目录和前缀必须由一个活跃输出流独占，包括跨 service、跨进程；避免相互清理或争用命名。

## Proto 可选接口

包含 `base/async_file/async_proto_file.h`，链接 `:async_proto_file`。以下均为 `AsyncFileService` 成员：

```cpp
bool AsyncWriteProtoText(std::string path,
                        const google::protobuf::Message& data,
                        WriteOptions options = {}, Completion completion = {});
bool AsyncWriteProtoBinary(std::string path,
                          const google::protobuf::Message& data,
                          WriteOptions options = {}, Completion completion = {});
bool AsyncWriteProtoText(
    std::string path,
    std::shared_ptr<const google::protobuf::Message> snapshot,
    WriteOptions options = {}, Completion completion = {});
bool AsyncWriteProtoBinary(
    std::string path,
    std::shared_ptr<const google::protobuf::Message> snapshot,
    WriteOptions options = {}, Completion completion = {});
```

引用重载在调用线程深拷贝，再把快照交给 worker；复制期间原对象不能并发修改。共享快照重载避免该深拷贝，但要求所有别名直到完成前都不能修改消息，`shared_ptr<const Message>` 本身无法阻止其他可变别名。

容量按快照 `SpaceUsedLong()` 申报；worker 序列化后复用单次原子替换。空快照或序列化失败通过 `kSerialize` 报告，不替换已有目标。

## FileResult 与完成通知

```cpp
struct FileResult {
  FileStage stage = FileStage::kNone;
  std::error_code error;
  std::string path;
  std::string target;
  size_t bytes_written = 0;
  explicit operator bool() const; // !error
};
using Completion = std::function<void(const FileResult&)>;
```

| 字段 | 含义 |
| --- | --- |
| `stage` | 失败发生的阶段；成功时通常为 `kNone` |
| `error` | 标准错误码；用 `value()` / `message()` 观察 |
| `path` / `target` | 相关源路径、目标路径；成功结果不保证填充，替换失败也可能报告临时文件路径 |
| `bytes_written` | 与该完成对应的写入量，失败时也可能非零 |

阶段包括：`kNone`、`kAdmission`、`kState`、`kOpen`、`kWrite`、`kSync`、`kClose`、`kRename`、`kRemove`、`kMkdir`、`kScan`、`kSerialize`、`kCompress`、`kCallback`、`kCancelled`、`kInternal`。

连续输出逐记录的成功回调报告该记录输入字节数；显式批量 Flush 的结果对应实际编码写入字节。普通写入报告实际写出的字节。其他操作的结果不一定保留此前刷新产生的字节总数，因此不要把所有回调的 `bytes_written` 相加当作文件总大小，应看 `FileStats`。部分写入后直接重试可能重复数据。

## 状态与统计

`FileState` 为 `kNew`、`kOpen`、`kFailed`、`kClosed`，表示已执行状态；接收与执行的时间差见[设计架构](./设计架构.md)。`ShutdownMode` 为 `kDrain`、`kFast`，差异见[运行与排障](./运行与排障.md)。

### FileStats

| 字段 | 含义 |
| --- | --- |
| `state` / `current_path` | 已执行状态与当前路径；输出轮转、完成改名后会变化 |
| `accepted` / `rejected` | 普通请求及 Flush/Sync 的接收/拒绝计数，不含 Close |
| `failed` / `last_error` | 错误观察次数及最近错误，成功不清除 `last_error` |
| `records_written` | 成功写出的记录数，普通文件的一次成功 Write 也算一条 |
| `bytes_written` | 累计实际编码写入量，包括输出文件头、可能的部分写入 |
| `batches_written` | 连续输出成功写出的记录批次数，不含文件头 |
| `buffered_records` / `buffered_bytes` | 连续输出尾批的记录数与原始输入字节 |
| `compression_ratio` | 最近一个非空编码块的输入字节 / 编码字节，包含文件头块，不是累计平均压缩率 |

### ServiceStats

| 字段 | 含义 |
| --- | --- |
| `accepted` / `rejected` | 队列接收/拒绝请求计数；Flush/Sync 计入，Close 使用单独通路不计入 |
| `executed` | 已处理的队列任务，含 Close；不能假设与 accepted 相等 |
| `failed` / `cancelled` | 错误观察次数及其中取消观察次数，不能当作唯一失败 syscall 数 |
| `pending_tasks` / `pending_bytes` | 未完成普通输入的额度，含在途、回调执行期及尾批，不含保留控制任务 |
| `last_error` | 粘性最近错误，后续成功不会清除；后续拒绝也可能覆盖它 |

同一失败批次可能使多条记录回调以及 Flush 都报告失败，统计可能重复观察同一底层原因。定时刷新、清理等后台错误同样会更新观察值。不要用 `accepted - executed` 代替 `pending_tasks`，也不要用错误计数直接推导丢失记录数。
