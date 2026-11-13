import type { AxisOrder, BBox, CrsInfo } from '@/types';

export class AxisOrderError extends Error {
  code = 'AXIS_ORDER_MISMATCH';
  constructor(
    message: string,
    public detail: {
      declared: AxisOrder;
      used: AxisOrder;
      srsName: string;
    },
  ) {
    super(message);
    this.name = 'AxisOrderError';
  }
}

/**
 * 依据 EPSG 规范给出“地理 CRS 轴顺序”的权威默认值。
 * 4326 在 OGC 规范下是 lat,lon（yx）；投影坐标系通常是 easting,northing（xy）。
 * 这是校验服务声明是否自洽的基线。
 */
export function conventionalAxisOrder(srsName: string): AxisOrder {
  const code = srsName.replace(/^urn:ogc:def:crs:EPSG:(\d+\.)?/, '').replace(/^EPSG:/, '');
  if (code === '4326' || code === '4269' || code === '4267') return 'yx';
  return 'xy';
}

/**
 * 从 GetCapabilities 文本中提取默认 CRS 与轴顺序声明。
 * 模拟服务返回的是精简 XML，真实服务也可用同样的正则思路解析。
 */
export function parseCapabilities(xml: string): {
  crs: CrsInfo | null;
  rawDefaultCrs: string | null;
} {
  const match = xml.match(/<DefaultCRS>([^<]+)<\/DefaultCRS>/);
  const axisMatch = xml.match(/<AxisOrder>(xy|yx)<\/AxisOrder>/);
  if (!match) return { crs: null, rawDefaultCrs: null };
  const raw = match[1].trim();
  const srsName = raw.includes('EPSG')
    ? `EPSG:${raw.split(':').pop()}`
    : raw;
  const declared = (axisMatch?.[1] as AxisOrder) ?? conventionalAxisOrder(srsName);
  return {
    crs: { srsName, axisOrder: declared },
    rawDefaultCrs: raw,
  };
}

/**
 * 按轴顺序把 BBox 序列化为请求参数值。
 * xy -> "minX,minY,maxX,maxY"；yx -> "minY,minX,maxY,maxX"。
 */
export function formatBbox(bbox: BBox, axisOrder: AxisOrder): string {
  if (axisOrder === 'xy') {
    return `${bbox.minX},${bbox.minY},${bbox.maxX},${bbox.maxY}`;
  }
  return `${bbox.minY},${bbox.minX},${bbox.maxY},${bbox.maxX}`;
}

/**
 * 校验“准备发送的轴顺序”与“服务声明/约定”是否一致。
 * 任何不一致都直接抛错——绝不在静默交换坐标后继续请求。
 */
export function assertAxisConsistency(opts: {
  crs: CrsInfo;
  requestAxisOrder: AxisOrder;
  profileExpected: AxisOrder;
  forceWrong?: boolean;
}): void {
  const { crs, requestAxisOrder, profileExpected, forceWrong } = opts;
  if (forceWrong) {
    throw new AxisOrderError(
      `轴顺序校验失败：配置要求故意发送 ${requestAxisOrder}，但服务 ${crs.srsName} 声明为 ${crs.axisOrder}。已阻止请求，避免静默交换坐标。`,
      { declared: crs.axisOrder, used: requestAxisOrder, srsName: crs.srsName },
    );
  }
  if (requestAxisOrder !== crs.axisOrder) {
    throw new AxisOrderError(
      `查询坐标顺序与服务声明不一致：请求按 ${requestAxisOrder.toUpperCase()} 组装，而 ${crs.srsName} 在 GetCapabilities 中声明为 ${crs.axisOrder.toUpperCase()}。请修正客户端轴顺序后重试。`,
      { declared: crs.axisOrder, used: requestAxisOrder, srsName: crs.srsName },
    );
  }
  if (profileExpected !== crs.axisOrder) {
    throw new AxisOrderError(
      `服务配置的预期轴顺序(${profileExpected})与 GetCapabilities 声明(${crs.axisOrder})不一致，拒绝在歧义状态下发起查询。`,
      { declared: crs.axisOrder, used: profileExpected, srsName: crs.srsName },
    );
  }
}
