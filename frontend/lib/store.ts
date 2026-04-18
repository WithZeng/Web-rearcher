import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { PipelineMessage, MetaResponse, SearchStats } from './api';
import { resolveApiUrl } from './backend';

interface StageData {
  papers_found?: number;
  papers_passed?: number;
  rows_extracted?: number;
  search_stats?: SearchStats;
}

interface PipelineState {
  taskId: string | null;
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled' | string;
  queuePosition: number | null;
  running: boolean;
  progress: number;
  currentStage: string;
  stageMessage: string;
  activityText: string;
  stageData: StageData;
  rows: Record<string, unknown>[];
  stats: { total: number; fulltext_rate: number; avg_quality: number } | null;
  error: string | null;
  startedAt: number | null;
}

export interface SearchParams {
  query: string;
  selectedDbs: string[];
  limit: number;
  targetPassedCount: number | null;
  mode: 'multi' | 'single';
  usePlanner: boolean;
  fetchConcurrency: number;
  llmConcurrency: number;
}

interface AppStore {
  meta: MetaResponse | null;
  setMeta: (meta: MetaResponse) => void;

  searchParams: SearchParams;
  setSearchParam: <K extends keyof SearchParams>(key: K, value: SearchParams[K]) => void;
  setSearchParams: (params: Partial<SearchParams>) => void;

  pipeline: PipelineState;
  setPipelineField: <K extends keyof PipelineState>(
    key: K,
    value: PipelineState[K],
  ) => void;
  resetPipeline: () => void;
  handlePipelineMessage: (msg: PipelineMessage) => void;
}

type PersistedPipelineState = Pick<
  PipelineState,
  'taskId' | 'state' | 'queuePosition' | 'progress' | 'currentStage' | 'stageData' | 'rows' | 'stats'
>;

type PersistedAppStore = Partial<Pick<AppStore, 'searchParams'>> & {
  pipeline?: Partial<PersistedPipelineState>;
};

const defaultSearchParams: SearchParams = {
  query: '',
  selectedDbs: [],
  limit: 50,
  targetPassedCount: null,
  mode: 'multi',
  usePlanner: true,
  fetchConcurrency: 15,
  llmConcurrency: 5,
};

function createInitialPipeline(): PipelineState {
  return {
    taskId: null,
    state: '',
    queuePosition: null,
    running: false,
    progress: 0,
    currentStage: '',
    stageMessage: '',
    activityText: '',
    stageData: {},
    rows: [],
    stats: null,
    error: null,
    startedAt: null,
  };
}

function createPersistedPipelineSnapshot(pipeline: PipelineState): PersistedPipelineState {
  return {
    taskId: pipeline.taskId,
    state: pipeline.state,
    queuePosition: pipeline.queuePosition,
    progress: pipeline.progress,
    currentStage: pipeline.currentStage,
    stageData: pipeline.stageData,
    rows: pipeline.rows,
    stats: pipeline.stats,
  };
}

function rehydratePipeline(persistedPipeline?: Partial<PersistedPipelineState>): PipelineState {
  const initialPipeline = createInitialPipeline();

  return {
    ...initialPipeline,
    ...persistedPipeline,
    stageData: {
      ...initialPipeline.stageData,
      ...persistedPipeline?.stageData,
    },
    rows: Array.isArray(persistedPipeline?.rows) ? persistedPipeline.rows : initialPipeline.rows,
    stats: persistedPipeline?.stats ?? initialPipeline.stats,
    taskId: typeof persistedPipeline?.taskId === 'string' ? persistedPipeline.taskId : null,
    state: typeof persistedPipeline?.state === 'string' ? persistedPipeline.state : initialPipeline.state,
    queuePosition:
      typeof persistedPipeline?.queuePosition === 'number' ? persistedPipeline.queuePosition : initialPipeline.queuePosition,
    progress:
      typeof persistedPipeline?.progress === 'number' ? persistedPipeline.progress : initialPipeline.progress,
    currentStage:
      typeof persistedPipeline?.currentStage === 'string'
        ? persistedPipeline.currentStage
        : initialPipeline.currentStage,
    running: false,
    stageMessage: '',
    activityText: '',
    error: null,
    startedAt: null,
  };
}

function mergePersistedState(
  persistedState: unknown,
  currentState: AppStore,
): AppStore {
  const typedPersistedState = persistedState as PersistedAppStore | undefined;

  return {
    ...currentState,
    ...typedPersistedState,
    searchParams: {
      ...currentState.searchParams,
      ...typedPersistedState?.searchParams,
    },
    pipeline: rehydratePipeline(typedPersistedState?.pipeline),
  };
}

async function fetchResults(taskId: string): Promise<Record<string, unknown>[]> {
  try {
    const res = await fetch(resolveApiUrl(`/api/pipeline/result/${taskId}`));
    if (!res.ok) return [];
    const data = await res.json();
    return data.rows ?? [];
  } catch {
    return [];
  }
}

function buildPipelineStats(rows: Record<string, unknown>[]) {
  const qualities = rows
    .map((r) => Number(r._data_quality))
    .filter((v) => !isNaN(v));
  const avgQuality = qualities.length
    ? qualities.reduce((a, b) => a + b, 0) / qualities.length
    : 0;
  const fulltextCount = rows.filter(
    (r) => r.text_source && r.text_source !== 'none' && r.text_source !== 'abstract',
  ).length;

  return {
    total: rows.length,
    avg_quality: avgQuality,
    fulltext_rate: rows.length ? fulltextCount / rows.length : 0,
  };
}

function toEpochMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const value = new Date(iso).getTime();
  return Number.isNaN(value) ? null : value;
}

function stateFromStage(stage: string | undefined): PipelineState['state'] | null {
  if (!stage) return null;
  if (stage === 'queued') return 'queued';
  if (stage === 'done') return 'done';
  if (stage === 'error') return 'error';
  return 'running';
}

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      meta: null,
      setMeta: (meta) => set({ meta }),

      searchParams: { ...defaultSearchParams },
      setSearchParam: (key, value) =>
        set((state) => ({
          searchParams: { ...state.searchParams, [key]: value },
        })),
      setSearchParams: (params) =>
        set((state) => ({
          searchParams: { ...state.searchParams, ...params },
        })),

      pipeline: createInitialPipeline(),
      setPipelineField: (key, value) =>
        set((state) => ({ pipeline: { ...state.pipeline, [key]: value } })),
      resetPipeline: () => set({ pipeline: createInitialPipeline() }),
      handlePipelineMessage: (msg) => {
        if (msg.type === 'activity') {
          set((state) => ({
            pipeline: {
              ...state.pipeline,
              activityText: msg.activityText ?? '',
            },
          }));
          return;
        }

        if (msg.type === 'complete') {
          const taskId = get().pipeline.taskId;
          set((state) => ({
            pipeline: {
              ...state.pipeline,
              state: 'done',
              queuePosition: null,
              running: false,
              progress: 1,
              currentStage: 'done',
              stageMessage: 'Pipeline complete',
              activityText: '',
              error: null,
            },
          }));

          if (taskId) {
            fetchResults(taskId).then((rows) => {
              set((state) => ({
                pipeline: {
                  ...state.pipeline,
                  rows,
                  stats: buildPipelineStats(rows),
                },
              }));
            });
          }
          return;
        }

        if (msg.type === 'error') {
          set((state) => ({
            pipeline: {
              ...state.pipeline,
              state: msg.state ?? 'error',
              queuePosition: null,
              running: false,
              currentStage: 'error',
              stageMessage: msg.message ?? state.pipeline.stageMessage,
              error: msg.message ?? 'Unknown error',
              activityText: '',
            },
          }));
          return;
        }

        const cur = get().pipeline.currentStage;
        if (cur === 'done' || cur === 'complete') return;
        const data = msg.data as StageData | undefined;
        const nextState = msg.state ?? stateFromStage(msg.stage) ?? get().pipeline.state;
        set((state) => ({
          pipeline: {
            ...state.pipeline,
            state: nextState,
            queuePosition: msg.queuePosition ?? state.pipeline.queuePosition,
            running: nextState === 'running',
            progress: msg.progress ?? state.pipeline.progress,
            currentStage: msg.stage ?? state.pipeline.currentStage,
            startedAt: msg.startedAt != null ? toEpochMs(msg.startedAt) : state.pipeline.startedAt,
            stageMessage: [
              msg.message ?? state.pipeline.stageMessage,
              msg.roundNumber ? `Round ${msg.roundNumber}` : '',
              msg.searchStats
                ? `raw ${msg.searchStats.raw_count} / deduped ${msg.searchStats.deduped_count} / candidates ${msg.searchStats.returned_count}`
                : '',
              typeof msg.passedCount === 'number'
                ? `passed ${msg.passedCount}${msg.targetPassedCount ? `/${msg.targetPassedCount}` : ''}`
                : '',
              typeof msg.queuePosition === 'number' ? `queue ${msg.queuePosition}` : '',
              msg.retryCount ? `retry ${msg.retryCount}` : '',
              msg.stopReason ? `stop ${msg.stopReason}` : '',
            ].filter(Boolean).join(' · '),
            stageData: {
              ...state.pipeline.stageData,
              ...data,
              ...(msg.searchStats ? { search_stats: msg.searchStats } : {}),
            },
          },
        }));
      },
    }),
    {
      name: 'lit-researcher-store',
      version: 2,
      storage: createJSONStorage(() => localStorage),
      migrate: (persistedState) => {
        const typedPersistedState = persistedState as PersistedAppStore | undefined;

        return {
          ...typedPersistedState,
          pipeline: createPersistedPipelineSnapshot(
            rehydratePipeline(typedPersistedState?.pipeline),
          ),
        };
      },
      merge: (persistedState, currentState) => mergePersistedState(persistedState, currentState),
      partialize: (state) => ({
        searchParams: state.searchParams,
        pipeline: createPersistedPipelineSnapshot(state.pipeline),
      }),
    },
  ),
);
