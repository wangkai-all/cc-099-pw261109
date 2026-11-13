import type { ChunkRecord, MergedFeature } from '@/types';

/** 导出要素集合为标准 FeatureCollection，来源链完整挂在 properties 上 */
export function featuresToGeoJSON(features: MergedFeature[]): GeoJSONFeatureCollection {
  return {
    type: 'FeatureCollection',
    name: 'pointwise-delivery-export',
    exportedAt: new Date().toISOString(),
    features: features.map((m) => ({
      type: 'Feature' as const,
      id: m.stableId,
      geometry: m.feature.geometry,
      properties: {
        ...m.feature.properties,
        stableId: m.stableId,
        selectedVersion: m.selectedVersion,
        selectionReason: m.selectionReason,
        observations: m.observations,
        versions: m.versions,
      },
    })),
  };
}

/** 分块采集状态单独导出，用来区分“未采到”与“确认无数据” */
export function chunksToGeoJSON(chunks: ChunkRecord[]): GeoJSONFeatureCollection {
  return {
    type: 'FeatureCollection',
    name: 'pointwise-delivery-chunk-status',
    exportedAt: new Date().toISOString(),
    features: chunks.map((ch) => ({
      type: 'Feature' as const,
      id: ch.id,
      geometry: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [ch.bbox.minX, ch.bbox.minY],
            [ch.bbox.maxX, ch.bbox.minY],
            [ch.bbox.maxX, ch.bbox.maxY],
            [ch.bbox.minX, ch.bbox.maxY],
            [ch.bbox.minX, ch.bbox.minY],
          ],
        ],
      },
      properties: {
        chunkIndex: ch.index,
        state: ch.state,
        pagesDone: ch.pagesDone,
        featuresFetched: ch.featuresFetched,
        numberMatched: ch.numberMatched,
        attempts: ch.attempts,
        message: ch.message ?? null,
      },
    })),
  };
}

export interface GeoJSONFeatureCollection {
  type: 'FeatureCollection';
  name: string;
  exportedAt: string;
  features: unknown[];
}

export function downloadGeoJSON(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/geo+json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
