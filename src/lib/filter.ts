import type { BBox, MergedFeature } from '@/types';
import { geometryIntersectsBBox } from '@/lib/geometry';

/**
 * 最终结果过滤：只保留与“原始选区”真正相交的要素。
 * 分块查询会因 BBox 相交语义带回只与邻块相交、但不与整体选区相交的对象，
 * 必须在这里统一剔除，而不是信任服务端的空间过滤结果。
 */
export function filterBySelection(
  merged: MergedFeature[],
  selection: BBox,
): { kept: MergedFeature[]; dropped: MergedFeature[] } {
  const kept: MergedFeature[] = [];
  const dropped: MergedFeature[] = [];
  for (const m of merged) {
    const hit = geometryIntersectsBBox(m.feature.geometry, selection);
    const marked: MergedFeature = { ...m, intersectsSelection: hit };
    (hit ? kept : dropped).push(marked);
  }
  return { kept, dropped };
}
