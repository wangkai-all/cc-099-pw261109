import type {
  FeatureObservation,
  MergedFeature,
  WfsFeature,
  WfsPageMeta,
} from '@/types';

/**
 * 稳定要素标识：优先 properties.featureCode，回退到要素 id。
 * 跨块重复返回的同一道路/设施必须靠这个标识合并，不能按坐标比较。
 */
export function stableIdOf(feature: WfsFeature): string {
  return String(feature.properties?.featureCode ?? feature.id);
}

export interface MergeInput {
  feature: WfsFeature;
  observation: FeatureObservation;
}

interface Accumulator {
  stableId: string;
  /** version -> 该版本下选取的代表要素 + 来源列表 */
  byVersion: Map<
    number,
    { representative: WfsFeature; sources: FeatureObservation[] }
  >;
  allObservations: FeatureObservation[];
}

/**
 * 把分页/分块流式取回的要素按稳定标识合并。
 * 同一标识出现不同版本时：
 *  - 全部版本与各自来源都保留在 versions 中；
 *  - 代表要素取版本号最大者（版本相同时取首次出现，保证确定性）；
 *  - 选取依据写入 selectionReason。
 */
export class FeatureMerger {
  private map = new Map<string, Accumulator>();

  add(input: MergeInput): void {
    const { feature, observation } = input;
    const stableId = stableIdOf(feature);
    const version = Number(feature.properties?.version ?? 1);

    let acc = this.map.get(stableId);
    if (!acc) {
      acc = { stableId, byVersion: new Map(), allObservations: [] };
      this.map.set(stableId, acc);
    }
    acc.allObservations.push(observation);

    const slot = acc.byVersion.get(version);
    if (!slot) {
      acc.byVersion.set(version, {
        representative: feature,
        sources: [observation],
      });
    } else {
      slot.sources.push(observation);
    }
  }

  addMany(items: MergeInput[]): void {
    for (const it of items) this.add(it);
  }

  results(): MergedFeature[] {
    const out: MergedFeature[] = [];
    for (const acc of this.map.values()) {
      const versionNumbers = [...acc.byVersion.keys()].sort((a, b) => a - b);
      const newest = versionNumbers[versionNumbers.length - 1];
      const chosen = acc.byVersion.get(newest)!;

      const sameVersionCount = chosen.sources.length;
      const selectionReason =
        versionNumbers.length > 1
          ? `存在 ${versionNumbers.length} 个版本 [${versionNumbers.join(', ')}]，按最高版本号选取 v${newest}；该版本在 ${sameVersionCount} 个分块/页中返回，取首次出现的几何`
          : `仅观测到 v${newest}，来自 ${sameVersionCount} 个分块/页，几何取首次出现值`;

      out.push({
        stableId: acc.stableId,
        feature: chosen.representative,
        selectedVersion: newest,
        selectionReason,
        observations: [...acc.allObservations].sort(compareObs),
        versions: versionNumbers.map((v) => ({
          version: v,
          sources: [...acc.byVersion.get(v)!.sources].sort(compareObs),
        })),
        intersectsSelection: false,
      });
    }
    return out.sort((a, b) => a.stableId.localeCompare(b.stableId));
  }

  get size(): number {
    return this.map.size;
  }
}

function compareObs(a: FeatureObservation, b: FeatureObservation): number {
  if (a.chunkIndex !== b.chunkIndex) return a.chunkIndex - b.chunkIndex;
  return a.page - b.page;
}

/**
 * 截断判定（核心安全规则）：
 * 本页命中 count 上限，且拿不到“可靠的下一页信息”时，必须判为未采全。
 * 可靠下一页定义（满足其一）：
 *  1) 服务显式给出 nextUrl；
 *  2) nextIndex 为数字且 numberMatched 已知、nextIndex < numberMatched。
 * 注意：仅凭 nextIndex 递增而 numberMatched 未知时不算可靠——
 * 模拟服务的“坏端点”正是利用这一点制造假分页。
 */
export function assessPageCompleteness(
  meta: WfsPageMeta,
): { complete: boolean; reason: string } {
  if (!meta.hitLimit) {
    return { complete: true, reason: '本页返回数小于上限，服务端已无更多数据' };
  }
  if (meta.nextUrl) {
    return { complete: false, reason: '命中上限且存在 next 链接，继续翻页即可' };
  }
  if (
    meta.nextIndex !== null &&
    meta.numberMatched !== null &&
    meta.nextIndex < meta.numberMatched
  ) {
    return {
      complete: false,
      reason: `命中上限，nextIndex=${meta.nextIndex} 小于总数 ${meta.numberMatched}，继续翻页`,
    };
  }
  return {
    complete: false,
    reason:
      meta.numberMatched === null
        ? '返回数恰好等于上限且服务未给出总数/下一页链接，无法确认是否还有数据——按未采全处理'
        : `返回数等于上限但 nextIndex(${meta.nextIndex}) 已不小于总数(${meta.numberMatched})，分页信息自相矛盾，按未采全处理`,
  };
}
