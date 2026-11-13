import type { BBox, ChunkRecord } from '@/types';

export interface GridPlan {
  cols: number;
  rows: number;
  chunks: ChunkRecord[];
}

/**
 * 把选区按目标块尺寸切成规则网格。
 * 边缘块用实际剩余宽高，避免出现零宽/零高块；行列数至少为 1。
 */
export function planChunks(
  selection: BBox,
  targetChunkWidth: number,
  targetChunkHeight: number,
): GridPlan {
  const width = selection.maxX - selection.minX;
  const height = selection.maxY - selection.minY;
  if (width <= 0 || height <= 0) {
    throw new Error('选区宽高必须为正数');
  }
  if (targetChunkWidth <= 0 || targetChunkHeight <= 0) {
    throw new Error('分块尺寸必须为正数');
  }

  const cols = Math.max(1, Math.ceil(width / targetChunkWidth));
  const rows = Math.max(1, Math.ceil(height / targetChunkHeight));
  const cellW = width / cols;
  const cellH = height / rows;

  const chunks: ChunkRecord[] = [];
  let index = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const minX = selection.minX + c * cellW;
      const maxX = c === cols - 1 ? selection.maxX : minX + cellW;
      // y 轴从北向南编号，与地图直觉一致
      const maxY = selection.maxY - r * cellH;
      const minY = r === rows - 1 ? selection.minY : maxY - cellH;
      chunks.push({
        id: `chunk-${r}-${c}`,
        index,
        bbox: { minX, minY, maxX, maxY },
        state: 'PENDING',
        pagesDone: 0,
        featuresFetched: 0,
        numberMatched: null,
        attempts: 0,
      });
      index++;
    }
  }
  return { cols, rows, chunks };
}

export function summarizeStates(chunks: ChunkRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const ch of chunks) {
    out[ch.state] = (out[ch.state] ?? 0) + 1;
  }
  return out;
}

/** 可重采的块：失败或被截断（INCOMPLETE 本质上也是未采全） */
export function retryableChunks(chunks: ChunkRecord[]): ChunkRecord[] {
  return chunks.filter(
    (ch) => ch.state === 'FAILED' || ch.state === 'INCOMPLETE',
  );
}
