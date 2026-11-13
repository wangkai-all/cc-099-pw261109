// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WfsClient, WfsHttpError } from '@/lib/wfsClient';
import { AxisOrderError } from '@/lib/axisOrder';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const baseRequest = {
  endpoint: '/wfs/standard',
  typeName: 'demo:all',
  bbox: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
  crs: { srsName: 'EPSG:3857', axisOrder: 'xy' as const },
  requestAxisOrder: 'xy' as const,
  profileExpected: 'xy' as const,
  count: 50,
  startIndex: 0,
};

afterEach(() => vi.unstubAllGlobals());

describe('WfsClient.getPage 响应归一化', () => {
  it('next 为空字符串时归一化为 undefined，不能被当作可靠下一页', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          type: 'FeatureCollection',
          numberMatched: 50,
          numberReturned: 50,
          next: '',
          features: [],
        }),
      ),
    );
    const page = await new WfsClient().getPage(baseRequest);
    expect(page.meta.nextUrl).toBeUndefined();
    expect(page.meta.nextIndex).toBeNull();
    expect(page.meta.hitLimit).toBe(false); // 由 collector 回填，客户端默认 false
  });

  it('numberMatched 显式 null 时保留 null 语义（未知总数）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          type: 'FeatureCollection',
          numberMatched: null,
          numberReturned: 50,
          next: null,
          features: [{ type: 'Feature', id: 'x', geometry: { type: 'Point', coordinates: [1, 1] }, properties: {} }],
        }),
      ),
    );
    const page = await new WfsClient().getPage(baseRequest);
    expect(page.meta.numberMatched).toBeNull();
    expect(page.meta.nextIndex).toBeNull();
    expect(page.features).toHaveLength(1);
  });

  it('相对 next 链接能解析出其中的 startIndex', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          type: 'FeatureCollection',
          numberMatched: 120,
          numberReturned: 50,
          next: '/wfs/standard?startIndex=50',
          features: [],
        }),
      ),
    );
    const page = await new WfsClient().getPage(baseRequest);
    expect(page.meta.nextIndex).toBe(50);
    expect(page.meta.nextUrl).toBe('/wfs/standard?startIndex=50');
  });

  it('非 2xx 且带 AXIS_ORDER_MISMATCH 时抛 AxisOrderError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          '<ows:ExceptionReport><ows:Exception exceptionCode="AXIS_ORDER_MISMATCH"></ows:Exception></ows:ExceptionReport>',
          { status: 400 },
        ),
      ),
    );
    await expect(new WfsClient().getPage(baseRequest)).rejects.toBeInstanceOf(AxisOrderError);
  });

  it('其他非 2xx 抛 WfsHttpError 并保留状态码', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await expect(new WfsClient().getPage(baseRequest)).rejects.toMatchObject({
      name: 'WfsHttpError',
      status: 500,
    });
  });

  it('返回非法 JSON 时抛 BAD_JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json', { status: 200 })));
    const err = await new WfsClient().getPage(baseRequest).catch((e) => e);
    expect(err).toBeInstanceOf(WfsHttpError);
    expect((err as WfsHttpError).code).toBe('BAD_JSON');
  });
});

describe('WfsClient.getCapabilities', () => {
  it('从能力文档解析 CRS 与轴顺序', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          '<Capabilities><DefaultCRS>urn:ogc:def:crs:EPSG::3857</DefaultCRS><AxisOrder>xy</AxisOrder></Capabilities>',
          { status: 200 },
        ),
      ),
    );
    const cap = await new WfsClient().getCapabilities('/wfs/standard');
    expect(cap.crs).toEqual({ srsName: 'EPSG:3857', axisOrder: 'xy' });
  });

  it('能力文档缺少 CRS 声明时报错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<Capabilities/>', { status: 200 })));
    await expect(new WfsClient().getCapabilities('/wfs/standard')).rejects.toBeInstanceOf(WfsHttpError);
  });
});
