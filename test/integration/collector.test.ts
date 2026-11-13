// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { CollectionEngine } from '@/lib/collector';
import { WfsClient } from '@/lib/wfsClient';
import { FeatureMerger } from '@/lib/merge';
import { planChunks } from '@/lib/chunking';
import { filterBySelection } from '@/lib/filter';
import type { CrsInfo, ServiceProfile } from '@/types';

const BASE = process.env.WFS_BASE ?? 'http://127.0.0.1:8787';
const EXTENT = { minX: 13520000, minY: 3640000, maxX: 13540000, maxY: 3654000 };
const CRS: CrsInfo = { srsName: 'EPSG:3857', axisOrder: 'xy' };

const profile = (mode: string, extra: Partial<ServiceProfile> = {}): ServiceProfile => ({
  id: mode,
  label: mode,
  endpoint: `${BASE}/wfs/${mode}`,
  typeNames: ['demo:all'],
  pageSize: 50,
  expectedAxisOrder: 'xy',
  ...extra,
});

let serverUp = false;

beforeAll(async () => {
  try {
    const res = await fetch(`${BASE}/wfs/standard?request=GetCapabilities`);
    serverUp = res.ok;
  } catch {
    serverUp = false;
  }
}, 10000);

// 每个用例在运行时检查服务可用性（不能用 describe.skipIf：它在收集期求值，早于 beforeAll）
const requireServer = (): void => {
  if (!serverUp) throw new Error(`本地 WFS 未就绪（${BASE}），请先运行 npm run server`);
};

describe('采集引擎端到端（真实本地 WFS）', () => {
  it('标准服务：全选区分块采全，跨块要素按稳定标识合并，且保留多版本来源', async () => {
    requireServer();
    const chunks = planChunks(EXTENT, 5000, 3500).chunks;
    const merger = new FeatureMerger();
    const engine = new CollectionEngine();
    const statesSeen = new Set<string>();
    await engine.run({
      chunks,
      client: new WfsClient(),
      profile: profile('standard'),
      crs: CRS,
      concurrency: 2,
      merger,
      events: { onChunkChange: (c) => statesSeen.add(c.state) },
    });

    const counts = countStates(chunks);
    // 无失败、无截断。粗网格下每块都含其它要素，空块由专门的空洞用例验证。
    expect(counts.FAILED ?? 0).toBe(0);
    expect(counts.INCOMPLETE ?? 0).toBe(0);

    const { kept } = filterBySelection(merger.results(), EXTENT);

    // 跨块道路 RD-001 一定被多个分块返回，但最终只有一条
    const rd1 = kept.find((m) => m.stableId === 'RD-001');
    expect(rd1).toBeTruthy();
    expect(rd1!.observations.length).toBeGreaterThan(1);
    expect(rd1!.versions.length).toBeGreaterThan(1);
    expect(rd1!.selectionReason).toContain('最高版本号');
    // 合并后稳定标识全局唯一
    expect(new Set(kept.map((m) => m.stableId)).size).toBe(kept.length);
  });

  it('坏分页服务：密集块命中上限且无可靠下一页时标记 INCOMPLETE，绝不判采全', async () => {
    requireServer();
    const dense = { minX: 13532000, minY: 3649000, maxX: 13538000, maxY: 3653000 };
    const chunks = planChunks(dense, 10000, 10000).chunks; // 单块
    const engine = new CollectionEngine();
    await engine.run({
      chunks,
      client: new WfsClient(),
      profile: profile('brokenPaging'),
      crs: CRS,
      merger: new FeatureMerger(),
    });
    expect(chunks[0].state).toBe('INCOMPLETE');
    expect(chunks[0].errorCode).toBe('TRUNCATED');
    expect(chunks[0].message).toContain('无法确认');
  });

  it('轴顺序不一致：forceWrong 触发 AXIS_ORDER_MISMATCH，块失败且不产生静默交换', async () => {
    requireServer();
    const chunks = planChunks(EXTENT, 10000, 10000).chunks;
    const engine = new CollectionEngine();
    await engine.run({
      chunks,
      client: new WfsClient(),
      profile: profile('axisFault', { forceWrongAxisOrder: true }),
      crs: CRS,
      merger: new FeatureMerger(),
    });
    expect(chunks.every((c) => c.state === 'FAILED')).toBe(true);
    expect(chunks[0].errorCode).toBe('AXIS_ORDER_MISMATCH');
    // 错误信息明确指出声明轴顺序与请求轴顺序
    expect(chunks[0].message).toContain('轴顺序');
  });

  it('数据空洞所在块返回 EMPTY_CONFIRMED，与“未采到”状态明确区分', async () => {
    requireServer();
    const { DATA_VOID } = await import('../../server/data.js');
    const chunks = planChunks(DATA_VOID, 5000, 5000).chunks;
    const engine = new CollectionEngine();
    await engine.run({
      chunks,
      client: new WfsClient(),
      profile: profile('standard'),
      crs: CRS,
      merger: new FeatureMerger(),
    });
    expect(chunks[0].state).toBe('EMPTY_CONFIRMED');
    expect(chunks[0].pagesDone).toBe(1);
    expect(chunks[0].featuresFetched).toBe(0);
  });

  it('暂停后继续：门控暂停出现 PAUSED 块，恢复后完整跑完，不丢块', async () => {
    requireServer();
    const chunks = planChunks(EXTENT, 2500, 2500).chunks; // 块多，便于在中途暂停
    const engine = new CollectionEngine();
    const runP = engine.run({
      chunks,
      client: new WfsClient(),
      profile: profile('standard'),
      crs: CRS,
      concurrency: 1,
      merger: new FeatureMerger(),
    });

    // 等至少一块进入运行，再暂停
    await waitUntil(() => chunks.some((c) => c.state === 'RUNNING' || c.state === 'DONE_COMPLETE'));
    engine.pause();
    await waitUntil(() => engine.isPaused);
    await waitUntil(() => chunks.some((c) => c.state === 'PAUSED'));
    expect(engine.isPaused).toBe(true);

    // 暂停期间 run 的 Promise 不应结算
    let settled = false;
    void runP.then(() => { settled = true; });
    requireServer();
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false);

    engine.resume();
    await runP;
    const counts = countStates(chunks);
    expect(counts.FAILED ?? 0).toBe(0);
    // 所有块都到达终态
    const terminal = ['DONE_COMPLETE', 'EMPTY_CONFIRMED'];
    expect(chunks.every((c) => terminal.includes(c.state))).toBe(true);
  });

  it('只重采失败/截断块：复用 merger，补齐后既有要素与来源链不丢失', async () => {
    requireServer();
    // 先用坏分页跑密集区域，制造 INCOMPLETE
    const dense = { minX: 13532000, minY: 3649000, maxX: 13538000, maxY: 3653000 };
    const chunks = planChunks(dense, 10000, 10000).chunks;
    const merger = new FeatureMerger();
    const bad = new CollectionEngine();
    await bad.run({
      chunks,
      client: new WfsClient(),
      profile: profile('brokenPaging'),
      crs: CRS,
      merger,
    });
    expect(chunks[0].state).toBe('INCOMPLETE');
    const partialCount = merger.size;
    expect(partialCount).toBeGreaterThan(0);

    // 换标准端点只重采这一块，复用同一 merger
    const good = new CollectionEngine();
    await good.run({
      chunks: chunks.filter((c) => c.state === 'INCOMPLETE'),
      client: new WfsClient(),
      profile: profile('standard'),
      crs: CRS,
      merger,
    });
    expect(chunks[0].state).toBe('DONE_COMPLETE');
    // 重采后要素数不少于截断时，且无重复标识
    const results = merger.results();
    expect(results.length).toBeGreaterThanOrEqual(partialCount);
    expect(new Set(results.map((m) => m.stableId)).size).toBe(results.length);
  });
});

function countStates(chunks: { state: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of chunks) out[c.state] = (out[c.state] ?? 0) + 1;
  return out;
}

async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}
