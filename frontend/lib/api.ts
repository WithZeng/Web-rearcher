import { resolveApiUrl } from './backend';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  const isFormData = typeof FormData !== 'undefined' && options?.body instanceof FormData;
  if (!isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(resolveApiUrl(path), {
    ...options,
    headers,
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      const raw = body.detail;
      if (typeof raw === 'string') {
        detail = raw;
      } else if (Array.isArray(raw)) {
        detail = raw.map((e: Record<string, unknown>) => e.msg ?? JSON.stringify(e)).join('; ');
      } else if (raw) {
        detail = JSON.stringify(raw);
      } else {
        detail = JSON.stringify(body);
      }
    } catch {
      detail = res.statusText;
    }
    throw new Error(detail || `API error: ${res.status}`);
  }
  return res.json();
}

export const api = {
  meta: () => request<MetaResponse>('/api/meta'),

  pipeline: {
    run: (params: PipelineParams) =>
      request<PipelineRunResponse>('/api/pipeline/run', {
        method: 'POST',
        body: JSON.stringify(params),
      }),
    doi: (params: DoiParams) =>
      request<PipelineRunResponse>('/api/pipeline/doi', {
        method: 'POST',
        body: JSON.stringify(params),
      }),
    pdf: (files: File[], params: PdfParams) => {
      const formData = new FormData();
      for (const file of files) {
        formData.append('files', file);
      }
      formData.append('mode', params.mode);
      formData.append('llm_concurrency', String(params.llm_concurrency));

      return request<PipelineRunResponse>('/api/pipeline/pdf', {
        method: 'POST',
        body: formData,
      });
    },
    listServerPdfs: () => request<ServerPdfEntry[]>('/api/pipeline/server-pdfs'),
    serverPdf: (paths: string[], params: PdfParams) =>
      request<PipelineRunResponse>('/api/pipeline/pdf-server', {
        method: 'POST',
        body: JSON.stringify({
          paths,
          mode: params.mode,
          llm_concurrency: params.llm_concurrency,
        }),
      }),
    cancel: (taskId: string) =>
      request<{ task_id: string; cancelled: boolean }>(
        `/api/pipeline/cancel/${taskId}`,
        { method: 'POST' },
      ),
    cancelBatch: (taskIds: string[]) =>
      request<BatchTaskResponse>('/api/pipeline/cancel-batch', {
        method: 'POST',
        body: JSON.stringify({ task_ids: taskIds }),
      }),
    removeBatch: (taskIds: string[]) =>
      request<BatchTaskResponse>('/api/pipeline/remove-batch', {
        method: 'POST',
        body: JSON.stringify({ task_ids: taskIds }),
      }),
    live: () => request<PipelineTaskSummary[]>('/api/pipeline/live'),
    status: (taskId: string) =>
      request<PipelineTaskStatus>(
        `/api/pipeline/status/${taskId}`,
      ),
  },

  history: {
    list: () => request<HistoryTask[]>('/api/history'),
    delete: (ts: string) =>
      request<{ ok: boolean }>(`/api/history/${ts}`, { method: 'DELETE' }),
    merge: (minQuality = 0, removeEmpty = true, pushedFilter = 'all') =>
      request<MergeResult>(
        `/api/history/merged?min_quality=${minQuality}&remove_empty=${removeEmpty}&pushed_filter=${pushedFilter}`,
      ),
    stats: () => request<HistoryStats>('/api/history/stats'),
    cleanupPreview: (minQuality = 0, pushedFilter = 'all') =>
      request<CleanupResult & { breakdown: Record<string, number>; scope_count: number; pushed_filter: string }>(
        `/api/history/cleanup-preview?min_quality=${minQuality}&pushed_filter=${pushedFilter}`,
      ),
    cleanup: (minQuality = 0, pushedFilter = 'all') =>
      request<CleanupResult & { breakdown?: Record<string, number>; pushed_filter?: string }>(
        `/api/history/cleanup?min_quality=${minQuality}&pushed_filter=${pushedFilter}`, {
        method: 'POST',
      }),
    enrichPubchem: (
      force = false,
      onProgress?: (data: PubchemProgress) => void,
    ): Promise<PubchemEnrichResult> => {
      return new Promise(async (resolve, reject) => {
        try {
          const res = await fetch(resolveApiUrl(`/api/history/enrich-pubchem?force=${force}`), {
            method: 'POST',
            headers: { 'Accept': 'text/event-stream' },
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            reject(new Error(body.detail || `API error: ${res.status}`));
            return;
          }
          const reader = res.body?.getReader();
          if (!reader) { reject(new Error('No response body')); return; }
          const decoder = new TextDecoder();
          let buffer = '';
          let lastResult: PubchemEnrichResult | null = null;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const jsonStr = line.slice(6).trim();
              if (!jsonStr) continue;
              try {
                const data = JSON.parse(jsonStr);
                if (data.phase === 'done') {
                  lastResult = data as PubchemEnrichResult;
                }
                if (data.phase === 'error') {
                  reject(new Error(data.message || 'PubChem enrichment failed'));
                  return;
                }
                onProgress?.(data as PubchemProgress);
              } catch { /* skip malformed */ }
            }
          }
          resolve(lastResult || {
            enriched_papers: 0, fields_filled: 0, unique_drugs: 0,
            resolved_drugs: 0, unresolved_drugs: 0, total_rows: 0,
          });
        } catch (err) { reject(err); }
      });
    },
  },

  export: {
    download: async (format: string, rows: Record<string, unknown>[]) => {
      const res = await fetch(resolveApiUrl(`/api/export/${format}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      });
      return res.blob();
    },
  },

  config: {
    get: () => request<ConfigResponse>('/api/config'),
    update: (params: ConfigUpdate) =>
      request<{ ok: boolean }>('/api/config', {
        method: 'PUT',
        body: JSON.stringify(params),
      }),
    importEnv: (file: File) => {
      const formData = new FormData();
      formData.append('file', file);
      return request<EnvImportResult>('/api/config/import-env', {
        method: 'POST',
        body: formData,
      });
    },
    test: (params: ConfigUpdate) =>
      request<{ success: boolean; message: string }>('/api/config/test', {
        method: 'POST',
        body: JSON.stringify(params),
      }),
    testNotion: () =>
      request<{ success: boolean; message: string }>('/api/config/test-notion', {
        method: 'POST',
      }),
  },

  models: {
    list: async () => {
      const res = await request<{ models: ModelProfile[] } | ModelProfile[]>('/api/models');
      return Array.isArray(res) ? res : res.models;
    },
    create: (model: ModelProfile) =>
      request<ModelProfile>('/api/models', {
        method: 'POST',
        body: JSON.stringify(model),
      }),
    apply: (name: string) =>
      request<{ applied: string }>(
        `/api/models/${encodeURIComponent(name)}/apply`,
        { method: 'POST' },
      ),
    delete: (name: string) =>
      request<{ ok: boolean }>(
        `/api/models/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      ),
  },

  notion: {
    pushStream: (
      rows: Record<string, unknown>[],
      onProgress: (data: NotionPushProgress) => void,
      patchExisting = false,
    ): Promise<NotionPushResult> => {
      return new Promise(async (resolve, reject) => {
        try {
          const res = await fetch(resolveApiUrl('/api/notion/push'), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
            },
            body: JSON.stringify({ rows, patch_existing: patchExisting }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            reject(new Error(body.detail || `API error: ${res.status}`));
            return;
          }
          const reader = res.body?.getReader();
          if (!reader) {
            reject(new Error('No response body'));
            return;
          }
          const decoder = new TextDecoder();
          let buffer = '';
          let lastResult: NotionPushResult | null = null;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const json_str = line.slice(6).trim();
              if (!json_str) continue;
              try {
                const data = JSON.parse(json_str);
                if (data.pushed_dois) {
                  lastResult = data as NotionPushResult;
                }
                onProgress(data as NotionPushProgress);
              } catch { /* skip malformed */ }
            }
          }
          resolve(lastResult || { pushed: 0, patched: 0, skipped_quality: 0, skipped_duplicate: 0, total: 0, pushed_dois: [] });
        } catch (err) {
          reject(err);
        }
      });
    },
    status: () => request<NotionStatus>('/api/notion/status'),
  },

  blacklist: {
    count: () => request<{ count: number }>('/api/blacklist/count'),
    clear: () => request<{ removed: number }>('/api/blacklist', { method: 'DELETE' }),
  },
};

export interface PipelineParams {
  query: string;
  limit: number;
  target_passed_count?: number;
  databases: string[];
  mode: string;
  use_planner: boolean;
  fetch_concurrency: number;
  llm_concurrency: number;
}

export interface DoiParams {
  dois: string[];
  mode: string;
  fetch_concurrency: number;
  llm_concurrency: number;
}

export interface PdfParams {
  mode: string;
  llm_concurrency: number;
}

export interface ServerPdfEntry {
  path: string;
  name: string;
  size: number;
  modified_at: string;
}

export interface PipelineRunResponse {
  task_id: string;
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled' | string;
  queue_position: number | null;
}

export interface PipelineTaskSummary {
  task_id: string;
  kind: 'search' | 'doi' | 'pdf' | string;
  title: string;
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled' | string;
  current_stage: string;
  progress: number;
  detail: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  result_count: number | null;
  cancelled: boolean;
  activity_text: string;
  papers_found?: number | null;
  papers_passed?: number | null;
  rows_extracted?: number | null;
  retrieval_attempted?: number | null;
  retrieval_total?: number | null;
  retrieval_fulltext_success?: number | null;
  retrieval_fallback_only?: number | null;
  retrieval_failed?: number | null;
  queue_position?: number | null;
}

export interface PipelineTaskStatus extends PipelineTaskSummary {
  done: boolean;
  error: string | null;
  messages: Record<string, unknown>[];
}

export interface MetaResponse {
  fields: string[];
  field_labels: Record<string, string>;
  recommended_queries: string[];
  all_databases: string[];
  default_databases: string[];
}

export interface SearchStats {
  requested_limit: number;
  per_db_limit: number;
  db_counts: Record<string, number>;
  raw_count: number;
  deduped_count: number;
  returned_count: number;
  database_count: number;
  round_number?: number;
  round_raw_count?: number;
  round_deduped_count?: number;
  round_returned_count?: number;
  blacklist_skipped?: number;
  history_skipped?: number;
  target_passed_count?: number;
  final_passed_count?: number;
  rounds_completed?: number;
  exhausted_sources?: string[];
  stop_reason?: string | null;
}

export interface SearchMetadata {
  databases: string[];
  started_at: string;
  raw_hit_count?: number;
  deduped_count?: number;
  returned_count?: number;
  db_counts?: Record<string, number>;
  blacklist_skipped?: number;
  history_skipped?: number;
  target_passed_count?: number;
  final_passed_count?: number;
  rounds_completed?: number;
  exhausted_sources?: string[];
  stop_reason?: string;
}

export interface HistoryTask {
  timestamp: string;
  query: string;
  count: number;
  rows: Record<string, unknown>[];
  search_metadata?: SearchMetadata;
}

export interface HistoryStats {
  total_tasks: number;
  total_papers: number;
  avg_quality: number;
  source_counts: Record<string, number>;
  total_raw_hits: number;
  total_deduped_hits: number;
  total_final_rows: number;
  total_final_passed_count: number;
  avg_effective_ratio: number;
}

export interface MergeResult {
  count: number;
  total_before: number;
  removed: number;
  dedup_discarded?: number;
  pushed_count: number;
  unpushed_count: number;
  core_gate_count?: number;
  candidate_only_count?: number;
  rows: Record<string, unknown>[];
}

export interface CleanupResult {
  files_updated: number;
  rows_before: number;
  rows_after: number;
  removed: number;
}

export interface PubchemProgress {
  phase: 'lookup' | 'enrich' | 'done' | 'error' | 'heartbeat';
  message?: string;
  done?: number;
  total?: number;
  resolved_drugs?: number;
  unresolved_drugs?: number;
  cache_hit?: number;
}

export interface PubchemEnrichResult {
  phase?: string;
  enriched_papers: number;
  fields_filled: number;
  unique_drugs: number;
  resolved_drugs: number;
  unresolved_drugs: number;
  total_rows: number;
  cache_hit?: number;
}

export interface ConfigResponse {
  model: string;
  base_url: string;
  api_type: string;
  has_api_key: boolean;
  max_results: number;
  fetch_concurrency: number;
  llm_concurrency: number;
  has_notion: boolean;
  notion_parent_page_id: string;
  notion_db_name: string;
  unpaywall_email: string;
  http_proxy: string;
  ieee_api_key: string;
  scopus_api_key: string;
  grobid_url: string;
  all_databases: string[];
  default_databases: string[];
}

export interface ConfigUpdate {
  api_key?: string;
  base_url?: string;
  model?: string;
  api_type?: string;
  notion_token?: string;
  notion_parent_page_id?: string;
  notion_db_name?: string;
  unpaywall_email?: string;
  http_proxy?: string;
  ieee_api_key?: string;
  scopus_api_key?: string;
  grobid_url?: string;
}

export interface EnvImportResult {
  ok: boolean;
  imported: string[];
  ignored: string[];
  warnings: string[];
}

export interface NotionPushResult {
  pushed: number;
  patched: number;
  skipped_quality: number;
  skipped_duplicate: number;
  total: number;
  pushed_dois: string[];
}

export interface NotionPushProgress {
  phase: 'init' | 'dedup' | 'filter_done' | 'pushing' | 'patching' | 'done' | 'error';
  message?: string;
  current?: number;
  total?: number;
  pushed?: number;
  patched?: number;
  failed?: number;
  to_push?: number;
  to_patch?: number;
  skipped_quality?: number;
  skipped_duplicate?: number;
}

export interface NotionStatus {
  connected: boolean;
  database_id?: string;
  record_count: number;
  error?: string;
}

export interface ModelProfile {
  name: string;
  api_key?: string;
  base_url: string;
  model: string;
  api_type?: string;
}

export interface PipelineMessage {
  type: 'stage' | 'complete' | 'error' | 'activity';
  stage?: string;
  progress?: number;
  message?: string;
  activityText?: string;
  state?: 'queued' | 'running' | 'done' | 'error' | 'cancelled' | string;
  queuePosition?: number | null;
  startedAt?: string | null;
  data?: Record<string, unknown>;
  searchStats?: SearchStats;
  roundNumber?: number;
  passedCount?: number;
  targetPassedCount?: number | null;
  stopReason?: string | null;
  retryCount?: number;
  rows?: Record<string, unknown>[];
  stats?: { total: number; fulltext_rate: number; avg_quality: number };
}

export interface BatchTaskSkip {
  task_id: string;
  reason: string;
}

export interface BatchTaskResponse {
  requested: number;
  affected_task_ids: string[];
  skipped: BatchTaskSkip[];
}
