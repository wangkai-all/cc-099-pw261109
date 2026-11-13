import type { BBox, GeoGeometry, Position } from '@/types';

/** 几何遍历：把任意 GeoJSON 几何拆成若干线性环（点/线按退化环处理），统一做相交判断 */
type Ring = Position[];

function collectRings(geom: GeoGeometry): Ring[] {
  const c = geom.coordinates;
  switch (geom.type) {
    case 'Point':
      return [[c as Position, c as Position]];
    case 'MultiPoint':
      return (c as Position[]).map((p) => [p, p]);
    case 'LineString':
      return [c as Position[]];
    case 'MultiLineString':
      return c as Position[][];
    case 'Polygon':
      return c as Position[][];
    case 'MultiPolygon':
      return (c as Position[][][]).flat();
    default:
      return [];
  }
}

export function bboxOfGeometry(geom: GeoGeometry): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of collectRings(geom)) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

export function bboxesIntersect(a: BBox, b: BBox): boolean {
  return !(
    a.maxX < b.minX ||
    a.minX > b.maxX ||
    a.maxY < b.minY ||
    a.minY > b.maxY
  );
}

/** 点在 bbox 内（边界算相交） */
export function pointInBBox(p: Position, b: BBox): boolean {
  return p[0] >= b.minX && p[0] <= b.maxX && p[1] >= b.minY && p[1] <= b.maxY;
}

/** 线段与 bbox 是否相交（Cohen–Sutherland 裁剪思路的简化版：端点在内或穿越任一边） */
function segmentIntersectsBBox(a: Position, b: Position, box: BBox): boolean {
  if (pointInBBox(a, box) || pointInBBox(b, box)) return true;
  const edges: [Position, Position][] = [
    [[box.minX, box.minY], [box.maxX, box.minY]],
    [[box.maxX, box.minY], [box.maxX, box.maxY]],
    [[box.maxX, box.maxY], [box.minX, box.maxY]],
    [[box.minX, box.maxY], [box.minX, box.minY]],
  ];
  return edges.some(([c, d]) => segmentsCross(a, b, c, d));
}

function orient(a: Position, b: Position, c: Position): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segmentsCross(a: Position, b: Position, c: Position, d: Position): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return (
    ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) &&
    ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))
  );
}

/**
 * 几何与矩形选区是否相交。
 * 对 Polygon 取外环 + 内环统一处理；对 LineString 逐段判断；Point 直接判断。
 * 边界接触（touch）按相交处理，符合“与原始选区相交”的采集语义。
 */
export function geometryIntersectsBBox(geom: GeoGeometry, box: BBox): boolean {
  const gb = bboxOfGeometry(geom);
  if (!bboxesIntersect(gb, box)) return false;

  switch (geom.type) {
    case 'Point':
    case 'MultiPoint': {
      return collectRings(geom).some((r) => pointInBBox(r[0], box));
    }
    case 'LineString':
    case 'MultiLineString': {
      return collectRings(geom).some((ring) =>
        ring.some((p, i) => {
          if (i === 0) return pointInBBox(p, box);
          return segmentIntersectsBBox(ring[i - 1], p, box);
        }),
      );
    }
    case 'Polygon':
    case 'MultiPolygon': {
      // 外环相交即相交；若所有顶点在框内也算
      const rings = collectRings(geom);
      // 任一顶点落在框内
      if (rings.some((r) => r.some((p) => pointInBBox(p, box)))) return true;
      // 框的任一角落落在多边形内（说明框穿过面）
      const corners: Position[] = [
        [box.minX, box.minY],
        [box.maxX, box.minY],
        [box.maxX, box.maxY],
        [box.minX, box.maxY],
      ];
      if (corners.some((p) => rings.some((r) => pointInPolygon(p, r)))) return true;
      // 边相交
      return rings.some((r) =>
        r.some((p, i) => {
          if (i === 0) return false;
          return segmentIntersectsBBox(r[i - 1], p, box);
        }),
      );
    }
    default:
      return false;
  }
}

function pointInPolygon(p: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > p[1] !== yj > p[1] &&
      p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
