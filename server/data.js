/**
 * 模拟 WFS 的确定性示例数据集（EPSG:3857，单位米）。
 * 区域：以 (13520000, 3640000) 为左下角的 20km × 14km 矩形。
 *
 * 特意构造的检查点：
 *  - 多条道路/设施面跨越 5km 分块边界，验证按稳定标识合并而非坐标比对；
 *  - 中部留一个“数据空洞”，任何分块查它都返回空，验证 EMPTY_CONFIRMED；
 *  - 密集点群 65 个、每页上限 50，坏端点在第 2 页丢失可靠分页信息，制造截断；
 *  - 同一要素在不同分块可能返回不同 version，验证版本保留与选取依据。
 */

export const DATASET_EXTENT = {
  minX: 13_520_000,
  minY: 3_640_000,
  maxX: 13_540_000,
  maxY: 3_654_000,
};

export const SRS_NAME = 'EPSG:3857';
export const DECLARED_AXIS_ORDER = 'xy';

/** 可复现的伪随机数（mulberry32） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lineBBox(coords) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of coords) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

function rectPolygon(minX, minY, maxX, maxY) {
  return {
    type: 'Polygon',
    coordinates: [[
      [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY],
    ]],
  };
}

export function buildRoads() {
  const { minX: x0, minY: y0, maxX: x1, maxY: y1 } = DATASET_EXTENT;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const defs = [
    // 横向主干道：贯穿整个选区，必然跨多个分块
    { code: 'RD-001', name: '滨海大道', coords: [[x0 - 1500, cy + 800], [x0 + 4000, cy + 600], [cx, cy + 900], [x1 - 3000, cy + 500], [x1 + 1200, cy + 700]] },
    { code: 'RD-002', name: '北环高架', coords: [[x0 - 800, y1 - 1800], [x0 + 6000, y1 - 2200], [x1 + 900, y1 - 1600]] },
    { code: 'RD-003', name: '南堤路', coords: [[x0 + 500, y0 + 1500], [cx - 1000, y0 + 1100], [cx + 3000, y0 + 1700], [x1 - 800, y0 + 1300]] },
    // 纵向道路
    { code: 'RD-004', name: '中央轴线', coords: [[cx, y0 - 900], [cx + 200, cy - 2000], [cx - 150, cy], [cx + 250, y1 + 800]] },
    { code: 'RD-005', name: '东港路', coords: [[x1 - 4000, y0 + 400], [x1 - 3700, cy], [x1 - 4200, y1 - 600]] },
    { code: 'RD-006', name: '西仓路', coords: [[x0 + 2500, y0 + 300], [x0 + 2800, cy + 1000], [x0 + 2300, y1 - 1200]] },
    // 斜向跨块路
    { code: 'RD-007', name: '斜塘支线', coords: [[x0 + 1200, y1 - 800], [cx - 2000, cy + 2000], [cx + 1500, cy - 1500], [x1 - 1500, y0 + 2200]] },
    { code: 'RD-008', name: '临港联络线', coords: [[x0 - 600, y0 + 4500], [x0 + 5000, cy + 300], [x1 + 700, y1 - 3500]] },
    // 短支路（部分落在数据空洞边缘，用来验证空块附近的边界判定）
    { code: 'RD-009', name: '仓北支路', coords: [[x0 + 7000, y0 + 5200], [x0 + 8800, y0 + 5600]] },
    { code: 'RD-010', name: '闸南路', coords: [[x1 - 6500, y1 - 5000], [x1 - 5200, y1 - 6200]] },
  ];
  return defs.map((d, i) => ({
    type: 'Feature',
    id: `road.${i + 1}`,
    geometry: { type: 'LineString', coordinates: d.coords },
    properties: {
      featureCode: d.code,
      name: d.name,
      kind: 'road',
      lanes: 2 + (i % 3) * 2,
      version: 3, // 基准版本；服务会按分块给出漂移
    },
    bbox: lineBBox(d.coords),
  }));
}

export function buildFacilities() {
  const { minX: x0, minY: y0, maxX: x1, maxY: y1 } = DATASET_EXTENT;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const defs = [
    // 压在纵向分块线上的厂区
    { code: 'FAC-001', name: '东港物流园', rect: [cx - 900, cy - 700, cx + 1100, cy + 800] },
    // 压在横向分块线上
    { code: 'FAC-002', name: '北桥枢纽站', rect: [x0 + 2000, y1 - 5400, x0 + 4200, y1 - 4100] },
    // 角落设施，验证选区边界裁剪
    { code: 'FAC-003', name: '西湾水厂', rect: [x0 - 600, y0 - 400, x0 + 1400, y0 + 1300] },
    { code: 'FAC-004', name: '南闸变电站', rect: [x1 - 3000, y0 - 500, x1 - 1200, y0 + 900] },
    // 跨四个分块交点的大设施
    { code: 'FAC-005', name: '中央保税区', rect: [cx - 1400, cy - 1200, cx + 1500, cy + 1300] },
  ];
  return defs.map((d, i) => ({
    type: 'Feature',
    id: `facility.${i + 1}`,
    geometry: rectPolygon(...d.rect),
    properties: {
      featureCode: d.code,
      name: d.name,
      kind: 'facility',
      areaTier: i % 2 === 0 ? 'A' : 'B',
      version: 2,
    },
    bbox: { minX: d.rect[0], minY: d.rect[1], maxX: d.rect[2], maxY: d.rect[3] },
  }));
}

export function buildPoiCluster() {
  const rand = mulberry32(20261114);
  // 密集点群集中在一个 2.2km × 1.8km 的小块内，确保单块就能超过 50 条/页
  const baseX = DATASET_EXTENT.minX + 12_500;
  const baseY = DATASET_EXTENT.minY + 9_800;
  const features = [];
  for (let i = 1; i <= 65; i++) {
    const x = baseX + rand() * 2200;
    const y = baseY + rand() * 1800;
    features.push({
      type: 'Feature',
      id: `poi.${i}`,
      geometry: { type: 'Point', coordinates: [Math.round(x * 100) / 100, Math.round(y * 100) / 100] },
      properties: {
        featureCode: `POI-${String(i).padStart(3, '0')}`,
        name: `监测点 ${i}`,
        kind: 'poi',
        category: ['井盖', '灯杆', '摄像头'][i % 3],
        version: 1,
      },
      bbox: { minX: x, minY: y, maxX: x, maxY: y },
    });
  }
  return features;
}

export function buildSparsePois() {
  // 散布点，放在数据空洞之外
  const { minX: x0, minY: y0 } = DATASET_EXTENT;
  const defs = [
    ['POI-101', x0 + 900, y0 + 900],
    ['POI-102', x0 + 3300, y0 + 7200],
    ['POI-103', x0 + 15800, y0 + 3300],
    ['POI-104', x0 + 17200, y0 + 11500],
    ['POI-105', x0 + 6200, y0 + 12600],
    ['POI-106', x0 + 11000, y0 + 2200],
  ];
  return defs.map(([code, x, y], i) => ({
    type: 'Feature',
    id: `spoi.${i + 1}`,
    geometry: { type: 'Point', coordinates: [x, y] },
    properties: { featureCode: code, name: `标志点 ${code}`, kind: 'poi', version: 1 },
    bbox: { minX: x, minY: y, maxX: x, maxY: y },
  }));
}

/**
 * 数据空洞：模块加载时自动扫描出的“保证无任何要素 bbox 与其相交”的矩形，
 * 比手工坐标更可靠——数据集调整后会自动换到新的空白位置。
 * 优先选完全落在某个 5km×7km 分块内部的较大盒子；找不到时逐步缩小并放宽
 * 网格约束，保证总能得到一个可演示 EMPTY_CONFIRMED 的空白区域。
 */
export const DATA_VOID = findDataVoid();

function findDataVoid() {
  const raw = [
    ...buildRoads(),
    ...buildFacilities(),
    ...buildPoiCluster(),
    ...buildSparsePois(),
  ];
  const inter = (a, b) =>
    !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);

  const sizeCandidates = [
    [900, 1000],
    [600, 700],
    [400, 500],
    [300, 300],
  ];
  // 两轮：先要求不跨 5km×7km 网格，再放宽
  for (const requireInsideGrid of [true, false]) {
    for (const [W, H] of sizeCandidates) {
      for (let y = DATASET_EXTENT.minY + 200; y + H < DATASET_EXTENT.maxY - 200; y += 100) {
        for (let x = DATASET_EXTENT.minX + 200; x + W < DATASET_EXTENT.maxX - 200; x += 100) {
          const box = { minX: x, minY: y, maxX: x + W, maxY: y + H };
          if (requireInsideGrid) {
            const gx = (x - DATASET_EXTENT.minX) % 5000;
            const gy = (y - DATASET_EXTENT.minY) % 7000;
            if (gx + W > 5000 || gy + H > 7000) continue;
          }
          if (!raw.some((f) => inter(f.bbox, box))) return box;
        }
      }
    }
  }
  throw new Error('找不到满足条件的数据空洞，请调整数据集或扫描参数');
}

export const TYPE_NAMES = {
  roads: 'demo:roads',
  facilities: 'demo:facilities',
  poi: 'demo:poi',
  all: 'demo:all',
};

function bboxesIntersect(a, b) {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

function pointInBBox(p, b) {
  return p[0] >= b.minX && p[0] <= b.maxX && p[1] >= b.minY && p[1] <= b.maxY;
}

function orient(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segmentsCross(a, b, c, d) {
  const o1 = orient(a, b, c), o2 = orient(a, b, d);
  const o3 = orient(c, d, a), o4 = orient(c, d, b);
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) &&
         ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
}

function segmentHitsBBox(a, b, box) {
  if (pointInBBox(a, box) || pointInBBox(b, box)) return true;
  const edges = [
    [[box.minX, box.minY], [box.maxX, box.minY]],
    [[box.maxX, box.minY], [box.maxX, box.maxY]],
    [[box.maxX, box.maxY], [box.minX, box.maxY]],
    [[box.minX, box.maxY], [box.minX, box.minY]],
  ];
  return edges.some(([c, d]) => segmentsCross(a, b, c, d));
}

/** 几何与空洞 bbox 是否相交（支持 Point/LineString/Polygon） */
function featureHitsVoid(feature) {
  const g = feature.geometry;
  if (!bboxesIntersect(feature.bbox, DATA_VOID)) return false;
  if (g.type === 'Point') return pointInBBox(g.coordinates, DATA_VOID);
  if (g.type === 'LineString') {
    return g.coordinates.some((p, i) =>
      i === 0 ? pointInBBox(p, DATA_VOID) : segmentHitsBBox(g.coordinates[i - 1], p, DATA_VOID));
  }
  if (g.type === 'Polygon') {
    const ring = g.coordinates[0];
    if (ring.some((p) => pointInBBox(p, DATA_VOID))) return true;
    // 空洞角点落在多边形内（面完全包住空洞的情形）
    const inside = (p) => {
      let hit = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
        const cross = (yi > p[1]) !== (yj > p[1]) &&
          p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi;
        if (cross) hit = !hit;
      }
      return hit;
    };
    const corners = [
      [DATA_VOID.minX, DATA_VOID.minY], [DATA_VOID.maxX, DATA_VOID.minY],
      [DATA_VOID.maxX, DATA_VOID.maxY], [DATA_VOID.minX, DATA_VOID.maxY],
    ];
    if (corners.some(inside)) return true;
    return ring.some((p, i) =>
      i === 0 ? pointInBBox(p, DATA_VOID) : segmentHitsBBox(ring[i - 1], p, DATA_VOID));
  }
  return false;
}

export function buildDataset() {
  const roads = buildRoads().filter((f) => !featureHitsVoid(f));
  const facilities = buildFacilities().filter((f) => !featureHitsVoid(f));
  const cluster = buildPoiCluster().filter((f) => !featureHitsVoid(f));
  const sparse = buildSparsePois().filter((f) => !featureHitsVoid(f));
  const all = [...roads, ...facilities, ...cluster, ...sparse];

  // DATA_VOID 由 findDataVoid 保证 bbox 级无交集；这里再做一次几何过滤+断言兜底，
  // 防止后续维护把扫描逻辑改坏而“空块”演示悄悄失效。
  const intruders = all.filter((f) => bboxesIntersect(f.bbox, DATA_VOID));
  if (intruders.length > 0) {
    throw new Error(
      `DATA_VOID 被要素侵入：${intruders.map((f) => f.properties.featureCode).join(', ')}`,
    );
  }

  return {
    [TYPE_NAMES.roads]: roads,
    [TYPE_NAMES.facilities]: facilities,
    [TYPE_NAMES.poi]: [...cluster, ...sparse],
    [TYPE_NAMES.all]: all,
  };
}
