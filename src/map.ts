import L from 'leaflet';
import type { BBox, ChunkRecord, MergedFeature } from '@/types';
import type { FeatureObservation } from '@/types';

/** 分块状态 → 填充色（与 UI 图例保持一致） */
export const STATE_COLORS: Record<ChunkRecord['state'], string> = {
  PENDING: '#9aa5b1',
  RUNNING: '#2f80ed',
  DONE_COMPLETE: '#27ae60',
  EMPTY_CONFIRMED: '#14b8a6',
  INCOMPLETE: '#f2994a',
  FAILED: '#eb5757',
  PAUSED: '#9b51e0',
};

export const STATE_LABELS: Record<ChunkRecord['state'], string> = {
  PENDING: '待采集',
  RUNNING: '采集中',
  DONE_COMPLETE: '已采全',
  EMPTY_CONFIRMED: '确认无数据',
  INCOMPLETE: '未采全（截断）',
  FAILED: '失败',
  PAUSED: '已暂停',
};

const KIND_STYLE: Record<string, L.PathOptions & { radius?: number }> = {
  road: { color: '#1d4ed8', weight: 4, opacity: 0.9 },
  facility: { color: '#d97706', weight: 2, fillOpacity: 0.18, opacity: 0.9 },
  poi: { color: '#7c3aed', weight: 2, fillOpacity: 0.7, opacity: 0.95, radius: 4 },
};

/** Leaflet 默认用 EPSG:3857，本项目数据也是 3857，坐标可直接使用 */
export class MapController {
  readonly map: L.Map;
  private chunkLayer = L.layerGroup();
  private featureLayer = L.layerGroup();
  private selectionRect: L.Rectangle | null = null;
  private dragStart: L.Point | null = null;
  private dragRect: L.Rectangle | null = null;
  private onSelectionChange?: (bbox: BBox) => void;
  /** 矩形图层 → 分块记录，避免用坐标反查分块 */
  private chunkRects = new WeakMap<L.Rectangle, ChunkRecord>();

  constructor(div: HTMLElement) {
    this.map = L.map(div, {
      center: [0, 0],
      zoom: 1,
      preferCanvas: true,
      worldCopyJump: false,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 22,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(this.map);
    this.chunkLayer.addTo(this.map);
    this.featureLayer.addTo(this.map);
    this.map.on('mousedown', this.handleMouseDown);
    this.map.on('mousemove', this.handleMouseMove);
    this.map.on('mouseup', this.handleMouseUp);
  }

  setSelectionHandler(fn: (bbox: BBox) => void): void {
    this.onSelectionChange = fn;
  }

  fitBBox(box: BBox): void {
    this.map.fitBounds(
      L.latLngBounds(
        this.toLatLng(box.minX, box.minY),
        this.toLatLng(box.maxX, box.maxY),
      ),
    );
  }

  private toLatLng(x: number, y: number): [number, number] {
    // 3857 坐标 → 经纬度
    const lat = (Math.atan(Math.exp(y / 6378137)) * 180) / Math.PI - 90;
    const lng = (x / 6378137) * (180 / Math.PI);
    return [lat, lng];
  }

  private toXY(latlng: L.LatLng): [number, number] {
    const x = (latlng.lng * Math.PI) / 180 * 6378137;
    const y =
      Math.log(Math.tan(((latlng.lat + 90) * Math.PI) / 360)) * 6378137;
    return [x, y];
  }

  // ---- 框选（按住鼠标拖出矩形） ----
  private handleMouseDown = (e: L.LeafletMouseEvent): void => {
    // 避免在已有矢量要素上拖拽时误触发
    if ((e.originalEvent.target as HTMLElement).tagName === 'PATH') return;
    this.dragStart = this.map.latLngToContainerPoint(e.latlng);
    this.dragRect?.remove();
    this.dragRect = L.rectangle(L.latLngBounds(e.latlng, e.latlng), {
      color: '#111827',
      weight: 1.5,
      dashArray: '6 4',
      fillOpacity: 0.08,
    }).addTo(this.map);
  };

  private handleMouseMove = (e: L.LeafletMouseEvent): void => {
    if (!this.dragStart || !this.dragRect) return;
    const startLatLng = this.map.containerPointToLatLng(this.dragStart);
    this.dragRect.setBounds(L.latLngBounds(startLatLng, e.latlng));
  };

  private handleMouseUp = (e: L.LeafletMouseEvent): void => {
    if (!this.dragStart || !this.dragRect) return;
    const startLatLng = this.map.containerPointToLatLng(this.dragStart);
    const endLatLng = e.latlng;
    const [x1, y1] = this.toXY(startLatLng);
    const [x2, y2] = this.toXY(endLatLng);
    this.dragRect.remove();
    this.dragRect = null;
    this.dragStart = null;
    const bbox: BBox = {
      minX: Math.min(x1, x2),
      minY: Math.min(y1, y2),
      maxX: Math.max(x1, x2),
      maxY: Math.max(y1, y2),
    };
    if (bbox.maxX - bbox.minX < 50 || bbox.maxY - bbox.minY < 50) return;
    this.setSelection(bbox);
    this.onSelectionChange?.(bbox);
  };

  setSelection(bbox: BBox): void {
    this.selectionRect?.remove();
    this.selectionRect = L.rectangle(
      [
        this.toLatLng(bbox.minX, bbox.minY),
        this.toLatLng(bbox.maxX, bbox.maxY),
      ],
      { color: '#111827', weight: 2, fillColor: '#111827', fillOpacity: 0.05 },
    ).addTo(this.map);
  }

  getSelection(): BBox | null {
    if (!this.selectionRect) return null;
    const b = this.selectionRect.getBounds();
    const [x1, y1] = this.toXY(b.getSouthWest());
    const [x2, y2] = this.toXY(b.getNorthEast());
    return { minX: x1, minY: y1, maxX: x2, maxY: y2 };
  }

  clearSelection(): void {
    this.selectionRect?.remove();
    this.selectionRect = null;
  }

  // ---- 分块网格 ----
  renderChunks(chunks: ChunkRecord[]): void {
    this.chunkLayer.clearLayers();
    for (const ch of chunks) {
      const color = STATE_COLORS[ch.state];
      const rect = L.rectangle(
        L.latLngBounds(
          this.toLatLng(ch.bbox.minX, ch.bbox.minY),
          this.toLatLng(ch.bbox.maxX, ch.bbox.maxY),
        ),
        {
          color: '#374151',
          weight: 1,
          fillColor: color,
          fillOpacity: ch.state === 'PENDING' ? 0.08 : 0.28,
        },
      );
      this.chunkRects.set(rect, ch);
      rect.bindTooltip(
        `<b>#${ch.index} ${STATE_LABELS[ch.state]}</b><br>` +
          `页数 ${ch.pagesDone}｜取回 ${ch.featuresFetched}` +
          (ch.numberMatched !== null ? `｜匹配 ${ch.numberMatched}` : '') +
          (ch.message ? `<br><span style="color:#fca5a5">${escapeHtml(ch.message)}</span>` : ''),
        { sticky: true },
      );
      rect.addTo(this.chunkLayer);
    }
  }

  // ---- 要素图层 ----
  renderFeatures(features: MergedFeature[], onPick: (f: MergedFeature) => void): void {
    this.featureLayer.clearLayers();
    for (const merged of features) {
      const kind = String(merged.feature.properties.kind ?? 'other');
      const style = KIND_STYLE[kind] ?? { color: '#374151', weight: 2 };
      const layer = this.geoJsonLayer(merged, style);
      if (!layer) continue;
      layer.bindTooltip(
        `<b>${escapeHtml(String(merged.feature.properties.name ?? merged.stableId))}</b><br>` +
          `${escapeHtml(merged.stableId)}｜v${merged.selectedVersion}｜经 ${merged.observations.length} 次分块返回`,
        { sticky: true },
      );
      layer.on('click', () => onPick(merged));
      layer.addTo(this.featureLayer);
    }
  }

  private geoJsonLayer(
    merged: MergedFeature,
    style: L.PathOptions & { radius?: number },
  ): L.Layer | null {
    const g = merged.feature.geometry;
    const ll = (p: unknown): [number, number] =>
      this.toLatLng((p as number[])[0], (p as number[])[1]);
    if (g.type === 'LineString') {
      return L.polyline((g.coordinates as number[][]).map(ll), style);
    }
    if (g.type === 'MultiLineString') {
      return L.polyline(
        (g.coordinates as number[][][]).map((line) => line.map(ll)),
        style,
      );
    }
    if (g.type === 'Polygon') {
      const rings = g.coordinates as number[][][];
      return L.polygon(rings.map((ring) => ring.map(ll)), style);
    }
    if (g.type === 'MultiPolygon') {
      const polys = (g.coordinates as number[][][][]).map((poly) =>
        poly.map((ring) => ring.map(ll)),
      );
      return L.polygon(polys.flat(), style);
    }
    if (g.type === 'Point') {
      return L.circleMarker(ll(g.coordinates), { ...style, radius: 4 });
    }
    if (g.type === 'MultiPoint') {
      return L.layerGroup(
        (g.coordinates as number[][]).map((p) => L.circleMarker(ll(p), { ...style, radius: 4 })),
      );
    }
    return null;
  }

  /** 在地图上高亮某要素经过的分块（直接用矩形持有的分块引用，不做坐标反查） */
  highlightObservedChunks(observations: FeatureObservation[], chunks: ChunkRecord[]): void {
    this.renderChunks(chunks); // 先复位并重建矩形→分块映射
    const ids = new Set(observations.map((o) => o.chunkId));
    this.chunkLayer.eachLayer((layer) => {
      const rect = layer as L.Rectangle;
      const ch = this.chunkRects.get(rect);
      if (ch && ids.has(ch.id)) {
        rect.setStyle({ weight: 3, color: '#facc15', fillOpacity: 0.5 });
      }
    });
  }

  clearFeatures(): void {
    this.featureLayer.clearLayers();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  );
}
