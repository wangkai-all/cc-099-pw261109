/**
 * 模拟 WFS 2.0 的请求处理（不依赖任何第三方库）。
 *
 * 三种模式：
 *  - standard：完整 numberMatched + next 链接，分页信息可靠；
 *  - brokenPaging：密集点群所在查询命中上限后，第 2 页起 numberMatched=null
 *    且不返回 next 链接，制造“达到上限但无可靠下一页”的截断现场；
 *  - axisFault：服务声明 xy，但请求按 yx 组装 bbox 时直接抛 OWS 异常。
 *
 * 版本漂移：同一稳定要素在不同分块（bbox 中心决定）返回不同 version，
 * 用于演示客户端必须保留版本来源并给出选取依据。
 */
import {
  buildDataset,
  DATASET_EXTENT,
  DECLARED_AXIS_ORDER,
  SRS_NAME,
  TYPE_NAMES,
} from './data.js';

const DATASET = buildDataset();

export const MODES = {
  standard: {
    capabilitiesAxis: 'xy',
    breakPaging: false,
    rejectWrongAxis: false,
  },
  brokenPaging: {
    capabilitiesAxis: 'xy',
    breakPaging: true,
    rejectWrongAxis: false,
  },
  axisFault: {
    capabilitiesAxis: 'xy',
    breakPaging: false,
    // 该端点严格校验轴顺序，演示“查询坐标顺序和服务声明不一致”的明确错误
    rejectWrongAxis: true,
  },
};

export function capabilitiesXml(mode) {
  const conf = MODES[mode] ?? MODES.standard;
  return `<?xml version="1.0" encoding="UTF-8"?>
<wfs:WFS_Capabilities version="2.0.0" xmlns:wfs="http://www.opengis.net/wfs/2.0">
  <ows:ServiceIdentification xmlns:ows="http://www.opengis.net/ows/1.1">
    <ows:Title>Pointwise Delivery 本地示例 WFS（模式：${mode}）</ows:Title>
    <ows:ServiceType>WFS</ows:ServiceType>
    <ows:ServiceTypeVersion>2.0.0</ows:ServiceTypeVersion>
  </ows:ServiceIdentification>
  <wfs:FeatureTypeList>
    <wfs:FeatureType><Name>${TYPE_NAMES.roads}</Name>
      <DefaultCRS>urn:ogc:def:crs:EPSG::3857</DefaultCRS><AxisOrder>${conf.capabilitiesAxis}</AxisOrder></wfs:FeatureType>
    <wfs:FeatureType><Name>${TYPE_NAMES.facilities}</Name>
      <DefaultCRS>urn:ogc:def:crs:EPSG::3857</DefaultCRS><AxisOrder>${conf.capabilitiesAxis}</AxisOrder></wfs:FeatureType>
    <wfs:FeatureType><Name>${TYPE_NAMES.poi}</Name>
      <DefaultCRS>urn:ogc:def:crs:EPSG::3857</DefaultCRS><AxisOrder>${conf.capabilitiesAxis}</AxisOrder></wfs:FeatureType>
    <wfs:FeatureType><Name>${TYPE_NAMES.all}</Name>
      <DefaultCRS>urn:ogc:def:crs:EPSG::3857</DefaultCRS><AxisOrder>${conf.capabilitiesAxis}</AxisOrder></wfs:FeatureType>
  </wfs:FeatureTypeList>
  <ows:OperationsMetadata xmlns:ows="http://www.opengis.net/ows/1.1">
    <ows:Operation name="GetFeature"><ows:DCP><ows:HTTP><ows:Get xlink:href="/wfs/${mode}"/></ows:HTTP></ows:DCP></ows:Operation>
  </ows:OperationsMetadata>
</wfs:WFS_Capabilities>`;
}

function owsException(code, text) {
  return {
    status: 400,
    contentType: 'application/xml; charset=utf-8',
    body: `<?xml version="1.0" encoding="UTF-8"?>
<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1" version="2.0.0">
  <ows:Exception exceptionCode="${code}">
    <ows:ExceptionText>${escapeXml(text)}</ows:ExceptionText>
  </ows:Exception>
</ows:ExceptionReport>`,
  };
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function parseBbox(raw) {
  // 形如 "minX,minY,maxX,maxY,EPSG:3857"，轴顺序由 axisOrder 参数声明
  const parts = raw.split(',').map((s) => s.trim());
  const nums = parts.slice(0, 4).map(Number);
  const srs = parts[4] ?? SRS_NAME;
  if (nums.some((n) => Number.isNaN(n))) {
    throw new Error(`bbox 参数无法解析：${raw}`);
  }
  return { nums, srs };
}

function bboxesIntersect(a, b) {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

/**
 * 版本漂移规则（确定性）：
 * 以 bbox 中心相对数据集原点的网格坐标 (gx, gy) 作为“分块身份”，
 * 不同分块对同一要素给出 base / base+1 / base+2 三档版本，
 * 让客户端在合并时真实面对“同标识不同版本”。
 */
function driftedFeature(feature, bbox) {
  const gx = Math.floor((bbox.minX - DATASET_EXTENT.minX) / 5000);
  const gy = Math.floor((bbox.minY - DATASET_EXTENT.minY) / 7000);
  const base = Number(feature.properties.version ?? 1);
  const delta = Math.abs((gx * 7 + gy * 13 + feature.id.length) % 3);
  if (delta === 0) return feature;
  return {
    ...feature,
    properties: { ...feature.properties, version: base + delta },
  };
}

function buildNextUrl(req, nextIndex) {
  const u = new URL(`http://local/wfs/${req.mode}`);
  for (const [k, v] of Object.entries(req.rawParams)) u.searchParams.set(k, v);
  u.searchParams.set('startIndex', String(nextIndex));
  // 仅保留路径+查询，模拟相对链接
  return `${u.pathname}?${u.searchParams.toString()}`;
}

export function handleGetFeature(params, mode) {
  const conf = MODES[mode] ?? MODES.standard;
  const typeName = params.get('typeNames') ?? params.get('typeName');
  const bboxRaw = params.get('bbox');
  const axisOrder = params.get('axisOrder') ?? DECLARED_AXIS_ORDER;
  const count = Math.max(1, parseInt(params.get('count') ?? '100', 10));
  const startIndex = Math.max(0, parseInt(params.get('startIndex') ?? '0', 10));

  if (!typeName || !DATASET[typeName]) {
    return owsException('InvalidParameterValue', `未知要素类型：${typeName ?? '(空)'}`);
  }
  if (!bboxRaw) {
    return owsException('MissingParameterValue', 'GetFeature 必须带 bbox 参数');
  }

  let parsed;
  try {
    parsed = parseBbox(bboxRaw);
  } catch (err) {
    return owsException('InvalidParameterValue', err.message);
  }

  // 轴顺序校验：axisFault 模式下，任何与声明(xy)不符的请求直接拒绝
  if (conf.rejectWrongAxis && axisOrder !== conf.capabilitiesAxis) {
    return owsException(
      'AXIS_ORDER_MISMATCH',
      `服务 ${SRS_NAME} 声明轴顺序为 ${conf.capabilitiesAxis}，但请求按 ${axisOrder} 组装 bbox（${bboxRaw}）。坐标顺序歧义，拒绝执行。`,
    );
  }

  // 还原为内部统一的 minX/minY/maxX/maxY（xy 语义）
  let bbox;
  if (axisOrder === 'xy') {
    const [minX, minY, maxX, maxY] = parsed.nums;
    bbox = { minX, minY, maxX, maxY };
  } else {
    // 客户端按 yx 发：第 1/3 个是 y
    const [minY, minX, maxY, maxX] = parsed.nums;
    bbox = { minX, minY, maxX, maxY };
  }

  const matched = DATASET[typeName]
    .filter((f) => bboxesIntersect(f.bbox, bbox))
    .map((f) => driftedFeature(f, bbox));

  const total = matched.length;
  const page = matched.slice(startIndex, startIndex + count);
  const hitLimit = page.length === count;
  const realNextIndex = startIndex + count;
  const hasMore = realNextIndex < total;

  // 截断模式：命中上限且本页属于点群密集查询时，抹掉可靠分页信息
  const denseQuery =
    conf.breakPaging &&
    hitLimit &&
    matched.some((f) => String(f.properties.featureCode).startsWith('POI-0'));

  let numberMatched = total;
  let next = null;
  if (denseQuery) {
    // 坏服务：总数未知，也不给 next 链接；startIndex 参数被忽略式处理
    numberMatched = null;
    next = null;
  } else if (hasMore) {
    next = buildNextUrl(
      { mode, rawParams: Object.fromEntries(params.entries()) },
      realNextIndex,
    );
  }

  return {
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({
      type: 'FeatureCollection',
      numberMatched,
      numberReturned: page.length,
      next,
      features: page,
    }),
  };
}
