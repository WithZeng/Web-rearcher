"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry } from "ag-grid-community";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { Switch } from "@/components/ui/switch";
import { useAppStore } from "@/lib/store";

ModuleRegistry.registerModules([AllCommunityModule]);

const QUALITY_COLORS: Record<string, string> = {
  high_value: "text-emerald-400",
  medium_value: "text-amber-300",
  low_value: "text-rose-400",
};

const REVIEW_COLORS: Record<string, string> = {
  ok: "text-emerald-400",
  suspicious: "text-amber-300",
  low_quality: "text-rose-400",
};

function QualityPercentRenderer(params: ICellRendererParams) {
  const val = Number(params.value);
  if (Number.isNaN(val)) return <span className="text-zinc-600">--</span>;
  const pct = Math.round(val * 100);
  const color = pct >= 70 ? "text-emerald-400" : pct >= 40 ? "text-amber-300" : "text-rose-400";
  return <span className={`font-medium ${color}`}>{pct}%</span>;
}

function QualityLabelRenderer(params: ICellRendererParams) {
  const label = String(params.value ?? "");
  const color = QUALITY_COLORS[label] ?? "text-zinc-500";
  const display: Record<string, string> = {
    high_value: "高",
    medium_value: "中",
    low_value: "低",
  };
  return <span className={`text-xs font-medium ${color}`}>{display[label] ?? label}</span>;
}

function ReviewRenderer(params: ICellRendererParams) {
  const val = String(params.value ?? "");
  const color = REVIEW_COLORS[val] ?? "text-zinc-500";
  const display: Record<string, string> = {
    ok: "通过",
    suspicious: "待复核",
    low_quality: "低质量",
  };
  return <span className={`text-xs font-medium ${color}`}>{display[val] ?? val}</span>;
}

function PushedRenderer(params: ICellRendererParams) {
  if (!params.value) return <span className="text-zinc-600">--</span>;
  return <span className="text-xs font-medium text-emerald-400">已推送</span>;
}

function SkipReasonRenderer(params: ICellRendererParams) {
  const val = String(params.value ?? "");
  if (!val) return <span className="text-zinc-600">--</span>;
  return (
    <span className="text-xs text-rose-300" title={val}>
      {val.length > 30 ? `${val.slice(0, 30)}...` : val}
    </span>
  );
}

const META_COLUMNS: ColDef[] = [
  { field: "_data_quality", headerName: "数据质量", width: 108, cellRenderer: QualityPercentRenderer },
  { field: "_quality_label", headerName: "质量等级", width: 96, cellRenderer: QualityLabelRenderer },
  { field: "_review", headerName: "复核状态", width: 104, cellRenderer: ReviewRenderer },
  { field: "text_source", headerName: "文本来源", width: 110 },
  { field: "_skip_reason", headerName: "失败原因", width: 180, cellRenderer: SkipReasonRenderer },
  { field: "_pushed_to_notion", headerName: "Notion", width: 92, cellRenderer: PushedRenderer },
];

interface ResultsTableProps {
  rows: Record<string, unknown>[];
  onRowClick?: (row: Record<string, unknown>) => void;
}

export function ResultsTable({ rows, onRowClick }: ResultsTableProps) {
  const gridRef = useRef<AgGridReact>(null);
  const meta = useAppStore((s) => s.meta);
  const [showAll, setShowAll] = useState(false);

  const filteredRows = useMemo(() => {
    if (showAll) return rows;
    return rows.filter((r) => {
      const q = Number(r._data_quality);
      return !Number.isNaN(q) && q > 0;
    });
  }, [rows, showAll]);

  const hiddenCount = rows.length - filteredRows.length;

  const columnDefs = useMemo<ColDef[]>(() => {
    if (!meta) {
      if (rows.length === 0) return [];
      return Object.keys(rows[0]).map((key) => ({
        field: key,
        headerName: key,
        minWidth: 140,
        resizable: true,
        sortable: true,
        filter: true,
      }));
    }

    const fieldCols: ColDef[] = meta.fields.map((f) => ({
      field: f,
      headerName: meta.field_labels[f] ?? f,
      minWidth: 130,
      flex: f === "source_title" ? 2 : undefined,
      resizable: true,
      sortable: true,
      filter: true,
    }));

    return [...fieldCols, ...META_COLUMNS];
  }, [meta, rows]);

  const onRowClicked = useCallback(
    (event: { data: Record<string, unknown> }) => {
      onRowClick?.(event.data);
    },
    [onRowClick],
  );

  const stats = useMemo(() => {
    if (filteredRows.length === 0) return null;
    const qualities = filteredRows.map((r) => Number(r._data_quality)).filter((v) => !Number.isNaN(v));
    const avgQ = qualities.length ? qualities.reduce((a, b) => a + b, 0) / qualities.length : 0;
    const ftCount = filteredRows.filter(
      (r) => r.text_source && r.text_source !== "none" && r.text_source !== "abstract",
    ).length;
    const failedCount = filteredRows.filter((r) => r._skip_reason).length;
    return {
      total: filteredRows.length,
      avgQuality: Math.round(avgQ * 100),
      fulltextRate: Math.round((ftCount / filteredRows.length) * 100),
      failedCount,
    };
  }, [filteredRows]);

  if (rows.length === 0) {
    return (
      <div className="panel flex h-48 items-center justify-center p-6 text-sm text-zinc-500">
        暂无数据
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      className="data-grid-shell"
    >
      <div className="mb-4 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="page-kicker">Result Matrix</p>
          <h3 className="mt-2 text-lg font-semibold tracking-tight text-white">结构化结果表</h3>
          {stats ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-white/8 bg-white/[0.035] px-3 py-2 text-xs text-zinc-400">
                总计 <span className="ml-2 font-semibold text-zinc-100">{stats.total}</span>
              </span>
              <span className="rounded-full border border-white/8 bg-white/[0.035] px-3 py-2 text-xs text-zinc-400">
                平均质量
                <span
                  className={`ml-2 font-semibold ${
                    stats.avgQuality >= 70
                      ? "text-emerald-400"
                      : stats.avgQuality >= 40
                        ? "text-amber-300"
                        : "text-rose-400"
                  }`}
                >
                  {stats.avgQuality}%
                </span>
              </span>
              <span className="rounded-full border border-white/8 bg-white/[0.035] px-3 py-2 text-xs text-zinc-400">
                全文命中 <span className="ml-2 font-semibold text-zinc-100">{stats.fulltextRate}%</span>
              </span>
              {stats.failedCount > 0 ? (
                <span className="rounded-full border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                  失败 {stats.failedCount} 条
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-3 self-start lg:self-center">
          <Switch size="sm" checked={showAll} onCheckedChange={setShowAll} />
          <AnimatePresence mode="wait">
            <motion.span
              key={showAll ? "all" : "filtered"}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-xs text-zinc-500"
            >
              {showAll
                ? `显示全部 ${rows.length} 条`
                : `显示 ${filteredRows.length}/${rows.length} 条，隐藏 ${hiddenCount} 条低质量记录`}
            </motion.span>
          </AnimatePresence>
        </div>
      </div>

      <div
        className="ag-theme-alpine-dark w-full"
        style={{ height: `min(calc(100vh - 380px), ${Math.min(filteredRows.length * 42 + 56, 620)}px)` }}
      >
        <AgGridReact
          ref={gridRef}
          rowData={filteredRows}
          columnDefs={columnDefs}
          onRowClicked={onRowClicked}
          animateRows
          pagination
          paginationPageSize={20}
          suppressCellFocus
          rowSelection="single"
          defaultColDef={{
            sortable: true,
            filter: true,
            resizable: true,
            minWidth: 100,
          }}
        />
      </div>
    </motion.div>
  );
}
