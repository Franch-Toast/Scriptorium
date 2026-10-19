---
title: FileSink 接口与重要类参考
date: 2026-10-19
categories: 撰修司
tags: [FileSink, API, C++, 异步IO]
---

# FileSink 接口与重要类参考

所有 common 类和自由函数都位于 `deeproute::common`。头文件从 common 仓库根路径包含，例如 `#include "base/file_sink/file_sink.h"`。以下说明基于[入口所列工作区](./index.md#文档基线)，代码中的默认值与本页一致；部分签名省略了重复的 const/默认参数，精确声明以头文件为准。

## 1. FileSubmission、FileTicket 和 FileResult

定义：`/sandbox/common/base/file_sink/async_file_executor.h:19–77`。

~~~cpp
struct FileSubmission {
  bool accepted = false;
  FileTicket ticket;
  explicit operator bool() const;  // 只检查 accepted
};

struct FileResult {
  FileStage stage = FileStage::None;
  int error = 0;                  // errno 风格
  bool published = false;       // 特别用于 rename 后目录同步失败
  explicit operator bool() const;  // 只检查 error == 0
};
~~~

| FileTicket 方法 | 说明 |
| --- | --- |
| `status()` | 当前任务状态 |
| `result()` | 最近结果；重试时可能是上一次失败，不表示最终完成 |
| `generation()` | executor 接收时分配的 generation，不是 Cache 的业务 generation |
| `done()` | 是否处于终态 |
| `wait(milliseconds timeout = 0)` | 等到终态或超时；**0 表示无限等待**，只允许管理/启动阶段使用 |

状态包括：Pending、Running、Retry、Succeeded、Failed、Superseded、Rejected、Cancelled。前 3 个为非终态。wait 返回 true 只表示到达终态，必须继续检查 status 是否为 Succeeded。

`FileResult` 的 bool 也不能代替完成判定：Pending/Cancelled/Superseded 等状态可能同时具有 error=0。先读终态，再分析结果。内存耗尽到无法创建 ticket 时，接口可能直接返回默认 FileSubmission；默认 ticket 的错误表示不能承诺精确保留 ENOMEM。

`FileStage` 枚举：None、Queue、Serialize、Mkdir、Open、Write、Sync、Close、Rename、Remove、Scan、SyncDirectory、Callback。

| 常见失败 | 解释与动作 |
| --- | --- |
| Queue / EBUSY | 短暂准入锁竞争；帧线程丢弃/合并，不忙等 |
| Queue / ENOSPC | 任务数或逻辑字节预算满；不是磁盘容量诊断 |
| Queue / ESHUTDOWN | 执行器已停止，检查生命周期 |
| Queue / EINVAL | 无效 stream/work；FileSink 某些非法状态或自身准入竞争也走通用拒绝路径，不宜仅凭此码精确分类 |
| Serialize / EINVAL | 序列化返回 false 或非法操作 |
| Open、Write、Sync 等 / ENOSPC、EROFS、EIO… | 后台存储操作失败，保留 stage/errno 诊断 |
| SyncDirectory / errno，published=true | 新文件已发布，目录同步失败；不能当作未改文件 |
| Callback / ENOMEM 或 EIO | Work 抛出异常，被 worker 转为任务失败 |

## 2. FileSink：连续文件输出

定义：`/sandbox/common/base/file_sink/file_sink.h:30`。用途是按前缀写文本或 zstd 数据，带批量、轮转、header、旧文件清理。

### 2.1 构造与显式异步生命周期

~~~cpp
FileSink();
explicit FileSink(const Config& config);
FileSink(const Config& config, AsyncFileExecutor& executor);

FileSubmission openAsync();
FileSubmission appendAsync(std::string data);
FileSubmission flushAsync();
FileSubmission closeAsync();
bool isOpen() const;
~~~

默认构造/仅 Config 构造使用 FileWriter 的共享池；外部 executor 构造用于隔离流量。构造会分配内存、注册 timer/初始化池，放在启动阶段。工厂函数同样只构造，不自动 open。

| 操作 | 提交成功的含义 | ticket 成功的含义 |
| --- | --- | --- |
| openAsync | 接收打开请求 | 文件和可选 header 已完成打开/写入 |
| appendAsync | 接收拥有数据的追加请求 | None 模式写完；批量模式可能只进入尾批 |
| flushAsync | 接收尾批输出请求 | 该 stream 前面的尾批写完；不额外保证 fsync |
| closeAsync | 关闭准入并接收关闭请求 | 按 fastShutdown 处理尾批，然后 close 和最终 rename 完成 |

openAsync 接收后可以按同一实例顺序追加，但若后台 open 失败，后续追加会失败。推荐启动管理线程先检查 open ticket，再允许帧生产。`isOpen()` 读取 worker 的实际 opened 状态，不是请求屏障；它可能在 open ticket 完成前短暂为 true，例如 header 尚未写完。

appendAsync 按值接收 string，可传 std::move；传左值会在调用端复制。显式 Async 接口不受 enableAsyncWrite 控制。采用 openAsync 的实例析构只请求后台收尾，不在调用线程等待文件 I/O。队列拒绝关闭请求时会设置后台关闭意图；准入锁竞争等拒绝仍须看返回值，不把一次 closeAsync 当作可靠完成证明。

生命周期操作、setFileHeader 和对象销毁由一个管理方串行组织，避免与并发生产者竞态。提交路径使用 try-lock 不代表支持任意 open/close/销毁交错；关闭前先停生产者，也不要混用旧同步与新异步生命周期。

### 2.2 Config 默认值与精确定义

| 字段 | 默认值 | 含义与限制 |
| --- | --- | --- |
| format | Format::Text | Text / Compressed（zstd） |
| filePrefix | "data" | 文件名前缀；不同业务建议不同前缀 |
| outputDir | "/tmp" | 输出目录，worker 创建父目录 |
| batchMode | BatchMode::Auto | None 直接写；Auto 条数/时间刷新；Manual 显式刷新 |
| batchSize | 100 | Auto 的条数阈值，不是字节数 |
| autoFlushInterval | 200ms | Auto 刷新条件，非完成时限 |
| delimiter | "\n" | 批内相邻记录之间按需添加，不保证批尾换行 |
| maxFileSizeMB | 50 | 按已编码字节，在下次 write 前判断；0 不按大小轮转 |
| compressionLevel | 1 | zstd 压缩等级；接口注释范围 1～22，错误在后台报告 |
| enableAsyncWrite | true | 仅影响旧 writeAsync/flush 行为，不控制显式 Async 接口 |
| fastShutdown | true | 关闭时丢弃未写尾批；旧 close 的 ticket 等待为 200ms |
| closeTimeout | 500ms | fastShutdown=false 时旧 close 的 ticket 等待，不是 syscall 超时 |
| fileHeader | 空字符串 | 每个新文件写一次，若末尾没有 \n 就补一个 |
| maxFileCount | 0 | finalized 文件数目标；0 不限制 |
| maxTotalSizeGB | 0 | finalized 文件总大小目标；0 不限制 |
| enableRollingDeletion | true | 是否启用滚动清理；仍需设置 count 或 size |
| deletionCheckInterval | 30min | 写入路径触发检查的最小时间间隔，不是独立清理定时器 |

MB/GB 的实现采用 1024 的幂。库未对全部 Config 字段做集中合法性校验，应在业务初始化时校验值和路径。

**分隔符易错点：** 一批 `["a", "b"]` 用默认 delimiter 输出 `"a\nb"`，没有末尾换行；下一批可能直接拼到 b 后面。CSV/逐行日志建议让每条记录自带 `\n`，包括最后一条。None 模式不自动添加 delimiter。

### 2.3 文件命名、轮转与清理

~~~text
写入中：{prefix}.log.{start}.tmp
完成后：{prefix}.log.{start}-{end}
压缩完成后：{prefix}.log.{start}-{end}.zst
时间格式：YYYYMMDD.HHMMSS.ffffff（本地时间、微秒）
~~~

启动时间戳用进程内原子递增避免同进程冲突，open 使用 O_EXCL；没有跨进程命名协调。maxFileSizeMB 在写前检查，单个大块可以使文件越过阈值，下次 write 才轮转，不是硬文件上限。

清理只匹配相同 prefix、名称含 finalized 分隔符 `-`、非 .tmp 的 regular file，并匹配压缩模式，按 mtime 从旧到新删除。活跃 .tmp 和不匹配文件不计入该限额。关闭刚生成的 finalized 文件可暂时超过目标，直到后续写入触发检查；停止写入后不会定时清理。因此此功能不是磁盘配额或满盘保护器。

### 2.4 统计和其他接口

~~~cpp
Stats getStats() const;
size_t getBufferSize();
Sink::AsyncWriteStatus getAsyncWriteStatus() const;
void setFileHeader(const std::string& header);  // 打开前，管理阶段
~~~

| Stats 字段 | 实际含义 |
| --- | --- |
| totalWrites | 成功完成 writeAll 的低层编码块次数，含 header/批次；不是业务记录条数，后续 fsync 仍可能失败 |
| totalBytes | 上述编码块的字节总量，压缩时为压缩后字节，含 header |
| totalBatches | 执行的非丢弃尾批 flush 次数，不等于全部批次写入成功 |
| failedWrites | 经 State::record 记录的后台失败次数；不把每次 producer 拒绝计为写失败 |
| currentBufferSize | worker 当前尾批记录数，非字节，也不包含仍在排队的 append |
| compressionRatio | 最近编码块的原始/压缩字节比，非全历史平均 |

getBufferSize 返回同样的尾批条数；getAsyncWriteStatus 只有 NotStarted/OK/Error，后续成功可覆盖 Error，不能用它判断“历史从未失败”。读取 Stats 是多次原子采样，不是事务一致快照。

FileSink 继承 Sink，但 Sink::getConfig()/setBufferThreshold 操作的是基类 Config，不是 FileSink::Config；不能借此动态修改上述滚动文件配置。

### 2.5 旧接口兼容与工厂

| 旧方法 | 当前语义 | 帧路径建议 |
| --- | --- | --- |
| bool open() | 提交后等待结果；EBUSY 可循环重试 | 不用 |
| bool write(const string_view&) | 等待追加任务结果；批量模式仍可能只是入尾批 | 不用 |
| bool writeAsync(const string_view&) | enableAsyncWrite=true 时返回接收结果，否则走 write | 优先显式 appendAsync |
| void flush() | 异步配置仅请求刷新；同步配置等待，EBUSY 可重试 | 用 flushAsync 并检查返回 |
| void close() | 先可能重试准入，再按配置限时等 ticket | 用管理阶段 closeAsync |

兼容范围是源码调用方式，**不保证旧二进制 ABI**，依赖方要重编。仅打开 enableAsyncWrite 不会使构造、旧 open/close、外部 FdGuard 操作全部变成非阻塞。

`file_sink::text(name)`、`compressed(name)`、`batch(name, batchSize=100)`、`highPerf(name)` 均返回 `unique_ptr<FileSink>`；名字是 filePrefix，目录仍默认 /tmp；text/compressed 也默认 Auto 批量。需要隔离池、路径、尾批保证时直接使用 Config 构造。

## 3. AsyncFileExecutor：通用有序文件任务

定义：`/sandbox/common/base/file_sink/async_file_executor.h:113`。

### 3.1 配置与生命周期

~~~cpp
using Stream = uint64_t;
using Work = std::function<FileResult(FileOperations&)>;

struct Config {
  size_t max_tasks = 10000;
  size_t max_bytes = 10 * 1024 * 1024;
  size_t workers = 4;
  std::string thread_name = "async_file";
  std::shared_ptr<FileOperations> operations;
};
struct SubmitOptions {
  bool latest = false;
  bool retry = false;
  std::chrono::milliseconds delay{0};
};
~~~

max_tasks/max_bytes/workers 必须为正，否则构造抛 invalid_argument。operations 为空时使用默认文件原语。构造会创建线程，必须在启动阶段完成。

| 方法 | 说明 |
| --- | --- |
| `newStream()` | 创建非零 stream，启动时保存并复用 |
| `background()` | 进程生命周期后台池；启动时预热，不在首帧惰性创建 |
| `share() const` | 返回生命周期安全、非 owner 的 shared_ptr 句柄 |
| `stats() const` | 不等待 worker I/O 的健康快照 |
| `drain(milliseconds timeout) const` | 管理线程等任务计数归零，0 为立即检查，不同于 ticket.wait(0) |
| `stop(bool cancel_pending=false)` | 停准入/重试，可选取消排队任务，不取消在途 syscall |
| 析构 | owner 取消待执行任务，不 join 在途 syscall；share 句柄析构不停止 owner |

drain 返回 true 表示任务已结束，不表示全部成功；FileSink 尾批可能仍未写，后台 timer 也可能继续提交。要观察错误并显式 flush/close，持续生产时不要把 drain 当作永久屏障。

### 3.2 提交 API

~~~cpp
FileSubmission submit(Stream, size_t bytes, Work);
FileSubmission submit(Stream, size_t bytes, Work, SubmitOptions);
FileSubmission submitSequenceAsync(Stream, std::vector<FileOperation>);
FileSubmission submitSequenceAsync(Stream, std::vector<FileOperation>,
                                  SubmitOptions);
FileSubmission atomicReplaceAsync(
    Stream, std::string path, std::string data,
    FileDurability durability = FileDurability::FileSync);
FileSubmission appendAsync(Stream, std::string path, std::string data,
                           std::string header = "");
FileSubmission removeAsync(Stream, std::string path);
FileSubmission renameAsync(Stream, std::string from, std::string to);
~~~

removeAsync 对不存在的目标视为成功；底层是 unlink，只删除文件/符号链接，不支持目录或递归删除，不能视为 std::filesystem::remove 的全部语义替代。renameAsync 对源不存在视为失败，不自动创建目标父目录，也不在 EXDEV 时复制文件；依赖系统 rename 的文件系统边界与覆盖规则。appendAsync 是普通路径追加，每次任务打开、写入、关闭，不具备 FileSink 的长期 fd/轮转/批量能力；header 只在文件为空时写入，调用者负责 header 的分隔格式。它不自动 fsync。

`latest=true` 按 **stream** 替代尚未执行的旧 latest 任务；不是按 path 替代。不同 key 不能误用一个 latest stream。普通任务不因此变为可合并。旧在途任务可以完成 I/O，但较新 generation 存在时其最终状态可标为 Superseded。

`retry=true` 在失败后退避；适用于幂等最终状态，不适用于可能部分成功的追加。`delay` 是后台定时调度，未到期可被越过。默认 latest/retry 均关闭。

### 3.3 FileOperation

~~~cpp
struct FileOperation {
  enum class Kind { AtomicReplace, Append, Remove, Rename };
  Kind kind = Kind::AtomicReplace;
  std::string path;
  std::string destination;
  std::string data;
  std::string header;
  FileDurability durability = FileDurability::FileSync;
  bool missing_ok = true;
  std::function<bool(std::string*)> serialize;
  size_t snapshot_bytes = 0;
};
~~~

- AtomicReplace 使用 path + data/serialize，遵循指定 durability。
- Append 使用 path + data/serialize + header；durability 字段不为它添加 fsync。
- Remove 使用 path + missing_ok。
- Rename 使用 path → destination + missing_ok。**descriptor 默认 missing_ok=true，而 renameAsync 包装器显式设为 false**；业务 sequence 应主动选择。
- serialize 在 worker 执行，存在时覆盖 data 的输出来源；返回 false 产生 Serialize/EINVAL。必须捕获拥有所有权且不会再修改的快照。
- sequence 逻辑字节计费为各 operation 的 data/header/snapshot_bytes 总和，自定义闭包的实际内存仍需诚实计入。

`retainTaskMemory()` 是 worker 内部批量适配器 API，返回当前任务内存 token；FileSink 留存数据时保留它、释放 batch 时释放。普通业务不需要调用。

### 3.4 Stats

| 字段 | 含义 |
| --- | --- |
| outstanding | 排队 + 在途 + 退避任务数 |
| bytes | 仍保留的逻辑 payload 字节，包括 FileSink 尾批 token |
| running | 当前在途任务数 |
| completed | 已执行并终结的任务计数；不能简单当成成功次数 |
| failures | 失败执行尝试数，重试可能使同任务多次计数 |
| rejected | executor 准入拒绝次数，不能覆盖 adapter 在调用前的所有拒绝 |
| superseded | 被新版替代/越过的 latest 任务计数 |
| retries | 执行失败后安排重试的次数 |
| oldest_running_ms | 当前最长在途年龄，try-lock 采样失败时可能为 0 |

各字段独立采样，不是强一致快照。排查慢盘应关联 running、oldest_running_ms、bytes、队列拒绝和业务最后成功时间，不能只看队列长度。

## 4. FileOperations：文件原语与注入点

定义：`/sandbox/common/base/file_sink/async_file_executor.h:81`。

| 方法 | 作用 |
| --- | --- |
| virtual before(stage,path) | 每个注入阶段返回 errno 或阻塞，测试钩子在 worker 执行 |
| virtual write(fd,data,size) | 可注入短写/EINTR/错误的 write 边界 |
| ensureParent(path) | 创建父目录 |
| writeAll(fd,path,data) | 完整写入，处理短写/EINTR |
| sync(fd,path) | 文件 fsync |
| close(fd,path) | 关闭且检查错误；不盲目重试 close |
| remove(path,missing_ok=true) | 删除 |
| rename(from,to,missing_ok=false) | 重命名 |
| atomicReplace(path,data,durability) | 同目录临时文件、写、同步、rename、可选目录同步 |
| append(path,data,header="") | 打开追加、空文件 header、写、关闭 |

这是同步 API；通过 Executor Work 使用才具有后台隔离。FileOperations 对象通过 Config 注入；自定义钩子不得引用已销毁的测试对象或业务帧。

## 5. AsyncFileCache：固定 key 的最新状态

定义：`/sandbox/common/base/file_sink/async_file_cache.h:14`。

~~~cpp
struct Config {
  std::vector<std::string> paths;
  size_t max_snapshot_bytes = 4 * 1024 * 1024;
  std::shared_ptr<FileOperations> operations;
};
explicit AsyncFileCache(Config);
bool publish(size_t key, size_t bytes, AsyncFileExecutor::Work);
bool publish(size_t key, FileOperation);
bool remove(size_t key);
std::string path(size_t key) const;
Health health(size_t key) const;
bool drain(std::chrono::milliseconds timeout) const;
~~~

paths 必须非空、预算必须为正；在启动时固定 key 的数量和路径，避免帧内构建无界 map。内部 executor 为 1 worker，max_tasks=max(2, 2×key 数)，max_bytes=快照预算。

publish(op) **只允许 AtomicReplace/Remove**，且用 paths[key] 覆盖 op.path。Work 版本留给自定义格式，但必须拥有数据、准确计费、可幂等重试，不能拿它做有副作用的业务回调。publish 返回 true 表示 desired 已接收，尚未保证 executor 准入或文件成功。

publish/remove 的无效 key 返回 false；path/health 使用 at，越界抛 out_of_range，应使用初始化时定义的枚举 key。

| Health 字段 | 解释 |
| --- | --- |
| desired_generation | 最新接收的期望版本 |
| saved_generation | 已成功版本的最大值；删除成功也推进 |
| status/stage/error | dispatcher 观察到的提交/执行状态及错误 |
| rejected | publisher 的部分预算/分配拒绝计数；非所有返回 false 的完整分类，dispatcher 准入拒绝也不都计入此字段 |
| last_success_age_ms | 距上次成功的毫秒数；0 也可能从未成功，要结合 saved |

健康字段为异步采样，desired 更新后 status 可能仍属于前一次提交。不能用单次 status=Succeeded 代表最新状态已保存，应比较 saved_generation 与 desired_generation，并在停止生产后用 drain 做管理确认。drain 0 为当前完成检查/立即超时，不是无限等待；它不等待其他 executor 或 FileSink 输出。

Cache 不提供“持久化删除标记”或重启重放队列；进程内 desired 丢失后，掉电前未成功的删除不能自动恢复执行。

## 6. protobuf 适配

定义：`/sandbox/common/base/file_sink/async_proto_file.h:12`。

~~~cpp
FileOperation ProtoFileOperation(
    std::string path,
    std::shared_ptr<const google::protobuf::Message> snapshot,
    bool binary = false);
FileSubmission WriteProtoASCIIAsync(
    AsyncFileExecutor&, AsyncFileExecutor::Stream, std::string path,
    const google::protobuf::Message& message);
FileSubmission WriteProtoBinaryAsync(
    AsyncFileExecutor&, AsyncFileExecutor::Stream, std::string path,
    const google::protobuf::Message& message);
~~~

便捷 WriteProto 函数在调用端使用 New/CopyFrom 创建独立快照，worker 执行 TextFormat::PrintToString 或 SerializeToString；默认 FileSync 原子替换。没有最小 100 字节文件限制。

已拥有不可变快照时可构造 ProtoFileOperation，避免再复制一次。`shared_ptr<const Message>` 只限制这个引用，外部若还持有可变 alias 仍能破坏线程安全；移交后不得再修改。禁止捕获帧内 proto 裸指针、arena 对象裸指针、局部引用或生命周期未保证的 this。

快照复制本身在 producer 发生，可能耗 CPU/分配内存。通用便捷函数不会在复制前自动按业务上限预检，应先在业务侧检查 SpaceUsedLong 并限频。

## 7. FileWriter、FdGuard 与旧接口

定义：`/sandbox/common/base/file_sink/file_writer.h:84`、`fd_guard.h`、`sink.h`。

| FileWriter 方法 | 用途和约束 |
| --- | --- |
| getInstance / initialize(Config) | 启动初始化；已初始化时返回 true，不重新配置 |
| sharedExecutor() | 启动阶段获取默认共享池 |
| syncIntervalBytes() | 获取配置的累计字节 fsync 间隔 |
| `submitWrite(shared_ptr<FdGuard>,path,vector<char>&&,callback)` | 旧 fd 写入适配，bool 仅为准入 |
| waitForFile / waitForAll | 管理等待，0 为无限等待；含在途执行和回调 |
| getQueueSize / getQueueSizeBytes | 共享 executor 的任务/逻辑字节计数 |
| getFileStats(path) | 只统计直接 submitWrite 的文件，不统计 FileSink 内部写 |
| flushFile / flushAll | 第二层 batch 移除后为空操作，**不执行 fsync** |
| shutdown() | 停准入并按 writeTimeout 等 drain，不取消 syscall |

Config 显式默认值：maxQueueSize=1000、maxQueueSizeBytes=10MiB、workerThreadCount=2、writeTimeout=5000ms、syncIntervalBytes=2MiB。enableBatching=true/batchSize=10/batchTimeout=100ms 为源码兼容保留，当前不再启用第二队列。

若先构造默认 FileSink 或先 sharedExecutor 而未 initialize，惰性池使用 10000 任务、4 worker、10MiB。随后 initialize 不会更新这个池；**需要定制时必须先 initialize 再构造 sinks**。外部 executor 的 FileSink 使用内部默认 2MiB 同步间隔，FileSink::Config 没有独立 syncIntervalBytes 字段。

syncIntervalBytes 只是在累计字节达到阈值时执行 fsync，不承诺 dirty pages 硬上限，也不保证小尾批在 close 时被 fsync。

submitWrite 完成回调通常在 worker 执行，**准入拒绝时 callback(false) 会在调用线程内联执行**。回调必须短小、无阻塞，不能借失败回调同步补写；新帧路径优先用 ticket/Cache。

FdGuard 通过 fd 互斥锁保证 safeWrite/safeFsync/close 等生命周期安全，因此 close/get/isValid 都可能等待持锁 I/O；不能在帧线程操作它来达到“安全关闭”。FileSink 内部已改为 worker 独占 fd，不再依赖该路径。

FileWriter 的管理/统计接口包含普通锁，它是兼容层，不是新的实时准入门面。waitForAll 只能确认任务结束，不能刷新 Manual FileSink 尾批；要用该 sink 的 flush/close ticket。FileWriteTask 保留为源码兼容类型，实际任务由 Executor 调度。

## 8. 常用类型关系

~~~mermaid
classDiagram
    Sink <|-- FileSink
    FileSink --> AsyncFileExecutor : 一个有序 stream
    FileSink --> FileWriter : 默认共享池
    FileWriter --> AsyncFileExecutor : 兼容 fd 任务
    FileWriter --> FdGuard : 旧调用方持有
    AsyncFileCache --> AsyncFileExecutor : 专属单 worker
    AsyncFileExecutor --> FileOperations : worker 调用
    AsyncFileExecutor --> FileSubmission : 返回
    FileSubmission --> FileTicket
    FileTicket --> FileResult
    FileOperation --> FileDurability
~~~
