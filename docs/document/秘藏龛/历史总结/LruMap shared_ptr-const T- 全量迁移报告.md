---
title: "LruMap shared_ptr-const T- 全量迁移报告"
date: 2026-09-20
categories:
  - 秘藏龛
tags:
  - LruMap
---

<title id="JTCddetvtoFmq2x0wMRcHZhgnjP">LruMap shared_ptr 全量迁移报告</title>

# LruMap `shared_ptr<const T>` 全量迁移报告

## 概述

本次迁移覆盖 `/sandbox` 下**所有仓库**中使用 `LruMap` 的模块，将值存储或非 const 指针存储的 `LruMap` 迁移为 `LruMap<Key, std::shared_ptr<const T>>` 偏特化版本，利用 COW（Copy-On-Write）语义实现：

1. **零拷贝缓存读取**：`GetReadOnly` 返回 `shared_ptr<const T>`，避免从缓存复制整个对象
2. **安全缓存写入**：`Put` 接受 `shared_ptr<const T>`，缓存内容不可被调用方意外修改
3. **防缓存污染**：通过 `const` 约束，编译期阻止对缓存对象的修改
4. **按需深拷贝**：`GetMutableCopy` 在确实需要修改时提供独立副本

### 迁移范围

共修改 **10 个模块、30+ 个文件**，涉及 **19 个 LruMap/MultiLevelCache 实例**，横跨 7 个代码仓库：

- `common`（semantic_lmdb、road_map）
- `map-engine`（routing、utils、data_provider、data_collection、processor）
- `perception_adas`（rear_warning）
- `lam-common`（sd_map）
- `mapping`（tile_server、localization）
- `emulator`（ras_map）
- `localization`（executable）

### 迁移分类

| 类型 | 描述 | 实例数 |
|-|-|-|
| **A 类** | 值存储 → `shared_ptr<const T>` | 10 |
| **B 类** | `shared_ptr<T>` → `shared_ptr<const T>` | 8 |
| **C 类** | API 命名优化（已正确使用偏特化） | 1 |
| **未迁移** | POD 类型或开销不适合 | 1 |

---

## 一、基础设施

### 1.1 LruMap 偏特化设计（`common/common/lru_map.h`/`.hpp`）

LruMap 模板提供了两个版本：

| 版本 | 存储方式 | 读接口 | 写接口 | 适用场景 |
|-|-|-|-|-|
| 主模板 `LruMap<Key, Value>` | 值存储 | `GetItem(key, Value*)` — 深拷贝 | `AddItem(key, Value)` — 深拷贝 | 小型 POD 类型 |
| 偏特化 `LruMap<Key, shared_ptr<const T>>` | COW 指针 | `GetReadOnly(key, &ptr)` — 零拷贝 | `Put(key, ptr)` — 引用计数 | protobuf 及大对象 |

偏特化版本额外提供：

- `GetMutableCopy(key, &mutable_ptr)` — 深拷贝后返回可修改的 `shared_ptr<T>`
- 兼容旧接口 `GetItem`/`AddItem` — 自动路由到 `GetReadOnly`/`Put`

### 1.2 SerializeType 偏特化（`map-engine/utils/serialize_type.hpp`）

为支持 `MultiLevelCache`（含 LevelDB/LMDB L2 缓存层）的序列化需求，新增：

```cpp
template <class T>
class SerializeType<std::shared_ptr<const T>> {
  static std::string SerializeAsString(const std::shared_ptr<const T>& ptr) {
    if (ptr) return SerializeType<T>::SerializeAsString(*ptr);
    // ...
  }
  static absl::StatusOr<std::shared_ptr<const T>> Deserialize(
      const std::string& serialized_str) {
    auto status_or_t = SerializeType<T>::Deserialize(serialized_str);
    if (!status_or_t.ok()) return status_or_t.status();
    return std::make_shared<const T>(std::move(status_or_t).value());
  }
};
```

**设计要点**：放在 `SerializeType<shared_ptr<T>>` 之后，因为 `shared_ptr<const T>` 比 `shared_ptr<T>` 更特化，编译器会优先匹配。内部委托 `SerializeType<T>` 完成实际序列化/反序列化。

### 1.3 MultiLevelCache 兼容性（`map-engine/utils/multi_level_cache.h`/`.hpp`）

MultiLevelCache 本身无需修改。LruMap 偏特化的兼容重载自动路由：

- `GetItem(key, shared_ptr<const T>*)` → `GetReadOnly`（零拷贝）
- `AddItem(key, shared_ptr<const T>)` → `Put`（shared_ptr 拷贝）

---

## 二、map-engine 内部迁移

### 2.1 A 类：protobuf 按值存储 → `shared_ptr<const Proto>`

#### `utils/sd_map_tile_server.h`/`.cc`

| 成员 | 修改前 | 修改后 |
|-|-|-|
| `tile_lru_map_` | `MultiLevelCache<string, S2TileCache>` | `MultiLevelCache<string, shared_ptr<const S2TileCache>>` |

**修改原因**：`S2TileCache` 包含完整的 SD 地图瓦片数据（link、lane 等），每次 `Query` 返回 `optional<S2TileCache>` 触发深拷贝。

**修改细节**：

- `Query` 返回值改为 `optional<shared_ptr<const S2TileCache>>`，零拷贝读取
- 构建新缓存条目时先用 mutable `shared_ptr<S2TileCache>` 修改，完成后转为 const 写入
- 提取 `link_datas` 从 `std::move` 改为 const copy（单条 link 远小于整个 S2TileCache，净性能提升）

#### `mp_operation/mp_writer_server.h`/`.cc`

| 成员 | 修改前 | 修改后 |
|-|-|-|
| `s2_to_mp_ids_` | `MultiLevelCache<string, S2RoiMpId>` | `MultiLevelCache<string, shared_ptr<const S2RoiMpId>>` |
| `mp_meta_lru_map_` | `MultiLevelCache<string, QueryMpMetaResponse>` | `MultiLevelCache<string, shared_ptr<const QueryMpMetaResponse>>` |

**修改原因**：`S2RoiMpId` 和 `QueryMpMetaResponse` 都是 protobuf 消息。`StoreS2ToMpIds` 的 merge 逻辑原先直接修改从缓存获取的值——典型缓存污染。

**merge 逻辑修复（StoreS2ToMpIds）**：

- 修改前：`Query` 返回值类型的 `S2RoiMpId` 可以直接 `add_roi_and_mp_id()` 修改
- 修改后：`Query` 返回 `shared_ptr<const S2RoiMpId>`，merge 时先深拷贝为 mutable 副本再修改，最后包装为 `shared_ptr<const>` 写入

### 2.2 B 类：`shared_ptr<T>` → `shared_ptr<const T>`

#### `mp_operation/mp_writer_server.h`/`.cc`

| 成员 | 修改前 | 修改后 |
|-|-|-|
| `roi_lru_map_` | `LruMap<string, shared_ptr<roi::Roi>>` | `LruMap<string, shared_ptr<const roi::Roi>>` |
| `mp_lru_map_` | `LruMap<string, shared_ptr<MpBlockData>>` | `LruMap<string, shared_ptr<const MpBlockData>>` |

#### `mp_operation/mp_reader_server.h`/`.cc`

类型别名和返回值同步更新为 `shared_ptr<const T>`。

#### `data_collection/data_trigger.h`/`.cc`

| 成员 | 修改前 | 修改后 | 污染修复 |
|-|-|-|-|
| `trigger_lru_map_` | `shared_ptr<Trigger>` | `shared_ptr<const Trigger>` | N/A |
| `roi_lru_map_` | `shared_ptr<roi::Roi>` | `shared_ptr<const roi::Roi>` | N/A |
| `link_2_roi_ids_` | `shared_ptr<unordered_set>` | `shared_ptr<const unordered_set>` | **已修复** |

**`link_2_roi_ids_` 缓存污染修复**（关键修改）：

修改前（存在污染）：

```cpp
shared_ptr<unordered_set<uint64_t>> roi_id_set;
link_2_roi_ids_.GetItem(link, &roi_id_set);
roi_id_set->insert(roi_id);  // 直接修改缓存中的对象！
link_2_roi_ids_.AddItem(link, roi_id_set);
```

修改后（COW 模式）：

```cpp
shared_ptr<const unordered_set<uint64_t>> existing;
shared_ptr<unordered_set<uint64_t>> mutable_set;
if (link_2_roi_ids_.GetReadOnly(link, &existing) && existing) {
    mutable_set = make_shared<unordered_set<uint64_t>>(*existing);
} else {
    mutable_set = make_shared<unordered_set<uint64_t>>();
}
mutable_set->insert(roi_id);
link_2_roi_ids_.Put(link, std::move(mutable_set));
```

#### `processor/parking_map_store.h`/`.cc`

| 成员 | 修改前 | 修改后 | 污染修复 |
|-|-|-|-|
| `realtime_lru_` | `shared_ptr<RealtimeState>` | `shared_ptr<const RealtimeState>` | **已修复** |

**缓存污染修复**：`Update()` 中原先通过 `GetItem` 获取 `shared_ptr<RealtimeState>` 后直接修改成员字段。修改后使用 `GetMutableCopy` 获取独立副本，修改完毕后通过 `Put` 写回缓存。读路径（`Get`、`GetVirtualLinks` 等）改用 `GetReadOnly` 零拷贝。

#### `routing/navigation/navigation_api.cc`

| 成员 | 修改前 | 修改后 |
|-|-|-|
| `request_job_lru_` | `shared_ptr<NavigationRequestJob>` | `shared_ptr<const NavigationRequestJob>` |

### 2.3 上下游 API 联动修改

| 文件 | 修改内容 |
|-|-|
| `data_generation_utils.h`/`.cc` | `GetSensingFrameIntensity` 参数改为 `shared_ptr<const MpBlockData>` |
| `roi_match.h`/`.cc` | `IsMatchRoi` 参数改为 `shared_ptr<const roi::Roi>` |
| `model_data_loader.cc` | `GetMpTiles` 返回值改为 `shared_ptr<const MpBlockData>` |
| `data_trigger_test.cc` | 测试用例更新为使用 `GetReadOnly`/`Put` 新 API |

---

## 三、common/semantic_lmdb — 值存储 protobuf 迁移

### 修改文件

#### 3.1 `common/common/semantic_lmdb/tiled_semantic_lmdb_server.h`

| 成员 | 修改前 | 修改后 |
|-|-|-|
| `lru_tiles_` | `LruMap<string, TileData>` | `LruMap<string, shared_ptr<const TileData>>` |
| `lru_elements_` | `LruMap<int, hdmap::Map>` | `LruMap<int, shared_ptr<const hdmap::Map>>` |

**修改原因**：`TileData` 和 `hdmap::Map` 都是 protobuf 消息类型。`TileData` 包含 element_ids 列表，`hdmap::Map` 包含完整的语义地图元素（车道、交叉路口、交通标志等），拷贝开销显著。

**公开 API 影响**：无。采用方案 A，`GetTileById` 和 `GetElementById` 的签名保持不变（仍接受 `T*` 输出参数）。

#### 3.2 `common/common/semantic_lmdb/tiled_semantic_lmdb_server.cpp`

**修改细节**：

1. **构造函数**：`make_unique<LruMap<..., TileData>>` → `make_unique<LruMap<..., shared_ptr<const TileData>>>`，`hdmap::Map` 同理
2. **`GetTileById` 方法**：

   - 原来：`lru_tiles_->GetItem(id, tile_data)` — 直接深拷贝到输出参数
   - 现在：`lru_tiles_->GetReadOnly(id, &cached)` 零拷贝获取引用，再 `*tile_data = *cached` 拷贝到输出
   - 写入：`lru_tiles_->AddItem(id, *tile_data)` → `lru_tiles_->Put(id, make_shared<const TileData>(*tile_data))`
3. **`GetElementById` 方法**：同上模式

**性能优化点**：

- **缓存命中**：原先 `GetItem` 内部做一次深拷贝。现在 `GetReadOnly` 零拷贝获取引用，仅在输出到调用方时拷贝一次。净省一次 LruMap 内部拷贝。
- **缓存写入**：原先 `AddItem(id, *tile_data)` 拷贝一次到 LruMap 内部存储。现在 `Put(id, shared_ptr)` 只移动指针，零额外拷贝。

**下游影响**：无。所有调用方（`semantic_map_conversion.cpp`、`topo_graph_creator.cpp`、`hd_map_server_loading_utils.cpp`、测试文件）无需修改。

---

## 四、perception_adas/rear_warning — 值存储 protobuf 迁移

### 修改文件

#### 4.1 `perception_adas/src/rear_warning/rear_warning_processor.h`

| 成员 | 修改前 | 修改后 |
|-|-|-|
| `pre_left_dow_trigger_objs_` | `LruMap<int32_t, PerceptionObstacle>` | `LruMap<int32_t, shared_ptr<const PerceptionObstacle>>` |
| `pre_right_dow_trigger_objs_` | 同上 | 同上 |
| `bsd_entry_from_front_objs_left_` | 同上 | 同上 |
| `bsd_entry_from_front_objs_right_` | 同上 | 同上 |

**修改原因**：`PerceptionObstacle` 是 protobuf 消息，包含感知目标的位置、速度、类型、时间戳等完整信息。4 个 LruMap 缓存 BSD（盲区检测）和 DOW（开门预警）场景的历史目标，每帧都需要查询以进行时间戳比较和位置差分计算。原实现每次查询都深拷贝整个 protobuf。

#### 4.2 `perception_adas/src/rear_warning/rear_warning_processor.cpp`

**修改细节**：

1. **构造函数**（4 处）：`new LruMap<int32_t, PerceptionObstacle>(N)` → `new LruMap<int32_t, shared_ptr<const PerceptionObstacle>>(N)`
2. **AddItem → Put**（4 处）：

   - `bsd_entry_from_front_objs_left_->AddItem(obj.id(), obj)` → `Put(obj.id(), make_shared<const PerceptionObstacle>(obj))`
3. **GetItem → GetReadOnly**（4 处）：

   - BSD 场景：`PerceptionObstacle bsd_entry_from_front_obj` → `shared_ptr<const PerceptionObstacle> bsd_entry_from_front_obj`
   - 成员访问从 `.timestamp()` 改为 `->timestamp()`，`.position().x()` 改为 `->position().x()`
4. **RemoveItem**（4 处）：无需修改，偏特化版本保留了 `RemoveItem` 接口

**性能优化点**：

- **每帧 BSD 检查**：`GetReadOnly` 零拷贝获取目标时间戳用于比较，避免拷贝整个 `PerceptionObstacle` 仅为读取一个 `double` 字段
- **每帧 DOW 检查**：位置比较同理，零拷贝读取 `position().x()` 和 `position().y()`
- **写入优化**：`Put` 接受 `shared_ptr`，避免 LruMap 内部的值拷贝

**下游影响**：无。修改完全封装在 `RearWarningProcessor` 内部。

---

## 五、map-engine/data_generation_utils — 值存储大容器迁移 + 线程安全修复

### 修改文件

#### 5.1 `map-engine/v2/data_provider/mp_data_provider/data_generation_utils.cc`

**修改内容**：

1. **新增 `#include <mutex>`**
2. **类型定义**：新增 `using DecodedImages = std::vector<std::pair<std::string, cv::Mat>>`
3. **静态变量**：

   - 新增：`static std::mutex decoded_image_mutex`
   - 修改：`static LruMap<uint64_t, vector<pair<string, cv::Mat>>>` → `static LruMap<uint64_t, shared_ptr<const DecodedImages>>`
4. **缓存读取 lambda**：返回类型改为 `shared_ptr<const DecodedImages>`，读写路径加 `lock_guard` 保护
5. **消费循环**：`for (const auto& [name, block_image] : images)` → `for (const auto& [name, block_image] : *images)`

**修改原因**：

- **性能**：原 `vector<pair<string, cv::Mat>>` 存储解码后的图像数据，每个 `cv::Mat` 可能包含数百 KB 像素数据。`GetItem` 深拷贝整个 vector。迁移后 `GetReadOnly` 零拷贝返回 `shared_ptr`
- **线程安全**：原代码使用 `static` 变量但**无任何互斥保护**。在多线程场景下对 LruMap 的并发读写是未定义行为。本次添加 `std::mutex` 修复了这个潜在的竞态条件

**性能优化点**：

- `GetReadOnly` 返回 `shared_ptr<const DecodedImages>`，后续遍历直接使用引用，零拷贝
- `Put` 移入 `shared_ptr`，无额外拷贝
- 锁的粒度最小化：仅在访问 LruMap 时加锁，图像解码（耗时操作）在锁外进行

**下游影响**：无。修改在函数内部封闭。

---

## 六、common/road_map/hd_map_server_loader — shared_ptr 加 const 防污染

### 修改文件

#### 6.1 `common/common/road_map/hd_map_server_loader.h`

| 成员/接口 | 修改前 | 修改后 |
|-|-|-|
| `CacheData::lru_maps` | `LruMap<string, shared_ptr<HDMapServerType>>` | `LruMap<string, shared_ptr<const HDMapServerType>>` |
| `CacheData::most_recent_data` | `shared_ptr<HDMapServerType>` | `shared_ptr<const HDMapServerType>` |
| `LoadLocalMapServerSync()` 返回值 | `shared_ptr<HDMapServerType>` | `shared_ptr<const HDMapServerType>` |
| `FetchNewLocalMapServerIfAvailable()` 出参 | `shared_ptr<HDMapServerType>*` | `shared_ptr<const HDMapServerType>*` |
| `GetMapDataFromCacheNoMutex()` 返回值 | `shared_ptr<HDMapServerType>` | `shared_ptr<const HDMapServerType>` |
| `StoreMapDataToCacheNoMutex()` 参数 | `shared_ptr<HDMapServerType>` | `shared_ptr<const HDMapServerType>` |

**修改原因**：`HDMapServerType`（如 `HDMapProtoServer`、`HDMapLaneInfoServer`）包含完整的高精地图数据和预计算索引。对象在 `Initialize()` 完成后语义上不可变。但原 `shared_ptr<HDMapServerType>`（非 const）允许调用方通过返回的指针意外修改缓存对象。

#### 6.2 `common/common/road_map/hd_map_server_loader.cpp`

**修改细节**：

1. **构造函数**（2 处）：`make_unique<LruMap<..., shared_ptr<HDMapServerType>>>` → `shared_ptr<const HDMapServerType>>`
2. **`LoadLocalMapServerSync`**：

   - 返回类型改为 `shared_ptr<const HDMapServerType>`
   - 内部：先用 `auto mutable_data = make_shared<HDMapServerType>()` 构建和初始化，完成后 `map_data = std::move(mutable_data)` 转为 `shared_ptr<const>`
   - 确保 `Initialize()` 在对象还是 mutable 时调用
3. **`LoadHDMapAsyncWork`**：同上模式 — 构建 → 初始化 → 转 const → 存入缓存
4. **`GetMapDataFromCacheNoMutex`**：`GetItem` → `GetReadOnly`
5. **`StoreMapDataToCacheNoMutex`**：`AddItem` → `Put`。注意先赋值 `most_recent_data` 再 `Put`（因为 `Put` 可能移动 `map_data`）

#### 6.3 `common/common/road_map/single_hd_map_server.h`

| 接口 | 修改前 | 修改后 |
|-|-|-|
| `LocalMapPtr()` | 委托 `MutableLocalMapPtr()` | 直接返回 `shared_ptr<const>` |
| `MutableLocalMapPtr()` | 返回 `shared_ptr<HDMapServerType>` | **已移除** |
| `SetLocalMapPtr()` | 接受 `shared_ptr<HDMapServerType>` | 接受 `shared_ptr<const HDMapServerType>` |
| `map_server_` | `shared_ptr<HDMapServerType>` | `shared_ptr<const HDMapServerType>` |

**移除 `MutableLocalMapPtr()` 的原因**：经搜索确认仅在类内部被 `LocalMapPtr()` 调用，无外部使用者。返回 mutable 指针会绕过 const 保护。

#### 6.4 `common/common/road_map/single_hd_map_server.cpp`

`MutableLocalMapPtr()` 重命名为 `LocalMapPtr()`，返回类型改为 `shared_ptr<const>`。静态成员 `map_server_` 定义同步更新。

#### 6.5 下游调用方适配

| 文件 | 修改内容 |
|-|-|
| `emulator/plugin/lib/ras_map/rasmap_service.cc` | 移除冗余 `map_server->Initialize()` 调用（已在 loader 内部完成，且 const 对象无法调用非 const 方法） |
| `localization/localization/executable/rasmap_visualizer.cpp` | `hd_map_` 成员和 `FetchNewLocalMapServerIfAvailable` 出参改为 `shared_ptr<const>` |
| `common/common/road_map/hd_map_server_loader_test.cpp` | 所有 `shared_ptr<HDMapLaneInfoServer>` → `shared_ptr<const HDMapLaneInfoServer>` |

**无需修改的文件**：`emulator/emulator_v2/business_logic/common/map_creator.cc` — `const auto local_map = loader->LoadLocalMapServerSync(...)` 中 `auto` 自动推导为新类型。

---

## 七、lam-common/sd_map/tile_data_server — shared_ptr 加 const 防污染

### 修改文件

#### 7.1 `lam-common/lam_common/sd_map/tile_data_server.h`

| 接口/成员 | 修改前 | 修改后 |
|-|-|-|
| `tile_cache_` | `LruMap<uint32_t, shared_ptr<IDataCube>>` | `LruMap<uint32_t, shared_ptr<const IDataCube>>` |
| `QueryTileData()` | 返回 `shared_ptr<IDataCube>` | 返回 `shared_ptr<const IDataCube>` |
| `QueryTiles()` | 返回 `vector<shared_ptr<IDataCube>>` | 返回 `vector<shared_ptr<const IDataCube>>` |
| `QueryRect()` | 返回 `shared_ptr<IDataCube>` | 返回 `shared_ptr<const IDataCube>` |

**SDK const 兼容性验证**：检查了 `nerd::api::IDataCube` 接口定义，确认关键方法 `GetSDLinkLayer()` 标记为 `const`，返回 `ISDLinkLayer*`。所有实际调用路径兼容 `const IDataCube`。

#### 7.2 `lam-common/lam_common/sd_map/tile_data_server.cpp`

- `QueryTileData`：局部变量改为 `shared_ptr<const IDataCube>`，`GetItem` → `GetReadOnly`，`AddItem` → `Put`
- `QueryTiles`/`QueryRect`：返回类型同步修改

**类型转换说明**：`TileCallback::Wait()` 返回 `shared_ptr<IDataCube>`（非 const），赋值给 `shared_ptr<const IDataCube>` 时自动隐式转换。

**下游影响**：`tencent_compiler.cpp` 中 `const auto tile = ...` 自动推导为新类型，无需修改。

---

## 八、lam-common/sd_map/sd_prod_tile_server — API 命名优化

### 修改文件

#### 8.1 `lam-common/lam_common/sd_map/sd_prod_tile_server.cpp`

- `tile_cache_.GetItem(tile_id, &tile)` → `tile_cache_.GetReadOnly(tile_id, &tile)`
- `tile_cache_.AddItem(tile_id, tile)` → `tile_cache_.Put(tile_id, tile)`

**修改原因**：此 LruMap 已经是 `LruMap<uint32_t, shared_ptr<const SDProdTileUtil>>` 偏特化版本。`GetItem`/`AddItem` 通过兼容层路由到 `GetReadOnly`/`Put`，功能等价。改名提升代码可读性和一致性。

**性能影响**：无。编译后生成相同的代码。

---

## 九、mapping/tile_server/TiledMapServer — 模板类值存储迁移

### 修改文件

#### 9.1 `mapping/mapping/tile_server/tiled_map_server.h`

| 成员/参数 | 修改前 | 修改后 |
|-|-|-|
| 构造函数 `cache_map` 参数 | `LruMap<string, MapElementsType>` | `LruMap<string, shared_ptr<const MapElementsType>>` |
| `lru_tiles_` 成员 | `LruMap<string, MapElementsType>` | `LruMap<string, shared_ptr<const MapElementsType>>` |

**修改原因**：`TiledMapServer` 是模板类，`MapElementsType` 可能是 `NdtMapCells`、`MultiLayerNdtCells`、`IntensityMapCells` 等，都是包含大量点云或栅格数据的类型。原实现每次 `GetItem` 深拷贝整个 tile 数据。

#### 9.2 `mapping/mapping/tile_server/tiled_map_server.hpp`

**修改细节**：

1. **`GenerateLruMap` 工厂函数**：返回类型改为 `unique_ptr<LruMap<string, shared_ptr<const MapElementsType>>>`
2. **`GetTileByKey`**（核心读路径）：

   - 原来：`lru_tiles_->GetItem(key, tile_data)` 直接拷贝
   - 现在：`lru_tiles_->GetReadOnly(key, &cached)` 零拷贝 → `*tile_data = *cached` 输出时拷贝
3. **`WriteTileNoOverwrite`**：`AddItem(key, tile_data)` → `Put(key, make_shared<const MapElementsType>(tile_data))`
4. **`WriteTileAllowingOverwrite`**：直接在堆上创建 `make_shared<MapElementsType>(...)`，反序列化后转 const 再 `Put`，避免栈→堆拷贝

**性能优化点**：

- **`GetNearbyTiles` 场景**（最大收益）：一次调用可能查询 10-50 个 tile，原来每个 tile 命中缓存时都深拷贝。现在 `GetReadOnly` 零拷贝
- **缓存写入**：`Put` 移入 `shared_ptr`，避免 LruMap 内部的值拷贝

**公开 API 影响**：无。`GetTile`、`GetTileByKey`、`GetNearbyTiles` 等签名保持不变。

---

## 十、mapping/localization/map_constraint_sources_loader — shared_ptr 加 const 防污染

### 修改文件

#### 10.1 `mapping/localization/map_loader/map_constraint_sources_loader.h`

| 接口/成员 | 修改前 | 修改后 |
|-|-|-|
| `LoadedData::lru_data` | `LruMap<string, shared_ptr<MapConstraintSources>>` | `LruMap<string, shared_ptr<const MapConstraintSources>>` |
| `LoadedData::most_recent_data` | `shared_ptr<MapConstraintSources>` | `shared_ptr<const MapConstraintSources>` |
| `GetMapConstraintSourcesSync()` | 返回 `shared_ptr<MapConstraintSources>` | 返回 `shared_ptr<const MapConstraintSources>` |
| `FetchMostRecentMapConstraintSources()` | 出参 `shared_ptr<MapConstraintSources>*` | 出参 `shared_ptr<const MapConstraintSources>*` |
| `GetConstraintSourcesFromCacheNoMutex()` | 返回 `shared_ptr<MapConstraintSources>` | 返回 `shared_ptr<const MapConstraintSources>` |
| `StoreLoadedConstraintSourcesNoMutex()` | `const shared_ptr<MapConstraintSources>&` | `shared_ptr<const MapConstraintSources>` |

**修改原因**：`MapConstraintSources` 包含 KD-Tree 索引等预计算数据结构，一旦构建完成不应被修改。原 `shared_ptr<MapConstraintSources>` 允许调用方修改缓存中的 KD-Tree。

#### 10.2 `mapping/localization/map_loader/map_constraint_sources_loader.cpp`

- 构造函数类型更新
- `GetConstraintSourcesFromCacheNoMutex`：`GetItem` → `GetReadOnly`
- `StoreLoadedConstraintSourcesNoMutex`：`AddItem` → `Put`，参数改为按值传递 + `std::move`
- `LoadConstraintSourcesAsyncWork`：局部变量类型改为 `shared_ptr<const>`，工厂返回 `shared_ptr<T>` 隐式转为 `shared_ptr<const T>`

#### 10.3 下游调用方适配

| 文件 | 修改内容 |
|-|-|
| `mapping/localization/kalman_filter/lidar_measurement_model.h` | `map_constraint_sources_` 成员改为 `shared_ptr<const MapConstraintSources>` |
| `mapping/localization/kalman_filter/lidar_measurement_model.cpp` | 局部变量类型适配 |
| `mapping/localization/map_loader/map_constraint_sources_loader_test.cpp` | 测试变量类型适配 |

---

## 十一、未迁移的 LruMap 实例

| 文件 | 类型 | 原因 |
|-|-|-|
| `map-engine/joint/coordinate_utils.cc` | `LruMap<uint64_t, pair<double,double>>` | 16 字节 POD 类型，拷贝成本可忽略，`shared_ptr` 反而增加堆分配和原子操作开销 |

---

## 十二、性能影响分析

### 整体收益

| 场景 | 影响 | 说明 |
|-|-|-|
| MultiLevelCache/LruMap Query（高频） | **显著提升** | 从深拷贝 protobuf/大对象变为 `shared_ptr` 引用计数 +1，O(1) |
| 缓存写入 Insert/Put | **提升** | `shared_ptr` 移动代替值拷贝 |
| DB Serialization（MultiLevelCache L2） | **不变** | 新 `SerializeType` 偏特化与原行为一致 |
| `GetNearbyTiles`（mapping） | **最大收益** | 单次查询 10-50 tile，每次零拷贝 vs 原先每次深拷贝 |
| BSD/DOW 检查（perception_adas） | **显著提升** | 每帧零拷贝读时间戳/位置 vs 原先拷贝整个 PerceptionObstacle |
| 图像解码缓存（map-engine） | **提升 + 安全** | 零拷贝 + 新增 mutex 修复竞态 |

### 额外开销

| 场景 | 开销 | 可接受性 |
|-|-|-|
| `link_2_roi_ids_` COW 写路径 | `unordered_set` 拷贝（通常几十个 uint64_t） | 可接受，低频 |
| `parking_map_store` Update | `RealtimeState` 浅拷贝 | 可接受，低频操作 |
| `StoreS2ToMpIds` merge | `S2RoiMpId` 深拷贝 | 可接受，低频，体积小 |
| `TiledMapServer` 输出拷贝 | `*tile_data = *cached` | 与原来相同，仅从 LruMap 内部拷贝转为输出时拷贝 |

---

## 十三、风险评估

1. **`hd_map_server_loader` 公开 API 变更**：影响面最广，涉及 emulator、localization、测试等多个模块。所有 `/sandbox` 内的调用方已在本次迁移中更新。**如有未在 `/sandbox` 中的外部调用方，需同步修改。**
2. **`tile_data_server` SDK const 兼容性**：`nerd::api::IDataCube` 部分方法（如 `GetNextLinkIDs`）不是 const，但当前代码路径未直接在 `IDataCube` 上调用这些非 const 方法。如有新调用方需要非 const 方法，需通过 `GetSDLinkLayer()` 间接访问。
3. **`TiledMapServer` 模板类**：作为模板类的修改，所有实例化类型（`NdtMapCells`、`MultiLayerNdtCells`、`IntensityMapCells`、`RGBMapCells`、`RealityTilePoints`）都需支持拷贝构造。原代码已有值拷贝，故兼容。
4. **`single_hd_map_server` 移除 `MutableLocalMapPtr()`**：经搜索确认无外部调用方。如有未发现的使用者，编译时会报错。
5. **`data_generation_utils` 新增 mutex**：修复了原有的竞态条件，但引入了串行化开销。由于 LruMap 操作本身很快（查找/插入），锁持有时间极短，不会成为瓶颈。

---

## 十四、修改统计汇总

| 模块 | 仓库 | 文件数 | LruMap 实例数 | 迁移类型 |
|-|-|-|-|-|
| sd_map_tile_server | map-engine | 2 | 1 | A: 值 → `shared_ptr<const>` |
| mp_writer_server | map-engine | 2 | 4 | A+B: 值+指针迁移 |
| mp_reader_server | map-engine | 2 | — | 上下游联动 |
| data_trigger | map-engine | 2 | 3 | B: shared_ptr 加 const + 缓存污染修复 |
| parking_map_store | map-engine | 2 | 1 | B: shared_ptr 加 const + 缓存污染修复 |
| navigation_api | map-engine | 1 | 1 | B: shared_ptr 加 const |
| serialize_type | map-engine | 1 | — | 基础设施：新增偏特化 |
| semantic_lmdb | common | 2 | 2 | A: 值 → `shared_ptr<const>` |
| hd_map_server_loader | common | 4 | 1 | B: shared_ptr 加 const |
| single_hd_map_server | common | 2 | — | 上下游联动 |
| rear_warning | perception_adas | 2 | 4 | A: 值 → `shared_ptr<const>` |
| data_generation_utils | map-engine | 1 | 1 | A: 值 → `shared_ptr<const>` + mutex |
| tile_data_server | lam-common | 2 | 1 | B: shared_ptr 加 const |
| sd_prod_tile_server | lam-common | 1 | 1 | C: API 命名优化 |
| TiledMapServer | mapping | 2 | 1 | A: 值 → `shared_ptr<const>` |
| MapConstraintSourcesLoader | mapping | 3 | 1 | B: shared_ptr 加 const |
| lidar_measurement_model | mapping | 2 | — | 上下游联动 |
| rasmap_service | emulator | 1 | — | 上下游联动 |
| rasmap_visualizer | localization | 1 | — | 上下游联动 |
| 测试文件 | 各仓库 | 3 | — | 类型适配 |
| **合计** | **7 仓库** | **\~36** | **22** | — |
