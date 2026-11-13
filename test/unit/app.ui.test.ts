// @vitest-environment jsdom
/**
 * UI 冒烟测试：在 jsdom 中用真实 DOM + fetch 桩驱动 app.ts，
 * 验证控件初始化、框选、采集编排到列表/统计/详情渲染的接线。
 * 地图真实渲染依赖浏览器布局，jsdom 下 Leaflet 可初始化但不做像素断言；
 * 完整像素级验证由 test/browser/e2e.ui.mjs 在带浏览器的环境执行。
 *
 * 这些用例共享同一个 app 实例、按真实用户操作顺序串成一条流程，
 * 避免 jsdom 下重复挂载地图产生的 Canvas/rAF 跨测试副作用。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');

function mountDom(): void {
  document.documentElement.innerHTML = html
    .replace(/<head>[\s\S]*?<\/head>/, '<head></head>')
    .replace(/<script[\s\S]*?<\/script>/, '');
  const mapDiv = document.getElementById('map')!;
  mapDiv.getBoundingClientRect = () =>
    ({ width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600 }) as DOMRect;
  // jsdom 未实现 canvas 2d context。用 Proxy 让任意方法/属性访问都得到 noop，
  // 一次性兜底 Leaflet Canvas 渲染器会用到的全部 context API（含未来新增调用）。
  HTMLCanvasElement.prototype.getContext = vi.fn(
    () =>
      new Proxy(
        { canvas: { width: 800, height: 600 } },
        {
          get(target, prop) {
            if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
            if (prop === 'createRadialGradient' || prop === 'createLinearGradient') {
              return () => ({ addColorStop: vi.fn() });
            }
            return vi.fn();
          },
        },
      ) as unknown as CanvasRenderingContext2D,
  );
}

function stubFetch(mode: 'standard' | 'axisFault'): void {
  const caps = `<?xml version="1.0"?>
    <WFS_Capabilities><FeatureType><DefaultCRS>urn:ogc:def:crs:EPSG::3857</DefaultCRS>
    <AxisOrder>xy</AxisOrder></FeatureType></WFS_Capabilities>`;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('GetCapabilities')) {
        return new Response(caps, {
          status: 200,
          headers: { 'Content-Type': 'application/xml' },
        });
      }
      if (mode === 'axisFault') {
        return new Response(
          '<ows:ExceptionReport><ows:Exception exceptionCode="AXIS_ORDER_MISMATCH">' +
            '<ows:ExceptionText>轴顺序不一致</ows:ExceptionText></ows:Exception></ows:ExceptionReport>',
          { status: 400 },
        );
      }
      const bboxMatch = url.match(/bbox=([^&]+)/);
      const bbox = decodeURIComponent(bboxMatch?.[1] ?? '').split(',').map(Number);
      const features = [
        {
          type: 'Feature',
          id: 'road.1',
          geometry: {
            type: 'LineString',
            coordinates: [
              [bbox[0], bbox[1]],
              [bbox[2], bbox[3]],
            ],
          },
          properties: { featureCode: 'RD-001', name: '滨海大道', kind: 'road', version: 3 },
        },
        {
          type: 'Feature',
          id: 'fac.1',
          geometry: {
            type: 'Point',
            coordinates: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
          },
          properties: { featureCode: 'FAC-001', name: '枢纽站', kind: 'facility', version: 2 },
        },
      ];
      return new Response(
        JSON.stringify({
          type: 'FeatureCollection',
          numberMatched: 2,
          numberReturned: features.length,
          next: null,
          features,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }),
  );
}

describe('应用 UI 冒烟（jsdom，单实例顺序流程）', () => {
  beforeAll(async () => {
    mountDom();
    stubFetch('standard');
    await import('@/app');
    await Promise.resolve();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    // 默认回到标准桩；轴错误用例会临时切换
    if ((globalThis.fetch as ReturnType<typeof vi.fn>)?.mock) {
      stubFetch('standard');
    }
  });

  it('初始化后控件、图例、统计渲染完整', () => {
    expect(document.getElementById('profile-select')!.children.length).toBeGreaterThanOrEqual(3);
    expect(document.getElementById('legend')!.children.length).toBeGreaterThan(0);
    expect(document.getElementById('start-btn')!.disabled).toBe(true);
    expect(document.getElementById('crs-banner')!.textContent).toContain('GetCapabilities');
  });

  it('框选整个范围后开始按钮可用，并显示 bbox 读数', () => {
    document.getElementById('select-extent-btn')!.dispatchEvent(new Event('click'));
    expect(document.getElementById('bbox-readout')!.textContent).toContain('minX');
    expect(document.getElementById('start-btn')!.disabled).toBe(false);
  });

  it('完整采集后渲染要素列表、统计，并可打开来源链详情', async () => {
    document.getElementById('start-btn')!.dispatchEvent(new Event('click'));
    await vi.waitFor(
      () => expect(document.getElementById('start-btn')!.disabled).toBe(false),
      { timeout: 5000 },
    );
    await vi.waitFor(
      () =>
        expect(document.querySelectorAll('#feature-list .feature-item').length).toBeGreaterThan(0),
      { timeout: 5000 },
    );
    const items = [...document.querySelectorAll('#feature-list .feature-item')];
    const rd1 = items.find((el) => el.textContent?.includes('RD-001'));
    expect(rd1).toBeTruthy();
    // 跨块要素按稳定标识合并为一条
    expect(items.filter((el) => el.textContent?.includes('RD-001')).length).toBe(1);
    expect(document.getElementById('stat-grid')!.textContent).toContain('选区相交要素');

    rd1!.dispatchEvent(new Event('click', { bubbles: true }));
    expect(document.getElementById('detail-card')!.hidden).toBe(false);
    expect(document.getElementById('feature-detail')!.textContent).toContain('版本选取依据');
    expect(
      document.querySelectorAll('#feature-detail .obs-table tbody tr').length,
    ).toBeGreaterThan(0);
  });

  it('轴顺序错误时呈现明确报错且分块标记失败', async () => {
    vi.unstubAllGlobals();
    stubFetch('axisFault');
    document.getElementById('reset-btn')!.dispatchEvent(new Event('click'));
    document.getElementById('select-extent-btn')!.dispatchEvent(new Event('click'));
    document.getElementById('start-btn')!.dispatchEvent(new Event('click'));
    await vi.waitFor(
      () => expect(document.getElementById('global-message')!.hidden).toBe(false),
      { timeout: 5000 },
    );
    expect(document.getElementById('global-message')!.textContent).toContain('轴顺序');
    expect(document.getElementById('chunk-summary')!.textContent).toContain('失败');
  });
});
