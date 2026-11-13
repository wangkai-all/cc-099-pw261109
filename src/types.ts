/**
 * 全局领域类型定义。
 * 坐标一律采用服务声明 CRS 下的轴顺序存储（EPSG:3857: [easting, northing]；
 * EPSG:4326: [lon, lat] 仅在显式声明 axisOrder=lonlat 时）。
 */

export type AxisOrder = 'xy' | 'yx';

export interface CrsInfo {
  /** 例如 EPSG:3857 / EPSG:4326 */
  srsName: string;
  /** 服务在 GetCapabilities 中声明的轴顺序 */
  axisOrder: AxisOrder;
}

/** [x, y]，x/y 的含义由 CRS 决定（3857 下为东距/北距） */
export type Position = [number, number];

/** GeoJSON 几何（本项目支持 LineString / Polygon / Point / Multi* ） */
export interface GeoGeometry {
  type:
    | 'Point'
    | 'LineString'
    | 'Polygon'
    | 'MultiPoint'
    | 'MultiLineString'
    | 'MultiPolygon';
  coordinates: unknown;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 模拟服务返回的单个要素（GeoJSON Feature 的超集，带版本与来源信息） */
export interface WfsFeature {
  type: 'Feature';
  id: string;
  geometry: GeoGeometry;
  properties: Record<string, unknown> & {
    /** 稳定要素标识的原始值（与 id 同源，保留便于核对） */
    featureCode?: string;
    /** 数据版本号，数字越大越新；服务可能在不同分块给出不同版本 */
    version?: number;
    kind?: string;
    name?: string;
  };
}

/** 分页响应元数据 */
export interface WfsPageMeta {
  numberMatched: number | null;
  numberReturned: number;
  /** 服务给出的下一页起始索引；null 表示无可靠下一页 */
  nextIndex: number | null;
  /** 本页返回数量是否恰好撞上 count 上限（潜在截断信号） */
  hitLimit: boolean;
  /** 服务原始 next 链接（若有） */
  nextUrl?: string;
}

export interface WfsPage {
  features: WfsFeature[];
  meta: WfsPageMeta;
}

export type ChunkState =
  | 'PENDING' // 尚未开始
  | 'RUNNING' // 正在采集
  | 'DONE_COMPLETE' // 已确认采全（含确认无数据的空块）
  | 'EMPTY_CONFIRMED' // 已确认无数据（首页即 0 条且总数为 0）
  | 'INCOMPLETE' // 命中上限且无可靠下一页：不能认为采全
  | 'FAILED' // 请求失败 / 轴顺序错误等
  | 'PAUSED'; // 被暂停（可继续）

export interface ChunkRecord {
  id: string;
  index: number;
  bbox: BBox;
  state: ChunkState;
  /** 已完成的页数 */
  pagesDone: number;
  /** 累计取回要素数（含跨块重复，未去重） */
  featuresFetched: number;
  /** 服务声明的匹配总数；拿不到时为 null */
  numberMatched: number | null;
  /** 失败/截断原因（人读） */
  message?: string;
  /** 最后一次错误码，用于“只重采失败区域”筛选 */
  errorCode?: string;
  attempts: number;
}

/** 同一稳定要素在不同分块/页中的一次“目击”记录 */
export interface FeatureObservation {
  chunkId: string;
  chunkIndex: number;
  page: number;
  version: number;
  /** 该次返回所属的服务地址，便于追溯 */
  endpoint: string;
  fetchedAt: string;
}

/** 合并后的最终要素（带完整来源链） */
export interface MergedFeature {
  feature: WfsFeature;
  stableId: string;
  selectedVersion: number;
  /** 版本选取依据 */
  selectionReason: string;
  observations: FeatureObservation[];
  /** 出现过的全部版本及各自来源（保留同一标识不同版本的来源信息） */
  versions: { version: number; sources: FeatureObservation[] }[];
  /** 是否与原始选区相交（最终导出只保留 true） */
  intersectsSelection: boolean;
}

export interface ServiceProfile {
  id: string;
  label: string;
  endpoint: string;
  typeNames: string[];
  /** 每页数量上限（客户端 count 参数） */
  pageSize: number;
  /** 预期轴顺序，用于与 GetCapabilities 声明做一致性校验 */
  expectedAxisOrder: AxisOrder;
  /** 演示用：故意发错轴顺序，触发服务异常 */
  forceWrongAxisOrder?: boolean;
  note?: string;
}
