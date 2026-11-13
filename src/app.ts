import './style.css';
import L from 'leaflet';
import {
  CHUNK_SIZE_OPTIONS,
  DEMO_EXTENT,
  SERVICE_PROFILES,
} from '@/config';
import { MapController, STATE_COLORS, STATE_LABELS } from '@/map';
import { planChunks, retryableChunks, summarizeStates } from '@/lib/chunking';
import { CollectionEngine } from '@/lib/collector';
import { filterBySelection } from '@/lib/filter';
import { FeatureMerger } from '@/lib/merge';
import {
  chunksToGeoJSON,
  downloadGeoJSON,
  featuresToGeoJSON,
} from '@/lib/export';
import { AxisOrderError } from '@/lib/axisOrder';
import { WfsClient, WfsHttpError } from '@/lib/wfsClient';
import type {
  BBox,
  ChunkRecord,
  CrsInfo,
  MergedFeature,
  ServiceProfile,
} from '@/types';

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const btn = (id: string): HTMLButtonElement => $(id);

interface AppState {
  profile: ServiceProfile;
  crs: CrsInfo | null;
  selection: BBox | null;
  chunks: ChunkRecord[];
  engine: CollectionEngine | null;
  /** 跨“开始/重采”持久化的要素合并器，保证重采不丢失既有结果与来源链 */
  merger: FeatureMerger | null;
  merged: MergedFeature[];
  selectedFeatureId: string | null;
}

const state: AppState = {
  profile: SERVICE_PROFILES[0],
  crs: null,
  selection: null,
  chunks: [],
  engine: null,
  merger: null,
  merged: [],
  selectedFeatureId: null,
};

// ---------- 初始化 ----------
const mapController = new MapController($('map'));
mapController.fitBBox(DEMO_EXTENT);
mapController.setSelectionHandler((bbox) => {
  state.selection = bbox;
  renderBBox();
  refreshStartEnabled();
});

function initControls(): void {
  const profileSelect = $<HTMLSelectElement>('profile-select');
  profileSelect.innerHTML = SERVICE_PROFILES.map(
    (p) => `<option value="${p.id}">${p.label}</option>`,
  ).join('');
  profileSelect.onchange = (): void => {
    state.profile = SERVICE_PROFILES.find((p) => p.id === profileSelect.value)!;
    state.crs = null;
    $('profile-note').textContent = state.profile.note ?? '';
    $('crs-banner').textContent = '尚未读取 GetCapabilities';
    refreshStartEnabled();
  };
  $('profile-note').textContent = state.profile.note ?? '';

  const chunkSelect = $<HTMLSelectElement>('chunk-size-select');
  chunkSelect.innerHTML = CHUNK_SIZE_OPTIONS.map(
    (o, i) => `<option value="${i}">${o.label}</option>`,
  ).join('');

  $('locate-btn').onclick = (): void => mapController.fitBBox(DEMO_EXTENT);
  $('select-extent-btn').onclick = (): void => {
    state.selection = { ...DEMO_EXTENT };
    mapController.setSelection(state.selection);
    renderBBox();
    refreshStartEnabled();
  };

  $('start-btn').onclick = (): void => void startRun('fresh');
  $('pause-btn').onclick = (): void => {
    state.engine?.pause();
    setOverlay('已暂停 — 点击“继续”恢复采集');
    showMessage('warn', '采集已暂停：在途请求结束后引擎挂起，未完成分块保持“已暂停”，可继续或只重采失败块。');
    refreshStartEnabled();
  };
  $('resume-btn').onclick = (): void => {
    state.engine?.resume();
    setOverlay('采集中… 可随时暂停');
    hideMessage();
    refreshStartEnabled();
  };
  $('retry-btn').onclick = (): void => void startRun('retry');
  $('reset-btn').onclick = (): void => resetAll();

  $('export-features-btn').onclick = (): void => {
    const kept = currentKeptFeatures();
    if (kept.length === 0) return;
    downloadGeoJSON(featuresToGeoJSON(kept), `features-${Date.now()}.geojson`);
  };
  $('export-chunks-btn').onclick = (): void => {
    if (state.chunks.length === 0) return;
    downloadGeoJSON(chunksToGeoJSON(state.chunks), `chunk-status-${Date.now()}.geojson`);
  };

  $<HTMLInputElement>('feature-filter').oninput = (): void => renderFeatureList();

  renderLegend();
  $('crs-banner').textContent = '尚未读取 GetCapabilities';
}

function renderLegend(): void {
  $('legend').innerHTML = (Object.keys(STATE_LABELS) as ChunkRecord['state'][])
    .map(
      (s) =>
        `<li><span class="dot" style="background:${STATE_COLORS[s]}"></span>${STATE_LABELS[s]}</li>`,
    )
    .join('');
}

function renderBBox(): void {
  const el = $('bbox-readout');
  if (!state.selection) {
    el.textContent = '尚未选择区域';
    return;
  }
  const b = state.selection;
  el.textContent = `minX ${fmt(b.minX)} minY ${fmt(b.minY)}\nmaxX ${fmt(b.maxX)} maxY ${fmt(b.maxY)}`;
  el.style.whiteSpace = 'pre-line';
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('zh-CN');
}

function refreshStartEnabled(): void {
  btn('start-btn').disabled =
    !state.selection || (state.engine?.isRunning ?? false);
  btn('retry-btn').disabled =
    state.engine?.isRunning === true || retryableChunks(state.chunks).length === 0;
  btn('pause-btn').disabled = !(state.engine?.isRunning && !state.engine.isPaused);
  btn('resume-btn').disabled = !state.engine?.isPaused;
  btn('export-features-btn').disabled = currentKeptFeatures().length === 0;
  btn('export-chunks-btn').disabled = state.chunks.length === 0;
}

// ---------- 采集主流程 ----------
async function startRun(mode: 'fresh' | 'retry'): Promise<void> {
  hideMessage();
  const profile = state.profile;
  const forceWrong = $<HTMLInputElement>('force-wrong-axis').checked;
  profile.forceWrongAxisOrder = forceWrong;

  const client = new WfsClient();

  // 每次启动先读能力文档，拿到权威 CRS / 轴顺序声明
  try {
    const cap = await client.getCapabilities(profile.endpoint);
    state.crs = cap.crs;
    $('crs-banner').textContent =
      `CRS ${cap.crs.srsName} · 声明轴顺序 ${cap.crs.axisOrder.toUpperCase()}`;
  } catch (err) {
    showMessage('error', `GetCapabilities 失败，无法在轴顺序未知的情况下采集：${(err as Error).message}`);
    return;
  }

  let chunksToRun: ChunkRecord[];
  if (mode === 'fresh') {
    if (!state.selection) return;
    const sizeOpt = CHUNK_SIZE_OPTIONS[$<HTMLSelectElement>('chunk-size-select').selectedIndex];
    const plan = planChunks(state.selection, sizeOpt.width, sizeOpt.height);
    state.chunks = plan.chunks;
    mapController.renderChunks(state.chunks);
    state.merger = new FeatureMerger();
    state.merged = [];
    state.selectedFeatureId = null;
    chunksToRun = state.chunks;
  } else {
    chunksToRun = retryableChunks(state.chunks);
    if (chunksToRun.length === 0) {
      showMessage('info', '没有失败或被截断的分块，无需重采。');
      return;
    }
    // 重采复用既有 merger：新取回的要素（含新版本）并入同一条来源链
    state.merger ??= new FeatureMerger();
  }

  const engine = new CollectionEngine();
  state.engine = engine;
  renderChunkPanel();
  setOverlay('采集中… 可随时暂停');
  refreshStartEnabled();

  engine.run({
    chunks: chunksToRun,
    client,
    profile,
    crs: state.crs,
    concurrency: Number($<HTMLInputElement>('concurrency').value) || 2,
    merger: state.merger,
    events: {
      onChunkChange: () => {
        mapController.renderChunks(state.chunks);
        renderChunkPanel();
        refreshStartEnabled();
      },
      onFeatures: () => {
        state.merged = engine.merged.results();
        renderFeatureList();
        renderStats();
        refreshStartEnabled();
      },
      onLog: (level, message) => showMessage(level, message),
    },
  })
    .then(() => finishRun(engine))
    .catch((err: unknown) => {
      const msg =
        err instanceof AxisOrderError
          ? `轴顺序错误（已阻止请求）：${err.message}`
          : err instanceof WfsHttpError
            ? `服务错误：${err.message}`
            : `采集异常：${(err as Error).message}`;
      showMessage('error', msg);
      setOverlay(null);
      refreshStartEnabled();
    });
}

function finishRun(engine: CollectionEngine): void {
  state.merged = engine.merged.results();
  if (state.selection) {
    const { kept } = filterBySelection(state.merged, state.selection);
    state.merged = kept;
  }
  mapController.renderFeatures(state.merged, pickFeature);
  mapController.renderChunks(state.chunks);
  renderChunkPanel();
  renderFeatureList();
  renderStats();

  const summary = summarizeStates(state.chunks);
  const incomplete = summary.INCOMPLETE ?? 0;
  const failed = summary.FAILED ?? 0;
  const empty = summary.EMPTY_CONFIRMED ?? 0;
  const axisError = state.chunks.find((c) => c.errorCode === 'AXIS_ORDER_MISMATCH');
  if (axisError) {
    setOverlay(null);
    // 轴顺序错误必须保留明确、具体的报错，不被通用警告覆盖
    showMessage('error', `轴顺序校验失败，已阻止采集：${axisError.message}`);
  } else if (incomplete + failed > 0) {
    setOverlay(null);
    showMessage(
      'warn',
      `采集结束，但存在 ${failed} 个失败块、${incomplete} 个截断块（未采全，不能当作完整结果）。` +
        `另有 ${empty} 个块已确认无数据。可使用“只重采失败/截断块”补齐。`,
    );
  } else {
    setOverlay(null);
    showMessage('info', `采集完成：${state.merged.length} 个与选区相交的要素；${empty} 个分块确认无数据。`);
  }
  refreshStartEnabled();
}

function resetAll(): void {
  state.engine?.cancel();
  state.engine = null;
  state.chunks = [];
  state.merger = null;
  state.merged = [];
  state.selection = null;
  state.selectedFeatureId = null;
  mapController.clearFeatures();
  mapController.clearSelection();
  mapController.renderChunks([]);
  renderBBox();
  renderChunkPanel();
  renderFeatureList();
  renderStats();
  hideMessage();
  setOverlay(null);
  refreshStartEnabled();
}

// ---------- 结果与分块渲染 ----------
function currentKeptFeatures(): MergedFeature[] {
  if (!state.selection) return state.merged;
  return filterBySelection(state.merged, state.selection).kept;
}

function renderStats(): void {
  const kept = currentKeptFeatures();
  const summary = summarizeStates(state.chunks);
  const multiVersion = kept.filter((m) => m.versions.length > 1).length;
  const multiChunk = kept.filter((m) => m.observations.length > 1).length;
  const stats: [number, string][] = [
    [kept.length, '选区相交要素'],
    [multiChunk, '跨分块返回'],
    [multiVersion, '出现多版本'],
    [summary.INCOMPLETE ?? 0, '截断（未采全）'],
    [summary.FAILED ?? 0, '失败块'],
    [summary.EMPTY_CONFIRMED ?? 0, '确认无数据块'],
  ];
  $('stat-grid').innerHTML = stats
    .map(([num, lbl]) => `<div class="stat"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`)
    .join('');
}

function renderChunkPanel(): void {
  const summary = summarizeStates(state.chunks);
  $('chunk-summary').textContent =
    state.chunks.length === 0
      ? '尚未生成采集网格'
      : `共 ${state.chunks.length} 块｜` +
        (Object.entries(summary)
          .map(([k, v]) => `${STATE_LABELS[k as ChunkRecord['state']]} ${v}`)
          .join(' · '));

  $('chunk-list').innerHTML = state.chunks
    .map(
      (ch) => `
      <div class="chunk-item" data-chunk="${ch.id}">
        <div class="head">
          <span>#${ch.index} ${ch.id}</span>
          <span class="state-badge" style="background:${STATE_COLORS[ch.state]}">${STATE_LABELS[ch.state]}</span>
        </div>
        <div class="meta">第 ${ch.pagesDone} 页 · 取回 ${ch.featuresFetched} 条${
        ch.numberMatched !== null ? ` · 匹配 ${ch.numberMatched}` : ''
      } · 尝试 ${ch.attempts} 次</div>
        ${ch.message ? `<div class="msg">${escapeHtml(ch.message)}</div>` : ''}
      </div>`,
    )
    .join('');

  $('chunk-list').querySelectorAll<HTMLElement>('.chunk-item').forEach((el) => {
    el.onclick = (): void => {
      const ch = state.chunks.find((c) => c.id === el.dataset.chunk);
      if (ch) mapController.fitBBox(ch.bbox);
    };
  });
}

function renderFeatureList(): void {
  const keyword = $<HTMLInputElement>('feature-filter').value.trim().toLowerCase();
  const kept = currentKeptFeatures().filter((m) => {
    if (!keyword) return true;
    const name = String(m.feature.properties.name ?? '').toLowerCase();
    return name.includes(keyword) || m.stableId.toLowerCase().includes(keyword);
  });

  $('feature-list').innerHTML =
    kept.length === 0
      ? '<div class="hint" style="padding:12px">暂无要素</div>'
      : kept
          .map((m) => {
            const kind = String(m.feature.properties.kind ?? 'other');
            return `
            <div class="feature-item ${m.stableId === state.selectedFeatureId ? 'active' : ''}" data-id="${m.stableId}">
              <div class="title">
                <span>${escapeHtml(String(m.feature.properties.name ?? m.stableId))}</span>
                <span class="kind-tag">${escapeHtml(kind)}</span>
              </div>
              <div class="sub">${escapeHtml(m.stableId)} · v${m.selectedVersion} · ${m.observations.length} 次分块返回 · ${m.versions.length} 个版本</div>
            </div>`;
          })
          .join('');

  $('feature-list').querySelectorAll<HTMLElement>('.feature-item').forEach((el) => {
    el.onclick = (): void => {
      const f = state.merged.find((m) => m.stableId === el.dataset.id);
      if (f) pickFeature(f);
    };
  });
}

function pickFeature(feature: MergedFeature): void {
  state.selectedFeatureId = feature.stableId;
  renderFeatureList();
  const detail = $('feature-detail');
  $('detail-card').hidden = false;

  const versionChips = feature.versions
    .map(
      (v) =>
        `<span class="version-chip">v${v.version} × ${v.sources.length} 次返回</span>`,
    )
    .join('');

  detail.innerHTML = `
    <div class="detail-block">
      <strong>${escapeHtml(String(feature.feature.properties.name ?? feature.stableId))}</strong><br />
      稳定标识：<code>${escapeHtml(feature.stableId)}</code><br />
      选取版本：<strong>v${feature.selectedVersion}</strong><br />
      观测版本：${versionChips}
    </div>
    <div class="detail-block">
      <strong>版本选取依据</strong><br />${escapeHtml(feature.selectionReason)}
    </div>
    <div class="detail-block">
      <strong>经过哪些分块进入结果（${feature.observations.length} 次目击）</strong>
      <table class="obs-table">
        <thead><tr><th>分块</th><th>页</th><th>版本</th><th>来源端点</th><th>时间</th></tr></thead>
        <tbody>
          ${feature.observations
            .map(
              (o) => `<tr>
                <td>#${o.chunkIndex} (${o.chunkId})</td>
                <td>${o.page}</td>
                <td>v${o.version}</td>
                <td><code>${escapeHtml(o.endpoint)}</code></td>
                <td>${new Date(o.fetchedAt).toLocaleTimeString('zh-CN')}</td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>`;

  mapController.highlightObservedChunks(feature.observations, state.chunks);
  const b = bboxOfFeature(feature);
  if (b) mapController.fitBBox(b);
}

function bboxOfFeature(m: MergedFeature): BBox | null {
  const g = m.feature.geometry;
  let flat: number[][] = [];
  if (g.type === 'Point') {
    flat = [g.coordinates as number[]];
  } else if (g.type === 'LineString') {
    flat = g.coordinates as number[][];
  } else if (g.type === 'Polygon') {
    flat = (g.coordinates as number[][][]).flat();
  } else if (g.type === 'MultiLineString') {
    flat = (g.coordinates as number[][][]).flat();
  } else if (g.type === 'MultiPolygon') {
    flat = (g.coordinates as number[][][][]).flat(2);
  } else if (g.type === 'MultiPoint') {
    flat = g.coordinates as number[][];
  }
  if (flat.length === 0) return null;
  const xs = flat.map((p) => p[0]);
  const ys = flat.map((p) => p[1]);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

// ---------- 小工具 ----------
function showMessage(level: 'error' | 'warn' | 'info', text: string): void {
  const el = $('global-message');
  el.hidden = false;
  el.className = `global-message ${level}`;
  el.textContent = text;
}

function hideMessage(): void {
  $('global-message').hidden = true;
}

function setOverlay(text: string | null): void {
  const el = $('map-overlay');
  if (text === null) {
    el.hidden = true;
  } else {
    el.hidden = false;
    el.textContent = text;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  );
}

// 避免 Leaflet 默认图标路径在打包后 404（本项目未用默认 marker，保留兜底）
L.Icon.Default.imagePath = 'https://unpkg.com/leaflet@1.9.4/dist/images/';

initControls();
renderChunkPanel();
renderStats();
