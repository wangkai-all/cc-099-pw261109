import { describe, expect, it } from 'vitest';
import { assessPageCompleteness, FeatureMerger, stableIdOf } from '@/lib/merge';
import type { FeatureObservation, WfsFeature, WfsPageMeta } from '@/types';

const obs = (chunkIndex: number, version: number, page = 1): FeatureObservation => ({
  chunkId: `chunk-0-${chunkIndex}`,
  chunkIndex,
  page,
  version,
  endpoint: '/wfs/standard',
  fetchedAt: new Date(2026, 10, 14, 10, chunkIndex).toISOString(),
});

const feature = (code: string, version: number): WfsFeature => ({
  type: 'Feature',
  id: `id-${code}`,
  geometry: { type: 'Point', coordinates: [chunkIndexToX(code), 1] },
  properties: { featureCode: code, version, name: code },
});

function chunkIndexToX(code: string): number {
  return code.charCodeAt(0);
}

describe('stableIdOf', () => {
  it('优先 featureCode，回退 id', () => {
    expect(stableIdOf(feature('RD-1', 1))).toBe('RD-1');
    expect(
      stableIdOf({
        type: 'Feature',
        id: 'raw-id',
        geometry: { type: 'Point', coordinates: [0, 0] },
        properties: {},
      }),
    ).toBe('raw-id');
  });
});

describe('FeatureMerger 版本合并', () => {
  it('同一稳定标识跨分块重复返回时合并为一条，且不依赖坐标', () => {
    const merger = new FeatureMerger();
    // 两次返回坐标故意不同，仍必须按 featureCode 合并
    const a = feature('RD-9', 3);
    const b: WfsFeature = {
      ...feature('RD-9', 3),
      geometry: { type: 'Point', coordinates: [999, 999] },
    };
    merger.add({ feature: a, observation: obs(0, 3) });
    merger.add({ feature: b, observation: obs(1, 3) });
    const results = merger.results();
    expect(results).toHaveLength(1);
    expect(results[0].observations).toHaveLength(2);
    expect(results[0].versions).toHaveLength(1);
  });

  it('同标识不同版本：保留全部版本来源，代表要素取最高版本并写明依据', () => {
    const merger = new FeatureMerger();
    merger.add({ feature: feature('FAC-1', 2), observation: obs(0, 2) });
    merger.add({ feature: feature('FAC-1', 4), observation: obs(1, 4) });
    merger.add({ feature: feature('FAC-1', 3), observation: obs(2, 3) });

    const [m] = merger.results();
    expect(m.selectedVersion).toBe(4);
    expect(m.versions.map((v) => v.version)).toEqual([2, 3, 4]);
    expect(m.versions.find((v) => v.version === 4)?.sources).toHaveLength(1);
    expect(m.selectionReason).toContain('最高版本号');
    expect(m.observations).toHaveLength(3);
  });

  it('不同标识互不合并', () => {
    const merger = new FeatureMerger();
    merger.add({ feature: feature('A', 1), observation: obs(0, 1) });
    merger.add({ feature: feature('B', 1), observation: obs(1, 1) });
    expect(merger.results()).toHaveLength(2);
  });

  it('观测记录按分块与页排序，保证来源链确定可读', () => {
    const merger = new FeatureMerger();
    merger.add({ feature: feature('X', 1), observation: obs(2, 1, 3) });
    merger.add({ feature: feature('X', 1), observation: obs(0, 1, 1) });
    const [m] = merger.results();
    expect(m.observations.map((o) => o.chunkIndex)).toEqual([0, 2]);
  });
});

describe('assessPageCompleteness 截断判定', () => {
  const base: WfsPageMeta = {
    numberMatched: 120,
    numberReturned: 50,
    nextIndex: 50,
    nextUrl: undefined,
    hitLimit: true,
  };

  it('未命中上限即视为采完', () => {
    expect(assessPageCompleteness({ ...base, hitLimit: false }).complete).toBe(true);
  });

  it('命中上限但有 next 链接：未采完但可继续', () => {
    const r = assessPageCompleteness({ ...base, nextUrl: '/wfs?startIndex=50' });
    expect(r.complete).toBe(false);
    expect(r.reason).toContain('next 链接');
  });

  it('命中上限、nextIndex 小于已知总数：可继续翻页', () => {
    expect(assessPageCompleteness(base).complete).toBe(false);
  });

  it('命中上限且总数未知、无 next：必须判未采全（核心安全规则）', () => {
    const r = assessPageCompleteness({
      ...base,
      numberMatched: null,
      nextIndex: null,
    });
    expect(r.complete).toBe(false);
    expect(r.reason).toContain('无法确认');
  });

  it('命中上限但 nextIndex 已不小于总数：分页自相矛盾，仍判未采全', () => {
    const r = assessPageCompleteness({ ...base, nextIndex: 120 });
    expect(r.complete).toBe(false);
    expect(r.reason).toContain('自相矛盾');
  });
});
