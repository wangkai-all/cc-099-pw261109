import { describe, expect, it } from 'vitest';
import { filterBySelection } from '@/lib/filter';
import { featuresToGeoJSON, chunksToGeoJSON } from '@/lib/export';
import type { BBox, ChunkRecord, MergedFeature, WfsFeature } from '@/types';

const selection: BBox = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

const mkFeature = (code: string, coords: number[][]): MergedFeature => {
  const f: WfsFeature = {
    type: 'Feature',
    id: code,
    geometry: { type: 'LineString', coordinates: coords },
    properties: { featureCode: code, version: 1, name: code },
  };
  return {
    feature: f,
    stableId: code,
    selectedVersion: 1,
    selectionReason: 'test',
    observations: [],
    versions: [{ version: 1, sources: [] }],
    intersectsSelection: false,
  };
};

describe('filterBySelection', () => {
  it('只保留与原始选区几何相交的要素，剔除 bbox 相交但几何绕过者', () => {
    const crossing = mkFeature('RD-IN', [
      [-10, 50],
      [110, 50],
    ]);
    // bbox 与选区相交（x=101 贴边），但整条线在选区右侧外面
    const bypass = mkFeature('RD-OUT', [
      [101, 0],
      [101, 200],
    ]);
    const { kept, dropped } = filterBySelection([crossing, bypass], selection);
    expect(kept.map((m) => m.stableId)).toEqual(['RD-IN']);
    expect(dropped.map((m) => m.stableId)).toEqual(['RD-OUT']);
    expect(kept[0].intersectsSelection).toBe(true);
  });

  it('边界接触的点保留', () => {
    const edge = mkFeature('P-EDGE', [[100, 50]]);
    edge.feature.geometry = { type: 'Point', coordinates: [100, 50] };
    const { kept } = filterBySelection([edge], selection);
    expect(kept).toHaveLength(1);
  });
});

describe('GeoJSON 导出', () => {
  it('要素导出为标准 FeatureCollection 且带来源链', () => {
    const m = mkFeature('RD-1', [[0, 0], [10, 10]]);
    const geo = featuresToGeoJSON([m]);
    expect(geo.type).toBe('FeatureCollection');
    expect(geo.features).toHaveLength(1);
    const f = geo.features[0] as {
      id: string;
      properties: { stableId: string; selectedVersion: number; observations: unknown[] };
    };
    expect(f.id).toBe('RD-1');
    expect(f.properties.stableId).toBe('RD-1');
    expect(f.properties.selectedVersion).toBe(1);
    expect(Array.isArray(f.properties.observations)).toBe(true);
  });

  it('分块状态导出为 Polygon 要素，保留状态语义', () => {
    const ch: ChunkRecord = {
      id: 'chunk-0-0',
      index: 0,
      bbox: selection,
      state: 'EMPTY_CONFIRMED',
      pagesDone: 1,
      featuresFetched: 0,
      numberMatched: 0,
      attempts: 1,
      message: '服务确认该范围内无要素',
    };
    const geo = chunksToGeoJSON([ch]);
    const f = geo.features[0] as {
      geometry: { type: string };
      properties: { state: string };
    };
    expect(f.geometry.type).toBe('Polygon');
    expect(f.properties.state).toBe('EMPTY_CONFIRMED');
  });
});
