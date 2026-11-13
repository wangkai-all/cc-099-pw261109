import type {
  AxisOrder,
  BBox,
  CrsInfo,
  WfsFeature,
  WfsPage,
  WfsPageMeta,
} from '@/types';
import {
  AxisOrderError,
  assertAxisConsistency,
  formatBbox,
  parseCapabilities,
} from '@/lib/axisOrder';

export class WfsHttpError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: string,
    public code?: string,
  ) {
    super(message);
    this.name = 'WfsHttpError';
  }
}

export interface GetCapabilitiesResult {
  crs: CrsInfo;
  raw: string;
}

export interface PageRequest {
  endpoint: string;
  typeName: string;
  bbox: BBox;
  crs: CrsInfo;
  requestAxisOrder: AxisOrder;
  profileExpected: AxisOrder;
  count: number;
  startIndex: number;
  forceWrongAxisOrder?: boolean;
  signal?: AbortSignal;
}

/**
 * 极简 WFS 2.0 客户端（面向项目附带的本地示例服务，响应为 JSON）。
 * 真实 WFS 多为 GML/XML，这里通过服务端 profile 统一换成 JSON 输出，
 * 分页语义（count/startIndex、numberMatched、next 链接）严格按 2.0 规范处理。
 */
export class WfsClient {
  constructor(private fetchImpl: typeof fetch = fetch) {}

  async getCapabilities(
    endpoint: string,
    signal?: AbortSignal,
  ): Promise<GetCapabilitiesResult> {
    const url = `${endpoint}?service=WFS&version=2.0.0&request=GetCapabilities`;
    const res = await this.fetchImpl(url, { signal });
    const text = await res.text();
    if (!res.ok) {
      throw new WfsHttpError(
        `GetCapabilities 失败：HTTP ${res.status}`,
        res.status,
        text,
      );
    }
    const parsed = parseCapabilities(text);
    if (!parsed.crs) {
      throw new WfsHttpError(
        'GetCapabilities 中未找到 DefaultCRS 声明，无法确定坐标参考系',
        res.status,
        text,
        'NO_CRS_DECLARATION',
      );
    }
    return { crs: parsed.crs, raw: text };
  }

  async getPage(req: PageRequest): Promise<WfsPage> {
    // 发出请求前做轴顺序一致性校验，不一致直接报错，绝不静默交换坐标
    assertAxisConsistency({
      crs: req.crs,
      requestAxisOrder: req.requestAxisOrder,
      profileExpected: req.profileExpected,
      forceWrong: req.forceWrongAxisOrder,
    });

    const params = new URLSearchParams({
      service: 'WFS',
      version: '2.0.0',
      request: 'GetFeature',
      typeNames: req.typeName,
      count: String(req.count),
      startIndex: String(req.startIndex),
      srsName: req.crs.srsName,
      axisOrder: req.requestAxisOrder,
      outputFormat: 'application/json',
      bbox: `${formatBbox(req.bbox, req.requestAxisOrder)},${req.crs.srsName}`,
    });
    const url = `${req.endpoint}?${params.toString()}`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal: req.signal });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new WfsHttpError(
        `网络错误：${(err as Error).message}`,
        0,
        String(err),
        'NETWORK_ERROR',
      );
    }

    const text = await res.text();
    if (!res.ok) {
      const code = extractExceptionCode(text);
      if (code === 'AXIS_ORDER_MISMATCH' || text.includes('AxisOrder')) {
        throw new AxisOrderError(
          `服务拒绝请求：查询坐标顺序与 ${req.crs.srsName} 声明不一致（HTTP ${res.status}）`,
          {
            declared: req.crs.axisOrder,
            used: req.requestAxisOrder,
            srsName: req.crs.srsName,
          },
        );
      }
      throw new WfsHttpError(
        `GetFeature 失败：HTTP ${res.status}`,
        res.status,
        text,
        code,
      );
    }

    let payload: ServerPagePayload;
    try {
      payload = JSON.parse(text) as ServerPagePayload;
    } catch {
      throw new WfsHttpError(
        '服务响应不是合法 JSON',
        res.status,
        text.slice(0, 500),
        'BAD_JSON',
      );
    }
    return normalizePage(payload);
  }
}

interface ServerPagePayload {
  type: string;
  numberMatched?: number | null;
  numberReturned?: number;
  next?: string | null;
  features: WfsFeature[];
}

function normalizePage(payload: ServerPagePayload): WfsPage {
  const features = Array.isArray(payload.features) ? payload.features : [];
  const numberReturned = payload.numberReturned ?? features.length;
  // 注意：服务可能把 numberMatched 显式返回 null（未知），必须保留 null 语义
  const numberMatched =
    payload.numberMatched === undefined || payload.numberMatched === null
      ? null
      : Number(payload.numberMatched);
  const meta: WfsPageMeta = {
    numberMatched,
    numberReturned,
    nextIndex: parseNextIndex(payload.next),
    // 空字符串与 null/undefined 一样视为“无 next 链接”，避免被误判成可靠下一页
    nextUrl: payload.next ? payload.next : undefined,
    hitLimit: false, // 由调用方按 count 比较后回填
  };
  return { features, meta };
}

function parseNextIndex(next: string | null | undefined): number | null {
  if (!next) return null;
  try {
    const u = new URL(next, 'http://local');
    const v = u.searchParams.get('startIndex');
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
}

function extractExceptionCode(xml: string): string | undefined {
  const m = xml.match(/exceptionCode="([^"]+)"/);
  return m?.[1];
}
