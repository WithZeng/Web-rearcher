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

  const totalSize = useMemo(
    () => files.reduce((sum, file) => sum + file.size, 0),
    [files],
  );
  const shouldCollapseFiles = files.length >= AUTO_COLLAPSE_THRESHOLD;
  const visibleFiles = shouldCollapseFiles && !filesExpanded
    ? files.slice(0, COLLAPSED_FILE_COUNT)
    : files;
  const hiddenFileCount = files.length - visibleFiles.length;

  const showProgress = pipeline.running || pipeline.rows.length > 0;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-2">
        <div className="inline-flex w-fit items-center gap-2 rounded-full border border-blue-500/20 bg-blue-500/10 px-3 py-1 text-xs text-blue-300">
          <Files className="size-3.5" />
          本地 PDF 导入
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-100">
          上传 PDF，直接提取实验数据
        </h1>
        <p className="max-w-2xl text-sm leading-6 text-zinc-400">
          支持一次上传多个本地 PDF。系统会先解析全文，再完成质量筛选、字段提取和结果审查。
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_0.9fr]">
        <div className="space-y-4">
          <motion.div
            onDragOver={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
            whileHover={{ y: -2 }}
            className={`rounded-3xl border border-dashed p-6 transition-colors ${
              dragActive
                ? "border-blue-400/60 bg-blue-500/10"
                : "border-white/10 bg-zinc-900/50"
            }`}
          >
            <div className="flex flex-col items-start gap-4 md:flex-row md:items-center md:justify-between">
              <div className="space-y-2">
                <div className="flex size-12 items-center justify-center rounded-2xl bg-white/5 text-blue-400">
                  <Upload className="size-5" />
                </div>
                <div>
                  <h2 className="text-lg font-medium text-zinc-100">拖拽 PDF 到这里</h2>
                  <p className="text-sm text-zinc-500">
                    或者手动选择文件。仅接受 `.pdf`，支持批量上传。
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                <Button variant="outline" onClick={() => inputRef.current?.click()}>
                  <Upload className="size-3.5" data-icon="inline-start" />
                  选择 PDF
                </Button>
                <Button onClick={handleSubmit} disabled={files.length === 0 || pipeline.running}>
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
            {files.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                className="rounded-3xl border border-white/10 bg-zinc-950/60 p-4"
              >
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-medium text-zinc-100">待处理文件</h2>
                    <p className="text-xs text-zinc-500">重复文件会自动去重</p>
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
                      className="flex items-center justify-between rounded-2xl border border-white/8 bg-white/[0.02] px-4 py-3"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm text-zinc-100">
                          <FileText className="size-4 shrink-0 text-blue-400" />
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

                {shouldCollapseFiles && (
                  <div className="mt-3 flex items-center justify-between rounded-2xl border border-white/8 bg-white/[0.02] px-4 py-3">
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
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="rounded-3xl border border-white/10 bg-zinc-950/60 p-5">
          <div className="space-y-1">
            <h2 className="text-sm font-medium text-zinc-100">提取设置</h2>
            <p className="text-xs leading-5 text-zinc-500">
              本地 PDF 会跳过联网检索，直接进入质量筛选与字段提取。
            </p>
          </div>

          <Separator className="my-5 bg-white/10" />

          <div className="space-y-5">
            <div className="space-y-2">
              <p className="text-xs font-medium text-zinc-400">提取模式</p>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant={mode === "multi" ? "default" : "outline"}
                  onClick={() => setMode("multi")}
                >
                  多 Agent
                </Button>
                <Button
                  variant={mode === "single" ? "default" : "outline"}
                  onClick={() => setMode("single")}
                >
                  单流程
                </Button>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-zinc-400">LLM 并发</p>
                <span className="text-xs tabular-nums text-zinc-500">{llmConcurrency}</span>
              </div>
              <Slider
                min={1}
                max={12}
                step={1}
                value={[llmConcurrency]}
                onValueChange={(value) => setLlmConcurrency(Array.isArray(value) ? value[0] : value)}
              />
              <p className="text-[11px] leading-5 text-zinc-600">
                文件较多时可适当提高并发；如果模型限速明显，建议保持在 3 到 6。
              </p>
            </div>
          </div>
        </div>
      </div>

      {showProgress && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          <PipelineProgress />
        </motion.div>
      )}

      {pipeline.error && (
        <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {pipeline.error}
        </div>
      )}

      {pipeline.rows.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="space-y-4"
        >
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">提取结果</h2>
              <p className="text-sm text-zinc-500">
                共返回 {pipeline.rows.length} 条记录，包含成功提取和未通过筛选的文件。
              </p>
            </div>
            <ExportMenu rows={pipeline.rows} />
          </div>

          <ResultsTable
            rows={pipeline.rows}
            onRowClick={(row) => setSelectedPaper(row)}
          />
        </motion.div>
      )}

      <PaperDetail
        paper={selectedPaper}
        open={!!selectedPaper}
        onClose={() => setSelectedPaper(null)}
      />
    </div>
  );
}
