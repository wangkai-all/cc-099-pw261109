import { describe, expect, it } from 'vitest';
import {
  assertAxisConsistency,
  AxisOrderError,
  formatBbox,
  parseCapabilities,
} from '@/lib/axisOrder';
import type { BBox } from '@/types';

const box: BBox = { minX: 100, minY: 200, maxX: 300, maxY: 400 };

describe('formatBbox', () => {
  it('xy 与 yx 产生不同参数顺序', () => {
    expect(formatBbox(box, 'xy')).toBe('100,200,300,400');
    expect(formatBbox(box, 'yx')).toBe('200,100,400,300');
  });
});

describe('parseCapabilities', () => {
  const xml = `<?xml version="1.0"?>
    <WFS_Capabilities>
      <FeatureType><Name>demo:all</Name>
      <DefaultCRS>urn:ogc:def:crs:EPSG::3857</DefaultCRS>
      <AxisOrder>xy</AxisOrder></FeatureType>
    </WFS_Capabilities>`;

  it('解析 CRS 与声明轴顺序', () => {
    const { crs } = parseCapabilities(xml);
    expect(crs).toEqual({ srsName: 'EPSG:3857', axisOrder: 'xy' });
  });

  it('缺少声明时返回 null', () => {
    expect(parseCapabilities('<WFS_Capabilities/>').crs).toBeNull();
  });

  it('4326 无显式 AxisOrder 时按 OGC 约定回退 yx', () => {
    const { crs } = parseCapabilities(
      '<WFS_Capabilities><DefaultCRS>EPSG:4326</DefaultCRS></WFS_Capabilities>',
    );
    expect(crs?.axisOrder).toBe('yx');
  });
});

describe('assertAxisConsistency', () => {
  const crs = { srsName: 'EPSG:3857', axisOrder: 'xy' as const };

  it('一致时通过', () => {
    expect(() =>
      assertAxisConsistency({ crs, requestAxisOrder: 'xy', profileExpected: 'xy' }),
    ).not.toThrow();
  });

  it('请求轴顺序与声明不一致时抛 AxisOrderError，不允许静默交换', () => {
    try {
      assertAxisConsistency({ crs, requestAxisOrder: 'yx', profileExpected: 'xy' });
      throw new Error('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(AxisOrderError);
      expect((err as AxisOrderError).detail).toEqual({
        declared: 'xy',
        used: 'yx',
        srsName: 'EPSG:3857',
      });
    }
  });

  it('profile 预期与能力文档声明冲突同样拒绝', () => {
    expect(() =>
      assertAxisConsistency({ crs, requestAxisOrder: 'xy', profileExpected: 'yx' }),
    ).toThrow(AxisOrderError);
  });

  it('forceWrong 演示开关直接触发错误', () => {
    expect(() =>
      assertAxisConsistency({
        crs,
        requestAxisOrder: 'xy',
        profileExpected: 'xy',
        forceWrong: true,
      }),
    ).toThrow(AxisOrderError);
  });
});
