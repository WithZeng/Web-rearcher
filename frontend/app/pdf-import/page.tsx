"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FileText,
  Files,
  FolderOpen,
  Loader2,
  Play,
  RefreshCw,
  Server,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PipelineProgress } from "@/components/pipeline-progress";
import { ResultsTable } from "@/components/results-table";
import { ExportMenu } from "@/components/export-menu";
import { PaperDetail } from "@/components/paper-detail";
import { api, type NotionPushResult, type PipelineRunResponse, type ServerPdfEntry } from "@/lib/api";
import { connectPipeline } from "@/lib/ws";
import { useAppStore } from "@/lib/store";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

export default function PdfImportPage() {
  const pipeline = useAppStore((state) => state.pipeline);
  const setPipelineField = useAppStore((state) => state.setPipelineField);
  const resetPipeline = useAppStore((state) => state.resetPipeline);
  const handlePipelineMessage = useAppStore((state) => state.handlePipelineMessage);

  const [sourceTab, setSourceTab] = useState<"local" | "server">("local");
  const [files, setFiles] = useState<File[]>([]);
  const [serverFiles, setServerFiles] = useState<ServerPdfEntry[]>([]);
  const [selectedServerPaths, setSelectedServerPaths] = useState<string[]>([]);
  const [serverFilesLoading, setServerFilesLoading] = useState(false);
  const [serverFilesError, setServerFilesError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [llmConcurrency, setLlmConcurrency] = useState(5);
  const [mode, setMode] = useState<"single" | "multi">("multi");
  const [selectedPaper, setSelectedPaper] = useState<Record<string, unknown> | null>(null);
  const [submittingSource, setSubmittingSource] = useState<"local" | "server" | null>(null);
  const [notionResult, setNotionResult] = useState<NotionPushResult | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const wsCloseRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const taskId = pipeline.taskId;
    const alreadyDone = ["done", "error", "cancelled"].includes(pipeline.state);
    if (!taskId || alreadyDone) return;

    let cancelled = false;

    const syncTaskStatus = async () => {
      try {
        const status = await api.pipeline.status(taskId);
        if (cancelled) return;

        setPipelineField("state", status.state);
        setPipelineField("queuePosition", status.queue_position ?? null);
        setPipelineField("running", status.state === "running");
        setPipelineField("startedAt", status.started_at ? new Date(status.started_at).getTime() : null);
        setPipelineField("currentStage", status.current_stage ?? "");
        setPipelineField("stageMessage", status.detail);

        if (status.error) {
          wsCloseRef.current?.();
          wsCloseRef.current = null;
          handlePipelineMessage({ type: "error", message: status.error, state: status.state });
          return;
        }

        if (status.done) {
          wsCloseRef.current?.();
          wsCloseRef.current = null;
          handlePipelineMessage({ type: "complete" });
          return;
        }

        if (!wsCloseRef.current) {
          const { close } = connectPipeline(taskId, handlePipelineMessage, () => {
            wsCloseRef.current = null;
          });
          wsCloseRef.current = close;
        }
      } catch {
        // Keep polling so transient network issues do not leave the UI stuck forever.
      }
    };

    void syncTaskStatus();
    const timer = window.setInterval(() => {
      void syncTaskStatus();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pipeline.taskId, pipeline.state, pipeline.currentStage, setPipelineField, handlePipelineMessage]);

  useEffect(() => {
    return () => {
      wsCloseRef.current?.();
    };
  }, []);

  const loadServerFiles = useCallback(async () => {
    setServerFilesLoading(true);
    setServerFilesError(null);
    try {
      const entries = await api.pipeline.listServerPdfs();
      setServerFiles(entries);
      setSelectedServerPaths((current) => current.filter((path) => entries.some((entry) => entry.path === path)));
    } catch (error) {
      setServerFilesError(error instanceof Error ? error.message : "Failed to load server PDFs");
    } finally {
      setServerFilesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (sourceTab === "server" && serverFiles.length === 0 && !serverFilesLoading && !serverFilesError) {
      void loadServerFiles();
    }
  }, [sourceTab, serverFiles.length, serverFilesLoading, serverFilesError, loadServerFiles]);

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const nextFiles = Array.from(incoming).filter(isPdfFile);
    if (nextFiles.length === 0) return;

    setFiles((current) => {
      const seen = new Set(current.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
      const merged = [...current];
      for (const file of nextFiles) {
        const key = `${file.name}:${file.size}:${file.lastModified}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(file);
        }
      }
      return merged;
    });
  }, []);

  const handleFileInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files) return;
    addFiles(event.target.files);
    event.target.value = "";
  }, [addFiles]);

  const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    if (event.dataTransfer.files.length > 0) {
      addFiles(event.dataTransfer.files);
    }
  }, [addFiles]);

  const startTask = useCallback(async (
    source: "local" | "server",
    taskPromise: Promise<PipelineRunResponse>,
  ) => {
    resetPipeline();
    setSubmittingSource(source);
    setPipelineField("state", "");
    setPipelineField("queuePosition", null);
    setPipelineField("currentStage", "");
    setPipelineField("stageMessage", "");
    setPipelineField("error", null);
    setPipelineField("rows", []);
    setPipelineField("stats", null);

    try {
      const result = await taskPromise;
      setPipelineField("taskId", result.task_id);
      setPipelineField("state", result.state);
      setPipelineField("queuePosition", result.queue_position ?? null);
      setPipelineField("running", result.state === "running");
      setPipelineField("progress", 0);
      setPipelineField("startedAt", result.state === "running" ? Date.now() : null);
      setPipelineField("currentStage", result.state === "queued" ? "queued" : "");
      setPipelineField(
        "stageMessage",
        result.state === "queued" && typeof result.queue_position === "number"
          ? `Queued at position ${result.queue_position}`
          : "",
      );

      wsCloseRef.current?.();
      const { close } = connectPipeline(result.task_id, handlePipelineMessage, () => {
        wsCloseRef.current = null;
      });
      wsCloseRef.current = close;
    } catch (error) {
      setPipelineField("error", error instanceof Error ? error.message : "PDF import failed");
      setPipelineField("running", false);
    } finally {
      setSubmittingSource(null);
    }
  }, [resetPipeline, setPipelineField, handlePipelineMessage]);

  const handleLocalSubmit = useCallback(async () => {
    if (files.length === 0 || submittingSource !== null) return;
    await startTask(
      "local",
      api.pipeline.pdf(files, {
        mode,
        llm_concurrency: llmConcurrency,
      }),
    );
  }, [files, mode, llmConcurrency, submittingSource, startTask]);

  const handleServerSubmit = useCallback(async () => {
    if (selectedServerPaths.length === 0 || submittingSource !== null) return;
    await startTask(
      "server",
      api.pipeline.serverPdf(selectedServerPaths, {
        mode,
        llm_concurrency: llmConcurrency,
      }),
    );
  }, [selectedServerPaths, mode, llmConcurrency, submittingSource, startTask]);

  const totalSize = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);
  const selectedServerEntries = useMemo(
    () => serverFiles.filter((entry) => selectedServerPaths.includes(entry.path)),
    [serverFiles, selectedServerPaths],
  );
  const selectedServerSize = useMemo(
    () => selectedServerEntries.reduce((sum, entry) => sum + entry.size, 0),
    [selectedServerEntries],
  );
  const showProgress = Boolean(pipeline.taskId) || pipeline.rows.length > 0;

  const toggleServerPath = useCallback((path: string) => {
    setSelectedServerPaths((current) =>
      current.includes(path) ? current.filter((item) => item !== path) : [...current, path],
    );
  }, []);

  const handleSelectAllServerFiles = useCallback(() => {
    setSelectedServerPaths(serverFiles.map((entry) => entry.path));
  }, [serverFiles]);

  const handleClearAllServerFiles = useCallback(() => {
    setSelectedServerPaths([]);
  }, []);

  return (
    <div className="app-page space-y-6">
      <section className="page-hero">
        <div className="grid gap-8 lg:grid-cols-[1.2fr_0.8fr]">
          <div>
            <div className="inline-flex w-fit items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-xs text-cyan-200">
              <Files className="size-3.5" />
              PDF queue-ready import
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white md:text-5xl">
              Submit local or server PDFs without blocking the next task.
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-300 md:text-base">
              New PDF imports now join the shared task queue. You can keep submitting work while another task is already running.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
            {[
              { label: "Local PDFs", value: String(files.length), hint: "ready to upload" },
              { label: "Server PDFs", value: String(selectedServerPaths.length), hint: "selected on server" },
              { label: "LLM Concurrency", value: String(llmConcurrency), hint: "per PDF task" },
            ].map((item) => (
              <div key={item.label} className="rounded-[24px] border border-white/10 bg-black/20 p-5">
                <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">{item.label}</p>
                <p className="mt-3 text-3xl font-semibold tracking-tight text-white">{item.value}</p>
                <p className="mt-2 text-sm text-zinc-500">{item.hint}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="panel p-5 md:p-6">
          <Tabs value={sourceTab} onValueChange={(value) => setSourceTab(value as "local" | "server")}>
            <TabsList className="grid w-full grid-cols-2 rounded-full bg-white/[0.04]">
              <TabsTrigger value="local">Local files</TabsTrigger>
              <TabsTrigger value="server">Server files</TabsTrigger>
            </TabsList>

            <TabsContent value="local" className="mt-6 space-y-5">
              <div
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={() => setDragActive(false)}
                onDrop={handleDrop}
                className={`rounded-[28px] border border-dashed p-8 transition ${
                  dragActive
                    ? "border-cyan-300/35 bg-cyan-400/[0.06]"
                    : "border-white/10 bg-white/[0.02]"
                }`}
              >
                <div className="mx-auto flex max-w-xl flex-col items-center text-center">
                  <div className="flex size-14 items-center justify-center rounded-2xl border border-cyan-400/20 bg-cyan-400/10 text-cyan-300">
                    <Upload className="size-6" />
                  </div>
                  <h2 className="mt-5 text-xl font-semibold tracking-tight text-white">Drop PDFs here</h2>
                  <p className="mt-2 text-sm leading-6 text-zinc-400">
                    Add one or many PDFs. Submitting them now will join the same queue used by search and DOI tasks.
                  </p>
                  <div className="mt-5 flex flex-wrap gap-3">
                    <Button onClick={() => inputRef.current?.click()}>
                      <FolderOpen className="size-3.5" data-icon="inline-start" />
                      Choose PDFs
                    </Button>
                    <Button
                      variant="outline"
                      onClick={handleLocalSubmit}
                      disabled={files.length === 0 || submittingSource !== null}
                    >
                      {submittingSource === "local" ? (
                        <Loader2 className="size-3.5 animate-spin" data-icon="inline-start" />
                      ) : (
                        <Play className="size-3.5" data-icon="inline-start" />
                      )}
                      Submit Local Task
                    </Button>
                  </div>
                </div>

                <input
                  ref={inputRef}
                  type="file"
                  accept=".pdf"
                  multiple
                  onChange={handleFileInput}
                  className="hidden"
                />
              </div>

              {files.length > 0 ? (
                <div className="rounded-[24px] border border-white/8 bg-white/[0.03] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-white">Selected files</p>
                      <p className="mt-1 text-xs text-zinc-500">
                        {files.length} file(s) · {formatFileSize(totalSize)}
                      </p>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => setFiles([])}>
                      <Trash2 className="size-3.5" data-icon="inline-start" />
                      Clear
                    </Button>
                  </div>
                  <div className="mt-4 space-y-2">
                    {files.map((file) => (
                      <div
                        key={`${file.name}:${file.size}:${file.lastModified}`}
                        className="flex items-center justify-between rounded-[18px] border border-white/8 bg-black/20 px-4 py-3"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm text-zinc-100">{file.name}</p>
                          <p className="mt-1 text-xs text-zinc-500">{formatFileSize(file.size)}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setFiles((current) =>
                              current.filter(
                                (item) =>
                                  `${item.name}:${item.size}:${item.lastModified}` !==
                                  `${file.name}:${file.size}:${file.lastModified}`,
                              ),
                            )
                          }
                          className="rounded-full border border-white/10 p-2 text-zinc-400 transition hover:text-white"
                        >
                          <X className="size-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </TabsContent>

            <TabsContent value="server" className="mt-6 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[24px] border border-white/8 bg-white/[0.03] p-4">
                <div>
                  <p className="text-sm font-medium text-white">Server PDF cache</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    Select files already stored on the server and submit them as another queued task.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => void loadServerFiles()} disabled={serverFilesLoading}>
                    {serverFilesLoading ? (
                      <Loader2 className="size-3.5 animate-spin" data-icon="inline-start" />
                    ) : (
                      <RefreshCw className="size-3.5" data-icon="inline-start" />
                    )}
                    Refresh
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleSelectAllServerFiles}
                    disabled={serverFiles.length === 0 || selectedServerPaths.length === serverFiles.length}
                  >
                    Select all
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleClearAllServerFiles}
                    disabled={selectedServerPaths.length === 0}
                  >
                    Clear
                  </Button>
                  <Button
                    onClick={handleServerSubmit}
                    disabled={selectedServerPaths.length === 0 || submittingSource !== null}
                  >
                    {submittingSource === "server" ? (
                      <Loader2 className="size-3.5 animate-spin" data-icon="inline-start" />
                    ) : (
                      <Play className="size-3.5" data-icon="inline-start" />
                    )}
                    Submit Server Task
                  </Button>
                </div>
              </div>

              {serverFilesError ? (
                <div className="rounded-[22px] border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                  {serverFilesError}
                </div>
              ) : null}

              <div className="rounded-[24px] border border-white/8 bg-white/[0.03] p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-white">Server files</p>
                    <p className="mt-1 text-xs text-zinc-500">
                      {selectedServerPaths.length} selected · {formatFileSize(selectedServerSize)}
                    </p>
                  </div>
                  <Badge variant="outline" className="border-white/10 text-zinc-300">
                    {serverFiles.length} available
                  </Badge>
                </div>

                <div className="mt-4 space-y-2">
                  {serverFiles.length === 0 && !serverFilesLoading ? (
                    <div className="rounded-[18px] border border-dashed border-white/10 bg-black/20 px-4 py-6 text-sm text-zinc-500">
                      No server PDFs found.
                    </div>
                  ) : null}

                  {serverFiles.map((entry) => {
                    const checked = selectedServerPaths.includes(entry.path);
                    return (
                      <label
                        key={entry.path}
                        className="flex items-center gap-3 rounded-[18px] border border-white/8 bg-black/20 px-4 py-3"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleServerPath(entry.path)}
                          className="size-4 rounded border-white/15 bg-black/20"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-zinc-100">{entry.name}</p>
                          <p className="mt-1 text-xs text-zinc-500">
                            {entry.path} · {formatFileSize(entry.size)} · {formatTimestamp(entry.modified_at)}
                          </p>
                        </div>
                        <Server className="size-4 text-cyan-300" />
                      </label>
                    );
                  })}
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </div>

        <div className="space-y-6">
          <div className="panel p-5 md:p-6">
            <p className="page-kicker">Task Settings</p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">Queue submission options</h2>
            <p className="mt-2 text-sm leading-6 text-zinc-400">
              These options only affect the task you are about to submit. Existing queued tasks keep their own configuration.
            </p>

            <div className="mt-6 space-y-5">
              <div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-zinc-300">Mode</span>
                  <Badge variant="outline" className="border-white/10 text-zinc-300">
                    {mode}
                  </Badge>
                </div>
                <div className="mt-3 flex gap-2">
                  <Button
                    variant={mode === "multi" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setMode("multi")}
                  >
                    Multi
                  </Button>
                  <Button
                    variant={mode === "single" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setMode("single")}
                  >
                    Single
                  </Button>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-zinc-300">LLM concurrency</span>
                  <Badge variant="outline" className="border-white/10 text-zinc-300">
                    {llmConcurrency}
                  </Badge>
                </div>
                <Slider
                  className="mt-4"
                  min={1}
                  max={10}
                  step={1}
                  value={[llmConcurrency]}
                  onValueChange={(value) => setLlmConcurrency(value[0] ?? 5)}
                />
              </div>
            </div>
          </div>

          {pipeline.taskId ? (
            <div className="flex justify-end">
              <Link href={`/tasks?task=${encodeURIComponent(pipeline.taskId)}`}>
                <Button variant="outline" size="sm">
                  <Play className="size-3.5" data-icon="inline-start" />
                  View in Task Center
                </Button>
              </Link>
            </div>
          ) : null}
        </div>
      </section>

      {showProgress ? (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
          <PipelineProgress />
        </motion.div>
      ) : null}

      {pipeline.error ? (
        <div className="rounded-[22px] border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {pipeline.error}
        </div>
      ) : null}

      {pipeline.rows.length > 0 ? (
        <section className="space-y-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="page-kicker">Results</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">Processed rows</h2>
              <p className="mt-2 text-sm text-zinc-400">
                {pipeline.rows.length} structured row(s) ready for export.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <ExportMenu rows={pipeline.rows} />
              {notionResult ? (
                <Badge variant="outline" className="border-white/10 text-zinc-300">
                  Last push: {notionResult.pushed} pushed
                </Badge>
              ) : null}
            </div>
          </div>

          <ResultsTable rows={pipeline.rows} onRowClick={(row) => setSelectedPaper(row)} />
        </section>
      ) : null}

      <PaperDetail paper={selectedPaper} open={!!selectedPaper} onClose={() => setSelectedPaper(null)} />
    </div>
  );
}
