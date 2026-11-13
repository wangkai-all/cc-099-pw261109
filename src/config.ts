import type { ServiceProfile } from '@/types';

/**
 * 项目附带的本地 WFS 示例服务 profile。
 * 通过 Vite 代理（/wfs → 127.0.0.1:8787）访问，前端无需关心端口。
 */
export const SERVICE_PROFILES: ServiceProfile[] = [
  {
    id: 'standard',
    label: '标准服务（分页可靠）',
    endpoint: '/wfs/standard',
    typeNames: ['demo:all'],
    pageSize: 50,
    expectedAxisOrder: 'xy',
    note: 'GetCapabilities 声明 EPSG:3857 / xy，numberMatched 与 next 链接完整。',
  },
  {
    id: 'brokenPaging',
    label: '坏分页服务（触发截断判定）',
    endpoint: '/wfs/brokenPaging',
    typeNames: ['demo:all'],
    pageSize: 50,
    expectedAxisOrder: 'xy',
    note: '密集点群查询命中上限后不再提供总数和 next 链接，必须判为未采全。',
  },
  {
    id: 'axisFault',
    label: '严格轴顺序服务',
    endpoint: '/wfs/axisFault',
    typeNames: ['demo:all'],
    pageSize: 50,
    expectedAxisOrder: 'xy',
    note: '服务端严格校验轴顺序；勾选“故意发错轴顺序”可复现明确的轴顺序错误。',
  },
];

/** 演示数据集范围（EPSG:3857），用于地图初始定位 */
export const DEMO_CENTER: [number, number] = [13_530_000, 3_647_000];
export const DEMO_EXTENT = {
  minX: 13_520_000,
  minY: 3_640_000,
  maxX: 13_540_000,
  maxY: 3_654_000,
};

/** 分块尺寸可选项（米）。小网格能演示空块，大网格减少请求数 */
export const CHUNK_SIZE_OPTIONS = [
  { label: '2.5 km（小块，可出现空块）', width: 2500, height: 2500 },
  { label: '5 km（默认）', width: 5000, height: 3500 },
  { label: '10 km（大块）', width: 10_000, height: 7000 },
];
