import { describe, expect, it } from 'vitest';
import { planChunks, retryableChunks, summarizeStates } from '@/lib/chunking';
import type { BBox, ChunkRecord } from '@/types';

const selection: BBox = { minX: 0, minY: 0, maxX: 1000, maxY: 700 };

describe('planChunks', () => {
  it('按目标尺寸切网格并覆盖整个选区', () => {
    const plan = planChunks(selection, 500, 350);
    expect(plan.cols).toBe(2);
    expect(plan.rows).toBe(2);
    expect(plan.chunks).toHaveLength(4);

    const union = plan.chunks.reduce(
      (acc, ch) => ({
        minX: Math.min(acc.minX, ch.bbox.minX),
        minY: Math.min(acc.minY, ch.bbox.minY),
        maxX: Math.max(acc.maxX, ch.bbox.maxX),
        maxY: Math.max(acc.maxY, ch.bbox.maxY),
      }),
      { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
    );
    expect(union).toEqual(selection);
  });

  it('不能整除时边缘块吸收余数，不产生零宽块', () => {
    const plan = planChunks(selection, 300, 300);
    expect(plan.cols).toBe(4);
    expect(plan.rows).toBe(3);
    for (const ch of plan.chunks) {
      expect(ch.bbox.maxX).toBeGreaterThan(ch.bbox.minX);
      expect(ch.bbox.maxY).toBeGreaterThan(ch.bbox.minY);
    }
  });

  it('选区小于一块时仍返回单块', () => {
    const plan = planChunks(selection, 5000, 5000);
    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0].bbox).toEqual(selection);
  });

  it('非法参数抛错', () => {
    expect(() => planChunks({ ...selection, maxX: 0 }, 100, 100)).toThrow();
    expect(() => planChunks(selection, 0, 100)).toThrow();
  });
});

describe('状态汇总与重采筛选', () => {
  const mk = (state: ChunkRecord['state']): ChunkRecord => ({
    id: `c-${state}`,
    index: 0,
    bbox: selection,
    state,
    pagesDone: 0,
    featuresFetched: 0,
    numberMatched: null,
    attempts: 0,
  });

  it('summarizeStates 计数', () => {
    const chunks = [mk('DONE_COMPLETE'), mk('DONE_COMPLETE'), mk('FAILED'), mk('INCOMPLETE')];
    expect(summarizeStates(chunks)).toMatchObject({
      DONE_COMPLETE: 2,
      FAILED: 1,
      INCOMPLETE: 1,
    });
  });

  it('retryableChunks 只挑失败和截断块', () => {
    const chunks = [
      mk('DONE_COMPLETE'),
      mk('EMPTY_CONFIRMED'),
      mk('FAILED'),
      mk('INCOMPLETE'),
      mk('PENDING'),
    ];
    expect(retryableChunks(chunks).map((c) => c.state).sort()).toEqual([
      'FAILED',
      'INCOMPLETE',
    ]);
  });
});
