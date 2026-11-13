/**
 * 端到端：直接对运行中的本地模拟 WFS 走完整采集链路。
 * 运行前需先启动 server（npm run server，默认 127.0.0.1:8787）。
 * 这里不依赖 TS 工具链，用纯 JS 复刻最小客户端编排，验证服务契约本身。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.WFS_BASE ?? 'http://127.0.0.1:8787';

async function getJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
}

function bboxParam(b, axis = 'xy') {
  return axis === 'xy'
    ? `${b.minX},${b.minY},${b.maxX},${b.maxY},EPSG:3857`
    : `${b.minY},${b.minX},${b.maxY},${b.maxX},EPSG:3857`;
}

function featureUrl(mode, bbox, { count = 50, startIndex = 0, axis = 'xy' } = {}) {
  const params = new URLSearchParams({
    request: 'GetFeature',
    typeNames: 'demo:all',
    count: String(count),
    startIndex: String(startIndex),
    axisOrder: axis,
    srsName: 'EPSG:3857',
    bbox: bboxParam(bbox, axis),
  });
  return `${BASE}/wfs/${mode}?${params}`;
}

test('GetCapabilities 声明 EPSG:3857 与 xy 轴顺序', async () => {
  const res = await fetch(`${BASE}/wfs/standard?request=GetCapabilities`);
  const xml = await res.text();
  assert.match(xml, /EPSG::3857/);
  assert.match(xml, /<AxisOrder>xy<\/AxisOrder>/);
});

test('标准端点：整个演示范围可通过 next 链接完整翻页取全 86 条', async () => {
  const extent = { minX: 13520000, minY: 3640000, maxX: 13540000, maxY: 3654000 };
  const seen = new Map();
  let url = featureUrl('standard', extent, { count: 50 });
  let pages = 0;
  while (url) {
    const { json } = await getJson(url);
    pages += 1;
    for (const f of json.features) seen.set(f.properties.featureCode, f);
    url = json.next
      ? `${BASE}${json.next.startsWith('/') ? json.next : `/${json.next}`}`
      : null;
    assert.ok(pages < 10, '分页不应超过保险丝页数');
  }
  assert.equal(pages, 2);
  assert.equal(seen.size, 86);
});

test('坏分页端点：命中 50 上限却无 numberMatched/next，客户端必须识别为截断', async () => {
  // 密集点群所在区域
  const dense = { minX: 13532000, minY: 3649000, maxX: 13538000, maxY: 3653000 };
  const { json } = await getJson(featureUrl('brokenPaging', dense, { count: 50 }));
  assert.equal(json.numberReturned, 50);
  assert.equal(json.numberMatched, null);
  assert.equal(json.next, null);

  // 复刻客户端截断判定：hitLimit && 无 next && 总数未知 => 不可认为采全
  const hitLimit = json.numberReturned === 50;
  const reliableNext =
    json.next != null ||
    (json.numberMatched != null && 50 < json.numberMatched);
  assert.ok(hitLimit && !reliableNext, '必须判定为未采全，禁止当作完整结果');
});

test('轴顺序故障端点：yx 请求被明确拒绝并带 AXIS_ORDER_MISMATCH', async () => {
  const extent = { minX: 13520000, minY: 3640000, maxX: 13540000, maxY: 3654000 };
  const res = await fetch(featureUrl('axisFault', extent, { axis: 'yx' }));
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.match(text, /AXIS_ORDER_MISMATCH/);
  assert.match(text, /轴顺序/);
});

test('同一要素在不同分块返回不同版本（版本漂移真实存在）', async () => {
  const boxes = [
    { minX: 13520000, minY: 3647000, maxX: 13525000, maxY: 3654000 },
    { minX: 13525000, minY: 3647000, maxX: 13530000, maxY: 3654000 },
    { minX: 13530000, minY: 3647000, maxX: 13535000, maxY: 3654000 },
  ];
  const versions = new Set();
  for (const b of boxes) {
    const { json } = await getJson(featureUrl('standard', b, { count: 50 }));
    const rd1 = json.features.find((f) => f.properties.featureCode === 'RD-001');
    if (rd1) versions.add(rd1.properties.version);
  }
  assert.ok(versions.size >= 2, `RD-001 应跨块出现多个版本，实际：${[...versions]}`);
});

test('数据空洞：精确框选返回 numberMatched=0（确认无数据，而非未采到）', async () => {
  // 从服务模块导入空洞坐标，避免硬编码漂移
  const { DATA_VOID } = await import('../../server/data.js');
  const { json } = await getJson(featureUrl('standard', DATA_VOID, { count: 10 }));
  assert.equal(json.numberMatched, 0);
  assert.equal(json.numberReturned, 0);
  assert.equal(json.next, null);
});
