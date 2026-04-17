"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
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
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PipelineProgress } from "@/components/pipeline-progress";
import { ResultsTable } from "@/components/results-table";
import { ExportMenu } from "@/components/export-menu";
import { PaperDetail } from "@/components/paper-detail";
import { api, type NotionPushResult, type ServerPdfEntry } from "@/lib/api";
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

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatGroupLabel(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateKey;

  const today = startOfLocalDay(new Date());
  const target = startOfLocalDay(date);
  const diffDays = Math.round((today.getTime() - target.getTime()) / 86400000);

  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "昨天";
  return dateKey;
}

function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

const COLLAPSED_FILE_COUNT = 3;
const AUTO_COLLAPSE_THRESHOLD = 4;

interface ServerPdfGroup {
  key: string;
  label: string;
  entries: ServerPdfEntry[];
  totalSize: number;
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
  const [filesExpanded, setFilesExpanded] = useState(false);
  const [notionDialogOpen, setNotionDialogOpen] = useState(false);
  const [notionPushing, setNotionPushing] = useState(false);
  const [notionResult, setNotionResult] = useState<NotionPushResult | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const wsCloseRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const taskId = pipeline.taskId;
    const alreadyDone = pipeline.currentStage === "done" || pipeline.currentStage === "error";
    if (!taskId || alreadyDone) return;

    let cancelled = false;

    const syncTaskStatus = async () => {
      try {
        const status = await api.pipeline.status(taskId);
        if (cancelled) return;

        if (status.error) {
          wsCloseRef.current?.();
          wsCloseRef.current = null;
          handlePipelineMessage({ type: "error", message: status.error });
          return;
        }

        if (status.done) {
          wsCloseRef.current?.();
          wsCloseRef.current = null;
          handlePipelineMessage({ type: "complete" });
          return;
        }

        if (!wsCloseRef.current) {
          setPipelineField("running", true);
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
  }, [pipeline.taskId, pipeline.currentStage, setPipelineField, handlePipelineMessage]);

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
      setServerFilesError(error instanceof Error ? error.message : "服务器 PDF 列表加载失败");
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

  const startTask = useCallback(async (taskPromise: Promise<{ task_id: string }>) => {
    resetPipeline();
    setPipelineField("running", true);
    setPipelineField("startedAt", Date.now());
    setPipelineField("currentStage", "");
    setPipelineField("error", null);
    setPipelineField("rows", []);
    setPipelineField("stats", null);

    try {
      const { task_id } = await taskPromise;
      setPipelineField("taskId", task_id);
      setPipelineField("progress", 0);

      wsCloseRef.current?.();
      const { close } = connectPipeline(task_id, handlePipelineMessage, () => {
        wsCloseRef.current = null;
      });
      wsCloseRef.current = close;
    } catch (error) {
      setPipelineField("error", error instanceof Error ? error.message : "PDF 导入失败");
      setPipelineField("running", false);
    }
  }, [resetPipeline, setPipelineField, handlePipelineMessage]);

  const handleLocalSubmit = useCallback(async () => {
    if (files.length === 0 || pipeline.running) return;
    await startTask(
      api.pipeline.pdf(files, {
        mode,
        llm_concurrency: llmConcurrency,
      }),
    );
  }, [files, mode, llmConcurrency, pipeline.running, startTask]);

  const handleServerSubmit = useCallback(async () => {
    if (selectedServerPaths.length === 0 || pipeline.running) return;
    await startTask(
      api.pipeline.serverPdf(selectedServerPaths, {
        mode,
        llm_concurrency: llmConcurrency,
      }),
    );
  }, [selectedServerPaths, mode, llmConcurrency, pipeline.running, startTask]);

  const totalSize = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);
  const selectedServerEntries = useMemo(
    () => serverFiles.filter((entry) => selectedServerPaths.includes(entry.path)),
    [serverFiles, selectedServerPaths],
  );
  const selectedServerSize = useMemo(
    () => selectedServerEntries.reduce((sum, entry) => sum + entry.size, 0),
    [selectedServerEntries],
  );
  const serverPdfGroups = useMemo<ServerPdfGroup[]>(() => {
    const groups = new Map<string, ServerPdfEntry[]>();
    for (const entry of serverFiles) {
      const parsed = new Date(entry.modified_at);
      const key = Number.isNaN(parsed.getTime()) ? "未知日期" : parsed.toISOString().slice(0, 10);
      const current = groups.get(key) ?? [];
      current.push(entry);
      groups.set(key, current);
    }

    return Array.from(groups.entries()).map(([key, entries]) => ({
      key,
      label: key === "未知日期" ? key : formatGroupLabel(key),
      entries,
      totalSize: entries.reduce((sum, entry) => sum + entry.size, 0),
    }));
  }, [serverFiles]);
  const shouldCollapseFiles = files.length >= AUTO_COLLAPSE_THRESHOLD;
  const visibleFiles = shouldCollapseFiles && !filesExpanded ? files.slice(0, COLLAPSED_FILE_COUNT) : files;
  const hiddenFileCount = files.length - visibleFiles.length;
  const showProgress = pipeline.running || pipeline.rows.length > 0;

  const toggleServerPath = useCallback((path: string) => {
    setSelectedServerPaths((current) =>
      current.includes(path)
        ? current.filter((item) => item !== path)
        : [...current, path],
    );
  }, []);

  const handleSelectAllServerFiles = useCallback(() => {
    setSelectedServerPaths(serverFiles.map((entry) => entry.path));
  }, [serverFiles]);

  const handleClearAllServerFiles = useCallback(() => {
    setSelectedServerPaths([]);
  }, []);

  const handleSelectServerGroup = useCallback((paths: string[]) => {
    setSelectedServerPaths((current) => {
      const merged = new Set(current);
      for (const path of paths) {
        merged.add(path);
      }
      return Array.from(merged);
    });
  }, []);

  const handleClearServerGroup = useCallback((paths: string[]) => {
    setSelectedServerPaths((current) => current.filter((path) => !paths.includes(path)));
  }, []);

  const notionStats = useMemo(() => {
    const invalid = pipeline.rows.filter((row) => {
      const q = Number(row._data_quality);
      return q === 0 || Number.isNaN(q);
    }).length;
    return { total: pipeline.rows.length, invalid };
  }, [pipeline.rows]);

  const handleNotionPush = useCallback(async () => {
    setNotionPushing(true);
    setNotionResult(null);
    try {
      const result = await api.notion.pushStream(pipeline.rows, () => {});
      setNotionResult(result);
    } catch (error) {
      console.error("Notion push failed:", error);
    } finally {
      setNotionPushing(false);
    }
  }, [pipeline.rows]);

  return (
    <div className="app-page space-y-6">
      <section className="page-hero">
        <div className="grid gap-8 lg:grid-cols-[1.2fr_0.8fr]">
          <div>
            <div className="inline-flex w-fit items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-xs text-cyan-200">
              <Files className="size-3.5" />
              PDF 双来源导入
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white md:text-5xl">
              从本机上传，或直接选择服务器上的 PDF 进行二次检索。
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-300 md:text-base">
              服务器文件入口默认只开放 `/opt/web-rearcher/output/pdfs`，适合对已缓存的 PDF 做补漏与再处理。
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
            {[
              { label: "本机文件", value: String(files.length), hint: "待上传 PDF 数量" },
              { label: "服务器文件", value: String(selectedServerPaths.length), hint: "当前已选服务器 PDF" },
              { label: "LLM 并发", value: String(llmConcurrency), hint: "提取配置" },
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

      <section className="grid gap-6 lg:grid-cols-[1.35fr_0.85fr]">
        <div className="space-y-4">
          <Tabs value={sourceTab} onValueChange={(value) => setSourceTab(value as "local" | "server")} className="space-y-4">
            <TabsList className="grid w-full grid-cols-2 rounded-[22px] border border-white/10 bg-black/20 p-1">
              <TabsTrigger value="local" className="rounded-[18px]">本机上传</TabsTrigger>
              <TabsTrigger value="server" className="rounded-[18px]">服务器文件</TabsTrigger>
            </TabsList>

            <TabsContent value="local" className="space-y-4">
              <motion.div
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={() => setDragActive(false)}
                onDrop={handleDrop}
                whileHover={{ y: -2 }}
                className={`panel p-6 transition-colors ${
                  dragActive ? "border-cyan-300/30 bg-cyan-400/[0.05]" : ""
                }`}
              >
                <div className="flex flex-col items-start gap-5 md:flex-row md:items-center md:justify-between">
                  <div className="space-y-3">
                    <div className="flex size-12 items-center justify-center rounded-2xl border border-cyan-400/20 bg-cyan-400/10 text-cyan-300">
                      <Upload className="size-5" />
                    </div>
                    <div>
                      <h2 className="text-xl font-semibold tracking-tight text-white">上传本机 PDF 文件</h2>
                      <p className="mt-2 text-sm leading-6 text-zinc-400">
                        支持拖拽上传和批量选择，仅接受 `.pdf` 文件。
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <Button variant="outline" onClick={() => inputRef.current?.click()}>
                      <Upload className="size-3.5" data-icon="inline-start" />
                      选择 PDF
                    </Button>
                    <Button
                      onClick={handleLocalSubmit}
                      disabled={files.length === 0 || pipeline.running}
                      className="bg-cyan-400 text-slate-950 hover:bg-cyan-300"
                    >
                      {pipeline.running ? (
                        <Loader2 className="size-3.5 animate-spin" data-icon="inline-start" />
                      ) : (
                        <Play className="size-3.5" data-icon="inline-start" />
                      )}
                      开始处理
                    </Button>
                  </div>
                </div>

                <input
                  ref={inputRef}
                  type="file"
                  multiple
                  accept=".pdf,application/pdf"
                  onChange={handleFileInput}
                  className="hidden"
                />

                <div className="mt-5 flex flex-wrap gap-2">
                  <Badge variant="outline" className="border-white/10 text-zinc-300">
                    {files.length} 个文件
                  </Badge>
                  <Badge variant="outline" className="border-white/10 text-zinc-300">
                    总大小 {formatFileSize(totalSize)}
                  </Badge>
                </div>
              </motion.div>

              <AnimatePresence initial={false}>
                {files.length > 0 ? (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    className="panel p-5"
                  >
                    <div className="mb-4 flex items-center justify-between">
                      <div>
                        <p className="page-kicker">文件列表</p>
                        <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">待处理 PDF</h2>
                        <p className="mt-2 text-sm text-zinc-400">重复文件会自动去重，文件过多时会自动折叠显示。</p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setFiles([]);
                          setFilesExpanded(false);
                        }}
                        className="text-zinc-400 hover:text-zinc-200"
                      >
                        <Trash2 className="size-3.5" data-icon="inline-start" />
                        清空
                      </Button>
                    </div>

                    <div className="space-y-2">
                      {visibleFiles.map((file) => (
                        <div
                          key={`${file.name}:${file.size}:${file.lastModified}`}
                          className="flex items-center justify-between rounded-[22px] border border-white/8 bg-white/[0.025] px-4 py-3"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 text-sm text-zinc-100">
                              <FileText className="size-4 shrink-0 text-cyan-300" />
                              <span className="truncate">{file.name}</span>
                            </div>
                            <p className="mt-1 text-xs text-zinc-500">{formatFileSize(file.size)}</p>
                          </div>
                          <button
                            onClick={() =>
                              setFiles((current) =>
                                current.filter(
                                  (item) =>
                                    !(
                                      item.name === file.name &&
                                      item.size === file.size &&
                                      item.lastModified === file.lastModified
                                    ),
                                ),
                              )
                            }
                            className="rounded-full p-2 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
                            aria-label={`移除 ${file.name}`}
                          >
                            <X className="size-4" />
                          </button>
                        </div>
                      ))}
                    </div>

                    {shouldCollapseFiles ? (
                      <div className="mt-3 flex items-center justify-between rounded-[22px] border border-white/8 bg-white/[0.025] px-4 py-3">
                        <p className="text-xs text-zinc-500">
                          {filesExpanded
                            ? `已展开全部 ${files.length} 个文件`
                            : `还有 ${hiddenFileCount} 个文件已折叠，避免列表过长`}
                        </p>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setFilesExpanded((current) => !current)}
                          className="text-zinc-300 hover:text-zinc-100"
                        >
                          {filesExpanded ? (
                            <ChevronUp className="size-3.5" data-icon="inline-start" />
                          ) : (
                            <ChevronDown className="size-3.5" data-icon="inline-start" />
                          )}
                          {filesExpanded ? "收起" : "展开全部"}
                        </Button>
                      </div>
                    ) : null}
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </TabsContent>

            <TabsContent value="server" className="space-y-4">
              <div className="panel p-6">
                <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                  <div className="space-y-3">
                    <div className="flex size-12 items-center justify-center rounded-2xl border border-cyan-400/20 bg-cyan-400/10 text-cyan-300">
                      <Server className="size-5" />
                    </div>
                    <div>
                      <h2 className="text-xl font-semibold tracking-tight text-white">选择服务器上的 PDF</h2>
                      <p className="mt-2 text-sm leading-6 text-zinc-400">
                        浏览 `/opt/web-rearcher/output/pdfs` 中的 PDF，适合对已缓存文件做二次检索与补漏。
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <Button variant="outline" onClick={() => void loadServerFiles()} disabled={serverFilesLoading}>
                      {serverFilesLoading ? (
                        <Loader2 className="size-3.5 animate-spin" data-icon="inline-start" />
                      ) : (
                        <RefreshCw className="size-3.5" data-icon="inline-start" />
                      )}
                      刷新列表
                    </Button>
                    <Button
                      onClick={handleServerSubmit}
                      disabled={selectedServerPaths.length === 0 || pipeline.running}
                      className="bg-cyan-400 text-slate-950 hover:bg-cyan-300"
                    >
                      {pipeline.running ? (
                        <Loader2 className="size-3.5 animate-spin" data-icon="inline-start" />
                      ) : (
                        <Play className="size-3.5" data-icon="inline-start" />
                      )}
                      处理已选文件
                    </Button>
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap gap-2">
                  <Badge variant="outline" className="border-white/10 text-zinc-300">
                    已选 {selectedServerPaths.length} 个文件
                  </Badge>
                  <Badge variant="outline" className="border-white/10 text-zinc-300">
                    总大小 {formatFileSize(selectedServerSize)}
                  </Badge>
                </div>
              </div>

              {serverFilesError ? (
                <div className="rounded-[22px] border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                  {serverFilesError}
                </div>
              ) : null}

              <div className="panel p-5">
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <p className="page-kicker">服务器文件</p>
                    <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">output/pdfs</h2>
                    <p className="mt-2 text-sm text-zinc-400">只显示服务器缓存目录中的 PDF，点击即可选中或取消选中。</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleSelectAllServerFiles}
                    className="text-zinc-300 hover:text-zinc-100"
                    disabled={serverFiles.length === 0 || selectedServerPaths.length === serverFiles.length}
                  >
                    全部选中
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleClearAllServerFiles}
                    className="text-zinc-400 hover:text-zinc-200"
                    disabled={selectedServerPaths.length === 0}
                  >
                    <Trash2 className="size-3.5" data-icon="inline-start" />
                    清空选择
                  </Button>
                </div>

                {serverFilesLoading ? (
                  <div className="flex items-center gap-3 rounded-[22px] border border-white/8 bg-white/[0.025] px-4 py-5 text-sm text-zinc-400">
                    <Loader2 className="size-4 animate-spin" />
                    正在读取服务器 PDF 列表...
                  </div>
                ) : serverFiles.length === 0 ? (
                  <div className="flex items-center gap-3 rounded-[22px] border border-dashed border-white/10 bg-white/[0.025] px-4 py-5 text-sm text-zinc-500">
                    <FolderOpen className="size-4" />
                    当前 `output/pdfs` 中还没有可选 PDF。
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="rounded-[20px] border border-white/8 bg-white/[0.03] px-4 py-3">
                      <p className="text-sm font-medium text-white">按天分组</p>
                      <div className="mt-3 space-y-2">
                        {serverPdfGroups.map((group) => {
                          const groupPaths = group.entries.map((entry) => entry.path);
                          const selectedCount = groupPaths.filter((path) => selectedServerPaths.includes(path)).length;
                          const allSelected = selectedCount === groupPaths.length;

                          return (
                            <div key={group.key} className="flex flex-col gap-3 rounded-[16px] border border-white/8 bg-black/20 px-3 py-3 md:flex-row md:items-center md:justify-between">
                              <div>
                                <p className="text-sm font-medium text-white">{group.label}</p>
                                <p className="mt-1 text-xs text-zinc-500">
                                  {group.entries.length} 个文件 · {formatFileSize(group.totalSize)}
                                </p>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleSelectServerGroup(groupPaths)}
                                  className="text-zinc-300 hover:text-zinc-100"
                                  disabled={allSelected}
                                >
                                  选中本组
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleClearServerGroup(groupPaths)}
                                  className="text-zinc-400 hover:text-zinc-200"
                                  disabled={selectedCount === 0}
                                >
                                  取消本组
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="space-y-2">
                    {serverFiles.map((entry) => {
                      const selected = selectedServerPaths.includes(entry.path);
                      return (
                        <button
                          key={entry.path}
                          type="button"
                          onClick={() => toggleServerPath(entry.path)}
                          className={`flex w-full items-start justify-between rounded-[22px] border px-4 py-3 text-left transition ${
                            selected
                              ? "border-cyan-300/30 bg-cyan-400/[0.08]"
                              : "border-white/8 bg-white/[0.025] hover:border-white/15"
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 text-sm text-zinc-100">
                              <FileText className="size-4 shrink-0 text-cyan-300" />
                              <span className="truncate">{entry.name}</span>
                            </div>
                            <p className="mt-1 text-xs text-zinc-500">{entry.path}</p>
                            <p className="mt-1 text-xs text-zinc-500">
                              {formatFileSize(entry.size)} · {formatTimestamp(entry.modified_at)}
                            </p>
                          </div>
                          <Badge variant="outline" className={selected ? "border-cyan-300/30 text-cyan-100" : "border-white/10 text-zinc-400"}>
                            {selected ? "已选中" : "点击选择"}
                          </Badge>
                        </button>
                      );
                    })}
                    </div>
                  </div>
                )}
              </div>
            </TabsContent>
          </Tabs>
        </div>

        <div className="panel p-5">
          <p className="page-kicker">处理设置</p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">导入参数</h2>
          <p className="mt-2 text-sm leading-6 text-zinc-400">
            本机上传与服务器文件都会复用同一条 PDF 解析、质量筛选与字段提取流程。
          </p>

          <Separator className="my-5 bg-white/8" />

          <div className="space-y-5">
            <div className="panel-muted p-4">
              <p className="text-xs font-medium text-zinc-400">提取模式</p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Button variant={mode === "multi" ? "default" : "outline"} onClick={() => setMode("multi")}>
                  多 Agent
                </Button>
                <Button variant={mode === "single" ? "default" : "outline"} onClick={() => setMode("single")}>
                  单流程
                </Button>
              </div>
            </div>

            <div className="panel-muted p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-zinc-300">LLM 并发</p>
                <span className="text-xs tabular-nums text-zinc-500">{llmConcurrency}</span>
              </div>
              <Slider
                className="mt-4"
                min={1}
                max={12}
                step={1}
                value={[llmConcurrency]}
                onValueChange={(value) => setLlmConcurrency(Array.isArray(value) ? value[0] : value)}
              />
              <p className="mt-3 text-[11px] leading-5 text-zinc-500">
                文件较多时可适当提高并发；若模型接口限速明显，建议保持在 3 到 6。
              </p>
            </div>
          </div>
        </div>
      </section>

      {pipeline.taskId ? (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
          <div className="flex justify-end">
            <Link href={`/tasks?task=${encodeURIComponent(pipeline.taskId)}`}>
              <Button variant="outline" size="sm">
                <Server className="size-3.5" data-icon="inline-start" />
                在任务中心查看
              </Button>
            </Link>
          </div>
        </motion.div>
      ) : null}

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
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="space-y-4"
        >
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="page-kicker">结果</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">处理结果</h2>
              <p className="mt-2 text-sm text-zinc-400">
                共返回 {pipeline.rows.length} 条记录，包含成功提取和未通过筛选的文件。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setNotionResult(null);
                  setNotionDialogOpen(true);
                }}
              >
                <Server className="size-3.5" data-icon="inline-start" />
                推送到 Notion
              </Button>
              <ExportMenu rows={pipeline.rows} />
            </div>
          </div>

          <ResultsTable rows={pipeline.rows} onRowClick={(row) => setSelectedPaper(row)} />
        </motion.div>
      ) : null}

      <PaperDetail paper={selectedPaper} open={!!selectedPaper} onClose={() => setSelectedPaper(null)} />

      <Dialog open={notionDialogOpen} onOpenChange={setNotionDialogOpen}>
        <DialogContent className="border-white/10 bg-[linear-gradient(180deg,rgba(9,12,20,0.98),rgba(8,10,16,0.96))] sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-white">推送到 Notion</DialogTitle>
            <DialogDescription className="text-zinc-400">
              将当前 PDF 处理结果写入 Notion 数据库。
            </DialogDescription>
          </DialogHeader>

          {notionResult ? (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-[22px] border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm"
            >
              <p className="font-medium text-emerald-300">
                成功推送 {notionResult.pushed} 条，过滤 {notionResult.skipped_quality} 条低质量记录，跳过 {notionResult.skipped_duplicate} 条重复记录。
              </p>
              <p className="mt-2 text-xs text-emerald-100/75">
                共处理 {notionResult.total} 条。
              </p>
            </motion.div>
          ) : (
            <div className="space-y-3 rounded-[22px] border border-white/8 bg-white/[0.03] p-4 text-sm text-zinc-300">
              <div className="flex items-center gap-2 text-cyan-200">
                <Files className="size-4" />
                <span>系统会自动跳过重复或低质量结果。</span>
              </div>
              <p>
                共 <span className="font-semibold text-white">{notionStats.total}</span> 条结果
              </p>
              <p className="text-xs text-zinc-500">
                其中 {notionStats.invalid} 条可能因质量为 0 或缺少关键字段而被过滤。
              </p>
            </div>
          )}

          <DialogFooter>
            {notionResult ? (
              <Button variant="outline" onClick={() => setNotionDialogOpen(false)}>
                关闭
              </Button>
            ) : (
              <Button onClick={handleNotionPush} disabled={notionPushing}>
                {notionPushing ? (
                  <Loader2 className="size-3.5 animate-spin" data-icon="inline-start" />
                ) : (
                  <Server className="size-3.5" data-icon="inline-start" />
                )}
                确认推送
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
