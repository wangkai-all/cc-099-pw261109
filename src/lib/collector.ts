import type {
  ChunkRecord,
  CrsInfo,
  FeatureObservation,
  ServiceProfile,
  WfsFeature,
} from '@/types';
import { assessPageCompleteness, FeatureMerger } from '@/lib/merge';
import { WfsClient, WfsHttpError } from '@/lib/wfsClient';
import { AxisOrderError } from '@/lib/axisOrder';

export interface CollectorEvents {
  onChunkChange?: (chunk: ChunkRecord) => void;
  onFeatures?: (args: {
    chunk: ChunkRecord;
    page: number;
    features: WfsFeature[];
  }) => void;
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface RunOptions {
  chunks: ChunkRecord[];
  client: WfsClient;
  profile: ServiceProfile;
  crs: CrsInfo;
  concurrency?: number;
  /** 安全保险丝：单块最多翻多少页，防止坏服务造成死循环 */
  maxPagesPerChunk?: number;
  /** 跨运行复用的合并器（重采失败块时保留此前已合并要素与来源链） */
  merger?: FeatureMerger;
  events?: CollectorEvents;
}

/**
 * 采集编排引擎。
 *
 * 暂停语义（门控式，不中断在途请求）：
 *  - pause() 仅置位，当前页请求正常结束，引擎在“取下一块 / 翻下一页”之前挂起，
 *    被挂起的块标记为 PAUSED；resume() 放行。run() 的 Promise 在暂停期间保持 pending，
 *    因此不会出现“恢复后没有工作者重新接管该块”的问题。
 *  - cancel() 用于重置：真正 abort 在途请求并令工作者退出。
 */
export class CollectionEngine {
  private paused = false;
  private cancelled = false;
  private abortController: AbortController | null = null;
  private resumeWaiters: (() => void)[] = [];
  private merger!: FeatureMerger;
  private running = false;

  get isPaused(): boolean {
    return this.paused;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get merged(): FeatureMerger {
    return this.merger;
  }

  pause(): void {
    if (!this.running) return;
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    for (const w of this.resumeWaiters.splice(0)) w();
  }

  cancel(): void {
    this.cancelled = true;
    this.paused = false;
    this.abortController?.abort();
    for (const w of this.resumeWaiters.splice(0)) w();
  }

  /** 挂起检查点：暂停状态下 resolve 前一直等待，并同步块状态 */
  private async gate(chunk?: ChunkRecord, events?: CollectorEvents): Promise<void> {
    if (!this.paused) return;
    if (chunk) {
      chunk.state = 'PAUSED';
      events?.onChunkChange?.(chunk);
    }
    await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
    if (chunk && !this.cancelled) {
      chunk.state = 'RUNNING';
      events?.onChunkChange?.(chunk);
    }
  }

  async run(opts: RunOptions): Promise<void> {
    if (this.running) throw new Error('采集任务已在运行中');
    this.running = true;
    this.paused = false;
    this.cancelled = false;
    this.abortController = new AbortController();
    this.merger = opts.merger ?? new FeatureMerger();

    const concurrency = Math.max(1, opts.concurrency ?? 2);
    const maxPages = opts.maxPagesPerChunk ?? 200;
    const queue = [...opts.chunks];

    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        if (this.cancelled) return;
        const chunk = queue.shift();
        if (!chunk) return;
        // 暂停检查统一放在 processChunk 的页循环 gate 内：
        // 这样即使在“块之间”暂停，下一块被取到后也会立即标记为 PAUSED，
        // 不会出现工作者挂起却没有任何块呈现 PAUSED 状态的窗口。
        await this.processChunk(chunk, opts, maxPages);
      }
    };

    try {
      await Promise.all(
        Array.from({ length: concurrency }, () => worker()),
      );
    } finally {
      this.running = false;
      this.abortController = null;
    }
  }

  private async processChunk(
    chunk: ChunkRecord,
    opts: RunOptions,
    maxPages: number,
  ): Promise<void> {
    const { client, profile, crs, events } = opts;
    chunk.attempts += 1;
    chunk.state = 'RUNNING';
    chunk.message = undefined;
    chunk.errorCode = undefined;
    chunk.pagesDone = 0;
    chunk.featuresFetched = 0;
    chunk.numberMatched = null;
    events?.onChunkChange?.(chunk);

    let startIndex = 0;
    let page = 0;
    let truncated = false;
    let truncateReason = '';

    try {
      while (page < maxPages) {
        await this.gate(chunk, events);
        if (this.cancelled) return;

        page += 1;
        const wfsPage = await client.getPage({
          endpoint: profile.endpoint,
          typeName: profile.typeNames[0],
          bbox: chunk.bbox,
          crs,
          requestAxisOrder: profile.expectedAxisOrder,
          profileExpected: profile.expectedAxisOrder,
          count: profile.pageSize,
          startIndex,
          forceWrongAxisOrder: profile.forceWrongAxisOrder,
          signal: this.abortController?.signal,
        });

        wfsPage.meta.hitLimit = wfsPage.meta.numberReturned === profile.pageSize;
        const assessment = assessPageCompleteness(wfsPage.meta);

        if (wfsPage.meta.numberMatched !== null) {
          chunk.numberMatched = wfsPage.meta.numberMatched;
        }
        chunk.pagesDone = page;
        chunk.featuresFetched += wfsPage.features.length;
        events?.onChunkChange?.(chunk);

        if (wfsPage.features.length > 0) {
          const fetchedAt = new Date().toISOString();
          for (const f of wfsPage.features) {
            const observation: FeatureObservation = {
              chunkId: chunk.id,
              chunkIndex: chunk.index,
              page,
              version: Number(f.properties?.version ?? 1),
              endpoint: profile.endpoint,
              fetchedAt,
            };
            this.merger.add({ feature: f, observation });
          }
          events?.onFeatures?.({ chunk, page, features: wfsPage.features });
        }

        // 首页即空：服务确认该范围内无要素（与“还没采到”严格区分）
        if (page === 1 && wfsPage.features.length === 0) {
          chunk.state = 'EMPTY_CONFIRMED';
          chunk.message = '服务确认该范围内无要素';
          events?.onChunkChange?.(chunk);
          return;
        }

        const hasReliableNext =
          wfsPage.meta.nextUrl !== undefined ||
          (wfsPage.meta.nextIndex !== null &&
            wfsPage.meta.numberMatched !== null &&
            wfsPage.meta.nextIndex < wfsPage.meta.numberMatched);

        if (wfsPage.meta.hitLimit && !hasReliableNext) {
          // 核心安全规则：命中上限又没有可靠下一页，绝不能当成采全
          truncated = true;
          truncateReason = assessment.reason;
          break;
        }

        if (!wfsPage.meta.hitLimit) {
          chunk.state = 'DONE_COMPLETE';
          chunk.message = `共 ${page} 页，取回 ${chunk.featuresFetched} 条`;
          events?.onChunkChange?.(chunk);
          return;
        }

        startIndex = wfsPage.meta.nextIndex ?? startIndex + profile.pageSize;
      }

      if (page >= maxPages && !truncated) {
        truncated = true;
        truncateReason = `达到单块页数保险丝 ${maxPages}，强制停止`;
      }

      chunk.state = 'INCOMPLETE';
      chunk.message = truncateReason;
      chunk.errorCode = 'TRUNCATED';
      events?.onLog?.('warn', `块 ${chunk.id} 未采全：${truncateReason}`);
      events?.onChunkChange?.(chunk);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // cancel 路径：静默退出，块状态由上层重置流程处理
        return;
      }
      chunk.state = 'FAILED';
      if (err instanceof AxisOrderError) {
        chunk.errorCode = 'AXIS_ORDER_MISMATCH';
        chunk.message = err.message;
      } else if (err instanceof WfsHttpError) {
        chunk.errorCode = err.code ?? `HTTP_${err.status}`;
        chunk.message = err.message;
      } else {
        chunk.errorCode = 'UNKNOWN';
        chunk.message = (err as Error).message;
      }
      events?.onLog?.('error', `块 ${chunk.id} 失败：${chunk.message}`);
      events?.onChunkChange?.(chunk);
    }
  }
}
