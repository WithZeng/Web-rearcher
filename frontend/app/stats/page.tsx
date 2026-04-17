"use client";

import { useEffect, useState } from "react";
import { motion, useSpring, useTransform } from "framer-motion";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, type HistoryStats } from "@/lib/api";

function AnimatedNumber({
  value,
  suffix = "",
}: {
  value: number;
  suffix?: string;
}) {
  const spring = useSpring(0, { stiffness: 60, damping: 20 });
  const display = useTransform(spring, (v) =>
    suffix === "%" ? `${v.toFixed(1)}%` : Math.round(v).toLocaleString(),
  );

  useEffect(() => {
    spring.set(value);
  }, [spring, value]);

  return <motion.span>{display}</motion.span>;
}

export default function StatsPage() {
  const [stats, setStats] = useState<HistoryStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.history
      .stats()
      .then(setStats)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="app-page">
        <div className="panel flex h-64 items-center justify-center text-sm text-zinc-500">
          加载中...
        </div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="app-page">
        <div className="panel flex h-64 items-center justify-center text-sm text-zinc-500">
          无法加载统计数据
        </div>
      </div>
    );
  }

  const sourceData = Object.entries(stats.source_counts).map(([name, value]) => ({ name, value }));
  const qualityPercent = stats.avg_quality * 100;
  const qualityData = [
    { name: "高质量", value: Math.round(stats.total_papers * stats.avg_quality) },
    {
      name: "中等",
      value: Math.round(stats.total_papers * (1 - stats.avg_quality) * 0.6),
    },
    {
      name: "低质量",
      value: Math.round(stats.total_papers * (1 - stats.avg_quality) * 0.4),
    },
  ];

  return (
    <div className="app-page space-y-6">
      <section className="page-hero">
        <p className="page-kicker">统计分析</p>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white md:text-5xl">
          查看当前文献库的整体情况。
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-300 md:text-base">
          这里会展示任务数量、论文数量、检索规模和数据质量等核心统计信息。
        </p>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <MetricCard label="总检索次数" value={stats.total_tasks} />
        <MetricCard label="总论文数" value={stats.total_papers} />
        <MetricCard label="平均数据质量" value={qualityPercent} suffix="%" />
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <MetricCard label="原始命中总量" value={stats.total_raw_hits} />
        <MetricCard label="去重后总量" value={stats.total_deduped_hits} />
        <MetricCard label="平均有效占比" value={stats.avg_effective_ratio} suffix="%" />
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="panel min-w-0 p-5 md:p-6">
          <p className="page-kicker">来源分布</p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">文献来源统计</h2>
          <p className="mt-2 text-sm text-zinc-400">显示当前历史数据按文本来源的分布情况。</p>

          {sourceData.length > 0 ? (
            <div className="mt-6 h-80 min-h-[320px] min-w-0">
              <ResponsiveContainer width="100%" height="100%" minWidth={240} minHeight={280}>
                <BarChart data={sourceData} layout="vertical" margin={{ left: 80, right: 24, top: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" horizontal={false} />
                  <XAxis type="number" tick={{ fill: "#71717a", fontSize: 12 }} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tick={{ fill: "#cbd5e1", fontSize: 12 }}
                    width={76}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#0b1120",
                      border: "1px solid rgba(255,255,255,0.08)",
                      borderRadius: 14,
                      fontSize: 12,
                      color: "#f4f4f5",
                    }}
                    labelStyle={{ color: "#f4f4f5" }}
                    itemStyle={{ color: "#67e8f9" }}
                  />
                  <Bar dataKey="value" fill="#38bdf8" radius={[0, 10, 10, 0]} barSize={18} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="mt-6 text-sm text-zinc-500">暂无数据</p>
          )}
        </div>

        <div className="panel min-w-0 p-5 md:p-6">
          <p className="page-kicker">质量分布</p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">数据质量概览</h2>
          <p className="mt-2 text-sm text-zinc-400">基于现有平均质量给出一个直观分布概览。</p>

          <div className="mt-6 h-80 min-h-[320px] min-w-0">
            <ResponsiveContainer width="100%" height="100%" minWidth={240} minHeight={280}>
              <BarChart data={qualityData} margin={{ left: 12, right: 12, top: 8, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                <XAxis dataKey="name" tick={{ fill: "#cbd5e1", fontSize: 12 }} />
                <YAxis tick={{ fill: "#71717a", fontSize: 12 }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#0b1120",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 14,
                    fontSize: 12,
                    color: "#f4f4f5",
                  }}
                  labelStyle={{ color: "#f4f4f5" }}
                  itemStyle={{ color: "#67e8f9" }}
                />
                <Bar dataKey="value" fill="#22d3ee" radius={[10, 10, 0, 0]} barSize={42} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>
    </div>
  );
}

function MetricCard({
  label,
  value,
  suffix = "",
}: {
  label: string;
  value: number;
  suffix?: string;
}) {
  return (
    <div className="panel p-5 md:p-6">
      <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">{label}</p>
      <p className="mt-4 text-4xl font-semibold tracking-tight text-white">
        <AnimatedNumber value={value} suffix={suffix} />
      </p>
    </div>
  );
}
