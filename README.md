# 点域采集 · Pointwise Delivery

在地图上框选一个区域，分块、分页地从本地 WFS 示例服务采集道路与设施要素。
结果既能在地图上查看，也能导出带完整来源链的 GeoJSON。

## 它解决了什么

朴素地“按选区发一次 WFS 请求”在真实场景里会踩一串坑，本项目把这些坑都做成了
可在界面上点选检查的演示：

| 问题 | 本项目的处理 |
| --- | --- |
| 选区太大，单次请求超时/超量 | 自动切成规则网格小块，逐块采集，每块显示页数与完成状态 |
| 跨块的线、面被多次返回 | 按**稳定要素标识**（`featureCode`）合并，绝不靠坐标比对 |
| 同一标识出现不同版本 | 保留全部版本及各自来源，代表要素取最高版本并写明选取依据 |
| 命中每页数量上限却拿不到可靠下一页 | 判定为**截断（未采全）**，绝不当作已经采全 |
| 查询坐标顺序与服务声明不一致 | 请求前校验轴顺序，不一致直接报明确错误，不静默交换坐标 |
| 分块查询带回选区外的要素 | 最终结果再做一次“与原始选区几何相交”过滤 |
| “没采到”与“确认没有数据”混淆 | 首页即空且总数为 0 的块单独标记为 `EMPTY_CONFIRMED` |
| 长任务不可控 | 支持暂停 / 继续 / 只重采失败与截断块 |

## 快速开始

```bash
npm install --cache ./.npm-cache   # 若全局 npm 缓存目录无写权限

# 终端 1：启动本地模拟 WFS（默认 127.0.0.1:8787）
npm run server

# 终端 2：启动前端（Vite，默认 5173，已配置 /wfs 代理）
npm run dev
```

浏览器打开 http://127.0.0.1:5173 ，点“框选整个演示范围” → “开始采集”。

## 三个示例服务端点

模拟服务（`server/`，零第三方依赖，仅用 Node 内置 `http`）提供三种模式：

1. **标准服务** `/wfs/standard`：`numberMatched` 与 `next` 链接完整，分页可靠。
2. **坏分页服务** `/wfs/brokenPaging`：密集点群查询命中 50 条/页上限后，
   不再返回总数和下一页链接，用来验证“达到上限又无可靠下一页 ⇒ 截断”的判定。
3. **严格轴顺序服务** `/wfs/axisFault`：服务声明 EPSG:3857/xy，
   勾选界面上的“故意按错误轴顺序（yx）发起查询”会收到明确的 `AXIS_ORDER_MISMATCH` 异常。

示例数据集（`server/data.js`，确定性伪随机生成，86 个要素）刻意包含：

- 多条贯穿/跨越分块边界的道路与设施面；
- 一个自动扫描出的、保证 bbox 级无任何要素的**数据空洞**（`DATA_VOID`，构建时有断言保护）；
- 一个 65 点的密集点群，配合每页 50 条上限制造截断；
- 同一要素在不同分块返回不同 `version` 的**版本漂移**。

## 操作指引

1. 选择服务端点（默认标准服务）与分块尺寸；2.5km 网格更容易出现空块。
2. 在地图上按住鼠标拖出矩形，或点“框选整个演示范围”。
3. 开始采集。地图网格按状态着色，左侧列表实时显示每块页数、取回数、状态与原因。
4. 暂停 / 继续：暂停是**门控式**的，在途请求会正常结束，引擎在翻页/取块前挂起。
5. 只重采失败/截断块：复用既有合并结果，新取回的要素（含新版本）并入同一条来源链。
6. 点右侧任一要素，查看它**经过哪些分块、哪一页、哪个版本、哪个端点**进入结果，
   地图会高亮这些分块。
7. 导出要素 GeoJSON（仅含与原始选区相交者）或分块状态 GeoJSON。

## 分块状态语义

| 状态 | 含义 |
| --- | --- |
| `PENDING` | 尚未开始 |
| `RUNNING` | 采集中 |
| `DONE_COMPLETE` | 已确认采全 |
| `EMPTY_CONFIRMED` | 服务确认该范围内无要素（区别于“还没采到”） |
| `INCOMPLETE` | 命中上限且无可靠下一页，**未采全**，需重采 |
| `FAILED` | 请求失败（含轴顺序错误） |
| `PAUSED` | 暂停期间挂起 |

## 代码结构

```
server/
  data.js      确定性示例数据集 + 数据空洞自动扫描与断言
  wfs.js       WFS GetCapabilities / GetFeature（三种模式、版本漂移、截断构造）
  index.js     零依赖 HTTP 服务入口
src/
  lib/
    geometry.ts    几何/bbox 相交（含“bbox 相交但几何绕过”的反例处理）
    chunking.ts    选区切网格、状态汇总、失败块筛选
    axisOrder.ts   轴顺序解析与一致性校验（不一致即抛 AxisOrderError）
    merge.ts       稳定标识合并、版本保留与选取依据、截断判定
    filter.ts      按原始选区做最终几何相交过滤
    wfsClient.ts   极简 WFS 2.0 客户端（count/startIndex/numberMatched/next）
    collector.ts   采集编排：并发、分页、门控暂停、重采、保险丝
    export.ts      要素与分块状态的 GeoJSON 导出
  map.ts           Leaflet 封装：框选、网格状态、要素渲染、来源分块高亮
  app.ts           UI 接线与状态管理
  types.ts         领域类型
test/
  unit/            纯逻辑与 jsdom UI 冒烟（Vitest）
  integration/     真实 HTTP 驱动采集引擎的端到端（Vitest，需先起 server）
  e2e/             服务契约测试（node:test，需先起 server）
  browser/         Playwright 像素级 UI 流程（需可运行 Chromium 的环境）
```

## 测试

```bash
npm run server &      # 集成与契约测试需要服务在线
npm test              # 单元 + 集成（Vitest，45 个用例）
npm run test:e2e      # 服务契约（node:test，6 个用例）
npm run test:browser # Playwright 真实浏览器流程（需要系统 Chromium 依赖）
```

关键安全规则都有对应测试：截断判定（`merge.test.ts`）、轴顺序拒绝
（`axisOrder.test.ts` + 集成测试）、按标识而非坐标合并（`merge.test.ts`）、
选区几何过滤（`filter-export.test.ts`）、暂停/继续与重采（`collector.test.ts`）。

> 说明：在无 root 权限、缺少 Chromium 系统库的精简容器里，`test:browser` 无法运行；
> 同一套 UI 接线由 `test/unit/app.ui.test.ts` 在 jsdom 中做冒烟覆盖，
> Playwright 脚本保留供具备浏览器依赖的环境执行。
