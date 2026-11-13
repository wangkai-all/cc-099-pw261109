import { describe, expect, it } from 'vitest';
import {
  bboxOfGeometry,
  bboxesIntersect,
  geometryIntersectsBBox,
} from '@/lib/geometry';
import type { BBox, GeoGeometry } from '@/types';

const box: BBox = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

describe('bboxesIntersect', () => {
  it('识别包含、相交与相离', () => {
    expect(bboxesIntersect(box, { minX: 10, minY: 10, maxX: 20, maxY: 20 })).toBe(true);
    expect(bboxesIntersect(box, { minX: 90, minY: 90, maxX: 120, maxY: 120 })).toBe(true);
    expect(bboxesIntersect(box, { minX: 101, minY: 0, maxX: 200, maxY: 100 })).toBe(false);
  });

  it('边界接触按相交处理', () => {
    expect(bboxesIntersect(box, { minX: 100, minY: 0, maxX: 110, maxY: 100 })).toBe(true);
  });
});

describe('geometryIntersectsBBox', () => {
  it('点：内/外/边界', () => {
    const inside: GeoGeometry = { type: 'Point', coordinates: [50, 50] };
    const outside: GeoGeometry = { type: 'Point', coordinates: [200, 200] };
    const edge: GeoGeometry = { type: 'Point', coordinates: [100, 50] };
    expect(geometryIntersectsBBox(inside, box)).toBe(true);
    expect(geometryIntersectsBBox(outside, box)).toBe(false);
    expect(geometryIntersectsBBox(edge, box)).toBe(true);
  });

  it('线：bbox 相交但几何只是从旁绕过（关键反例）', () => {
    // 线段两端都在框外右侧，几何 bbox 与框相交但线段本身不穿过
    const miss: GeoGeometry = {
      type: 'LineString',
      coordinates: [
        [101, 0],
        [101, 200],
      ],
    };
    expect(geometryIntersectsBBox(miss, box)).toBe(false);

    const cross: GeoGeometry = {
      type: 'LineString',
      coordinates: [
        [-10, 50],
        [110, 50],
      ],
    };
    expect(geometryIntersectsBBox(cross, box)).toBe(true);
  });

  it('面：框完全在面内部也算相交', () => {
    const big: GeoGeometry = {
      type: 'Polygon',
      coordinates: [
        [
          [-50, -50],
          [150, -50],
          [150, 150],
          [-50, 150],
          [-50, -50],
        ],
      ],
    };
    expect(geometryIntersectsBBox(big, box)).toBe(true);
  });

  it('面：只在框上方掠过、不相交', () => {
    const above: GeoGeometry = {
      type: 'Polygon',
      coordinates: [
        [
          [10, 101],
          [90, 101],
          [90, 140],
          [10, 140],
          [10, 101],
        ],
      ],
    };
    expect(geometryIntersectsBBox(above, box)).toBe(false);
  });

  it('bboxOfGeometry 覆盖多类型', () => {
    const line: GeoGeometry = {
      type: 'MultiLineString',
      coordinates: [
        [
          [1, 2],
          [9, 8],
        ],
        [
          [3, -4],
        ],
      ],
    };
    expect(bboxOfGeometry(line)).toEqual({ minX: 1, minY: -4, maxX: 9, maxY: 8 });
  });
});
