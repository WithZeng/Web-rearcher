"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  FileText,
  Files,
  Loader2,
  Play,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { PipelineProgress } from "@/components/pipeline-progress";
import { ResultsTable } from "@/components/results-table";
import { ExportMenu } from "@/components/export-menu";
import { PaperDetail } from "@/components/paper-detail";
import { api } from "@/lib/api";
import { connectPipeline } from "@/lib/ws";
import { useAppStore } from "@/lib/store";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

const COLLAPSED_FILE_COUNT = 3;
const AUTO_COLLAPSE_THRESHOLD = 4;

export default function PdfImportPage() {
  const pipeline = useAppStore((state) => state.pipeline);
  const setPipelineField = useAppStore((state) => state.setPipelineField);
  const resetPipeline = useAppStore((state) => state.resetPipeline);
  const handlePipelineMessage = useAppStore((state) => state.handlePipelineMessage);

  const [files, setFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [llmConcurrency, setLlmConcurrency] = useState(5);
  const [mode, setMode] = useState<"single" | "multi">("multi");
  const [selectedPaper, setSelectedPaper] = useState<Record<string, unknown> | null>(null);
  const [filesExpanded, setFilesExpanded] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const wsCloseRef = useRef<(() => void) | null>(null);
  const reconnectedRef = useRef(false);

  useEffect(() => {
    if (reconnectedRef.current) return;
    const taskId = pipeline.taskId;
    const alreadyDone = pipeline.currentStage === "done" || pipeline.currentStage === "error";
    if (!taskId || pipeline.running || alreadyDone) return;

    reconnectedRef.current = true;
    api.pipeline.status(taskId).then((status) => {
      if (!status.done && !status.error) {
        setPipelineField("running", true);
        wsCloseRef.current?.();
        const { close } = connectPipeline(taskId, handlePipelineMessage, () => {
          wsCloseRef.current = null;
        });
        wsCloseRef.current = close;
      }
    }).catch(() => {});
  }, [pipeline.taskId, pipeline.running, pipeline.currentStage, setPipelineField, handlePipelineMessage]);

  useEffect(() => {
    return () => {
      wsCloseRef.current?.();
    };
  }, []);

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

  const handleSubmit = useCallback(async () => {
    if (files.length === 0 || pipeline.running) return;

    resetPipeline();
    setPipelineField("running", true);
    setPipelineField("startedAt", Date.now());

    try {
      const { task_id } = await api.pipeline.pdf(files, {
        mode,
        llm_concurrency: llmConcurrency,
      });

      setPipelineField("taskId", task_id);
      setPipelineField("progress", 0);

      wsCloseRef.current?.();
      const { close } = connectPipeline(task_id, handlePipelineMessage, () => {
        wsCloseRef.current = null;
      });
      wsCloseRef.current = close;
    } catch (error) {
      setPipelineField("error", error instanceof Error ? error.message : "PDF 上传失败");
      setPipelineField("running", false);
    }
  }, [
    files,
    mode,
    llmConcurrency,
    pipeline.running,
    resetPipeline,
    setPipelineField,
    handlePipelineMessage,
  ]);

  const totalSize = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);
  const shouldCollapseFiles = files.length >= AUTO_COLLAPSE_THRESHOLD;
  const visibleFiles = shouldCollapseFiles && !filesExpanded ? files.slice(0, COLLAPSED_FILE_COUNT) : files;
  const hiddenFileCount = files.length - visibleFiles.length;

  const showProgress = pipeline.running || pipeline.rows.length > 0;

  return (
    <div className="app-page space-y-6">
      <section className="page-hero">
        <div className="grid gap-8 lg:grid-cols-[1.2fr_0.8fr]">
          <div>
            <div className="inline-flex w-fit items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-xs text-cyan-200">
              <Files className="size-3.5" />
              本地 PDF
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white md:text-5xl">
              上传本地 PDF，开始提取文献信息。
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-300 md:text-base">
              支持批量上传、自动折叠文件列表、进度跟踪和结果导出。
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
            {[
              { label: "待处理", value: String(files.length), hint: "PDF 文件数" },
              { label: "总大小", value: formatFileSize(totalSize), hint: "当前上传队列" },
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
                  <h2 className="text-xl font-semibold tracking-tight text-white">上传 PDF 文件</h2>
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
                  onClick={handleSubmit}
                  disabled={files.length === 0 || pipeline.running}
                  className="bg-cyan-400 text-slate-950 hover:bg-cyan-300"
                >
                  {pipeline.running ? (
                    <Loader2 className="size-3.5 animate-spin" data-icon="inline-start" />
                  ) : (
                    <Play className="size-3.5" data-icon="inline-start" />
                  )}
                  开始提取
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
        </div>

        <div className="panel p-5">
          <p className="page-kicker">提取设置</p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">处理参数</h2>
          <p className="mt-2 text-sm leading-6 text-zinc-400">
            本地 PDF 会跳过联网检索，直接进入文本解析和字段提取。
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
            <ExportMenu rows={pipeline.rows} />
          </div>

          <ResultsTable rows={pipeline.rows} onRowClick={(row) => setSelectedPaper(row)} />
        </motion.div>
      ) : null}

      <PaperDetail paper={selectedPaper} open={!!selectedPaper} onClose={() => setSelectedPaper(null)} />
    </div>
  );
}
