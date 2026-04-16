const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  const isFormData = typeof FormData !== 'undefined' && options?.body instanceof FormData;
  if (!isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`${API_BASE}${path}`, {
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
      request<{ task_id: string }>('/api/pipeline/run', {
        method: 'POST',
        body: JSON.stringify(params),
      }),
    doi: (params: DoiParams) =>
      request<{ task_id: string }>('/api/pipeline/doi', {
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

      return request<{ task_id: string }>('/api/pipeline/pdf', {
        method: 'POST',
        body: formData,
      });
    },
    cancel: (taskId: string) =>
      request<{ task_id: string; cancelled: boolean }>(
        `/api/pipeline/cancel/${taskId}`,
        { method: 'POST' },
      ),
    status: (taskId: string) =>
      request<{ task_id: string; done: boolean; error: string | null; result_count: number | null }>(
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
    cleanup: (minQuality = 0) =>
      request<CleanupResult>(`/api/history/cleanup?min_quality=${minQuality}`, {
        method: 'POST',
      }),
    enrichPubchem: (
      force = false,
      onProgress?: (data: PubchemProgress) => void,
    ): Promise<PubchemEnrichResult> => {
      return new Promise(async (resolve, reject) => {
        try {
          const sseBase = typeof window !== 'undefined'
            ? `http://${window.location.hostname}:8000`
            : API_BASE;
          const res = await fetch(`${sseBase}/api/history/enrich-pubchem?force=${force}`, {
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
      const res = await fetch(`${API_BASE}/api/export/${format}`, {
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
      request<{ ok: boolean }>('/api/models', {
        method: 'POST',
        body: JSON.stringify(model),
      }),
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
          const sseBase = typeof window !== 'undefined'
            ? `http://${window.location.hostname}:8000`
            : API_BASE;
          const res = await fetch(`${sseBase}/api/notion/push`, {
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

export interface MetaResponse {
  fields: string[];
  field_labels: Record<string, string>;
  recommended_queries: string[];
  all_databases: string[];
  default_databases: string[];
}

export interface SearchMetadata {
  databases: string[];
  started_at: string;
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
}

export interface MergeResult {
  count: number;
  total_before: number;
  removed: number;
  dedup_discarded?: number;
  pushed_count: number;
  unpushed_count: number;
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
  data?: Record<string, unknown>;
  rows?: Record<string, unknown>[];
  stats?: { total: number; fulltext_rate: number; avg_quality: number };
}
