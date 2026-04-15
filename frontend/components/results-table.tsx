"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry } from "ag-grid-community";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { Switch } from "@/components/ui/switch";
import { useAppStore } from "@/lib/store";

ModuleRegistry.registerModules([AllCommunityModule]);

const QUALITY_COLORS: Record<string, string> = {
  high_value: "text-emerald-400",
  medium_value: "text-yellow-400",
  low_value: "text-red-400",
};

const REVIEW_COLORS: Record<string, string> = {
  ok: "text-emerald-400",
  suspicious: "text-yellow-400",
  low_quality: "text-red-400",
};

function QualityPercentRenderer(params: ICellRendererParams) {
  const val = Number(params.value);
  if (isNaN(val)) return <span className="text-zinc-600">—</span>;
  const pct = Math.round(val * 100);
  const color = pct >= 70 ? "text-emerald-400" : pct >= 40 ? "text-yellow-400" : "text-red-400";
  return <span className={color}>{pct}%</span>;
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
  return <span className={color}>{val}</span>;
}

function PushedRenderer(params: ICellRendererParams) {
  if (!params.value) return <span className="text-zinc-600">—</span>;
  return <span className="text-emerald-400 text-xs">✓ 已推送</span>;
}

function SkipReasonRenderer(params: ICellRendererParams) {
  const val = String(params.value ?? "");
  if (!val) return <span className="text-zinc-600">—</span>;
  return (
    <span className="text-red-400 text-xs" title={val}>
      {val.length > 30 ? val.slice(0, 30) + "…" : val}
    </span>
  );
}

const META_COLUMNS: ColDef[] = [
  {
    field: "_data_quality",
    headerName: "数据质量",
    width: 100,
    cellRenderer: QualityPercentRenderer,
  },
  {
    field: "_quality_label",
    headerName: "质量等级",
    width: 90,
    cellRenderer: QualityLabelRenderer,
  },
  {
    field: "_review",
    headerName: "审查",
    width: 100,
    cellRenderer: ReviewRenderer,
  },
  { field: "text_source", headerName: "文本来源", width: 110 },
  {
    field: "_skip_reason",
    headerName: "失败原因",
    width: 160,
    cellRenderer: SkipReasonRenderer,
  },
  {
    field: "_pushed_to_notion",
    headerName: "Notion",
    width: 90,
    cellRenderer: PushedRenderer,
  },
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
      return !isNaN(q) && q > 0;
    });
  }, [rows, showAll]);

  const hiddenCount = rows.length - filteredRows.length;

  const columnDefs = useMemo<ColDef[]>(() => {
    if (!meta) {
      if (rows.length === 0) return [];
      return Object.keys(rows[0]).map((key) => ({
        field: key,
        headerName: key,
        minWidth: 120,
        resizable: true,
        sortable: true,
        filter: true,
      }));
    }

    const fieldCols: ColDef[] = meta.fields.map((f) => ({
      field: f,
      headerName: meta.field_labels[f] ?? f,
      minWidth: 120,
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
    const qualities = filteredRows
      .map((r) => Number(r._data_quality))
      .filter((v) => !isNaN(v));
    const avgQ = qualities.length
      ? qualities.reduce((a, b) => a + b, 0) / qualities.length
      : 0;
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
      <div className="flex h-48 items-center justify-center text-sm text-zinc-500">
        暂无数据
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
    >
      <div className="mb-3 flex items-center justify-between">
        {stats && (
          <div className="flex items-center gap-6 text-xs text-zinc-400">
            <span>
              共 <span className="font-medium text-zinc-200">{stats.total}</span> 条
            </span>
            <span>
              平均质量{" "}
              <span
                className={`font-medium ${
                  stats.avgQuality >= 70
                    ? "text-emerald-400"
                    : stats.avgQuality >= 40
                      ? "text-yellow-400"
                      : "text-red-400"
                }`}
              >
                {stats.avgQuality}%
              </span>
            </span>
            <span>
              全文获取率{" "}
              <span className="font-medium text-zinc-200">{stats.fulltextRate}%</span>
            </span>
            {stats.failedCount > 0 && (
              <span>
                失败{" "}
                <span className="font-medium text-red-400">{stats.failedCount}</span> 条
              </span>
            )}
          </div>
        )}
        <div className="flex items-center gap-2">
          <Switch
            size="sm"
            checked={showAll}
            onCheckedChange={setShowAll}
          />
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
                : `显示 ${filteredRows.length}/${rows.length} 条（隐藏 ${hiddenCount} 条无效数据）`}
            </motion.span>
          </AnimatePresence>
        </div>
      </div>
      <div
        className="ag-theme-alpine-dark w-full"
        style={{ height: `min(calc(100vh - 400px), ${Math.min(filteredRows.length * 42 + 56, 600)}px)` }}
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
