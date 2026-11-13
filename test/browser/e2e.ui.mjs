/**
 * 真实浏览器端到端测试（Playwright）。
 * 自管两个子进程：本地模拟 WFS（8787）与 Vite 预览服务（4173），
 * 结束后统一清理。运行前需先 npm run build（npm run test:browser 已包含）。
 *
 * 覆盖：
 *  - 框选 → 分块采集 → 地图/列表渲染 → 统计与状态语义
 *  - 点选要素查看来源链（经过哪些分块、版本选取依据）
 *  - GeoJSON 下载校验（仅含选区相交要素、带来源链）
 *  - 坏分页截断 → 切换标准端点只重采失败/截断块
 *  - 轴顺序不一致的明确错误
 */
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const WFS_PORT = 8787;
const WEB_PORT = 4173;
const children = [];

// 兜底：若已有占用 8787 的旧服务，先释放（失败可忽略，后续 waitFor 会暴露问题）
spawnSync('fuser', ['-k', `${WFS_PORT}/tcp`], { stdio: 'ignore' });

function start(cmd, args, label) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.stdout.write(`[${label}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${label}] ${d}`));
  children.push(child);
  return child;
}

async function waitFor(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* 未就绪，继续等 */
    }
    await delay(200);
  }
  throw new Error(`服务未就绪：${url}`);
}

async function main() {
  start('node', ['server/index.js'], 'wfs');
  start('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(WEB_PORT)], 'web');
  await waitFor(`http://127.0.0.1:${WFS_PORT}/wfs/standard?request=GetCapabilities`);
  await waitFor(`http://127.0.0.1:${WEB_PORT}/`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  const fail = (msg) => {
    throw new Error(msg);
  };
  const assert = (cond, msg) => {
    if (!cond) fail(msg);
  };

  try {
    await page.goto(`http://127.0.0.1:${WEB_PORT}/`);
    await page.waitForSelector('#map.leaflet-container');

    // ---- 用例 1：标准服务完整采集 ----
    await page.selectOption('#profile-select', 'standard');
    await page.click('#select-extent-btn');
    assert((await page.textContent('#bbox-readout')).includes('minX'), '选区读数未更新');
    assert(await page.isEnabled('#start-btn'), '开始按钮应可用');

    await page.click('#start-btn');
    await page.waitForFunction(
      () => document.querySelector('#start-btn')?.disabled === false,
      { timeout: 20000 },
    );
    // 等结束横幅消失（overlay hidden）
    await page.waitForSelector('#map-overlay', { state: 'hidden', timeout: 10000 });

    const summary = await page.textContent('#chunk-summary');
    assert(/失败 0/.test(summary ?? ''), `不应有失败块：${summary}`);
    const featureCount = await page.locator('#feature-list .feature-item').count();
    assert(featureCount > 0, '结果列表应有要素');

    // CRS 横幅显示能力文档声明
    const banner = await page.textContent('#crs-banner');
    assert(/EPSG:3857/.test(banner ?? '') && /XY/.test((banner ?? '').toUpperCase()), `CRS 横幅异常：${banner}`);

    // 地图上分块矩形已渲染
    const rectCount = await page.locator('.leaflet-interactive').count();
    assert(rectCount > 8, `地图矢量图层数量异常：${rectCount}`);

    // ---- 用例 2：点选跨块要素，查看来源链 ----
    // 找一个“经多次分块返回”的要素（RD-001 滨海大道贯穿选区）
    const rdItem = page.locator('#feature-list .feature-item', { hasText: 'RD-001' }).first();
    await rdItem.waitFor({ timeout: 5000 });
    await rdItem.click();
    await page.waitForSelector('#detail-card:not([hidden])');
    const detail = await page.textContent('#feature-detail');
    assert(detail.includes('版本选取依据'), '缺少版本选取依据');
    assert(detail.includes('经过哪些分块进入结果'), '缺少来源链标题');
    const obsRows = await page.locator('#feature-detail .obs-table tbody tr').count();
    assert(obsRows >= 2, `跨块要素应至少 2 次目击，实际 ${obsRows}`);

    // ---- 用例 3：导出要素 GeoJSON 并校验 ----
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#export-features-btn'),
    ]);
    const path = await download.path();
    const geo = JSON.parse((await import('node:fs/promises')).readFileSync(path, 'utf8'));
    assert(geo.type === 'FeatureCollection', '导出不是 FeatureCollection');
    assert(geo.features.length === featureCount, '导出数量与列表不一致');
    for (const f of geo.features) {
      assert(f.properties.stableId, '缺少 stableId');
      assert(Array.isArray(f.properties.observations) && f.properties.observations.length > 0, '缺少来源链');
      assert(typeof f.properties.selectionReason === 'string', '缺少选取依据');
    }
    // 稳定标识唯一
    const ids = geo.features.map((f) => f.properties.stableId);
    assert(new Set(ids).size === ids.length, '导出存在重复稳定标识');

    // ---- 用例 4：坏分页截断 → 切换标准端点只重采 ----
    await page.click('#reset-btn');
    await page.selectOption('#profile-select', 'brokenPaging');
    // 用 10km 大块：密集点群（65 个）整块落在一个分块内，单页 50 上限必触发截断
    await page.selectOption('#chunk-size-select', { label: /10 km/ });
    await page.click('#select-extent-btn');
    await page.click('#start-btn');
    await page.waitForFunction(
      () => document.querySelector('#start-btn')?.disabled === false,
      { timeout: 20000 },
    );
    const warnText = await page.textContent('#global-message');
    assert(/截断/.test(warnText ?? ''), `坏分页应提示截断：${warnText}`);
    assert(await page.isEnabled('#retry-btn'), '存在截断块时重采按钮应可用');

    // 切换到标准端点后只重采失败/截断块，复用既有结果
    await page.selectOption('#profile-select', 'standard');
    await page.click('#retry-btn');
    await page.waitForFunction(
      () => document.querySelector('#retry-btn')?.disabled === true,
      { timeout: 20000 },
    );
    const summary2 = await page.textContent('#chunk-summary');
    assert(/未采全（截断） 0/.test(summary2 ?? '') && /失败 0/.test(summary2 ?? ''), `重采后仍有异常块：${summary2}`);
    const featureCount2 = await page.locator('#feature-list .feature-item').count();
    assert(featureCount2 >= featureCount, '重采后要素数不应减少');

    // ---- 用例 5：轴顺序不一致的明确错误 ----
    await page.click('#reset-btn');
    await page.selectOption('#profile-select', 'axisFault');
    await page.check('#force-wrong-axis');
    await page.click('#select-extent-btn');
    await page.click('#start-btn');
    await page.waitForFunction(
      () => document.querySelector('#start-btn')?.disabled === false,
      { timeout: 20000 },
    );
    const errText = await page.textContent('#global-message');
    assert(/轴顺序/.test(errText ?? ''), `应出现明确轴顺序错误：${errText}`);
    const failedBadges = await page.locator('.state-badge', { hasText: '失败' }).count();
    assert(failedBadges >= 1, '应有失败状态分块');

    assert(errors.length === 0, `浏览器控制台存在错误：\n${errors.join('\n')}`);
    console.log('\n✅ 全部浏览器端到端用例通过');
  } finally {
    await browser.close().catch(() => {});
    for (const c of children) c.kill();
  }
}

main().catch((err) => {
  for (const c of children) c.kill();
  console.error('\n❌ 浏览器端到端测试失败：', err);
  process.exit(1);
});
