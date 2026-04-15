"use client";

import { useEffect, useState } from "react";
import { motion, useSpring, useTransform } from "framer-motion";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { Separator } from "@/components/ui/separator";
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
      <div className="flex h-64 items-center justify-center text-sm text-zinc-500">
        加载中...
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-zinc-500">
        无法加载统计数据
      </div>
    );
  }

  const sourceData = Object.entries(stats.source_counts).map(
    ([name, value]) => ({ name, value }),
  );

  const qualityPercent = stats.avg_quality * 100;

  return (
    <div className="mx-auto max-w-4xl space-y-8 px-6 py-10">
      <h1 className="text-xl font-semibold tracking-tight text-zinc-100">
        统计面板
      </h1>

      {/* Metric cards */}
      <div className="grid grid-cols-3 gap-6">
        <MetricCard label="总检索次数" value={stats.total_tasks} />
        <MetricCard label="总论文数" value={stats.total_papers} />
        <MetricCard
          label="平均数据质量"
          value={qualityPercent}
          suffix="%"
        />
      </div>

      <Separator />

      {/* Source distribution */}
      <section className="space-y-4">
        <h2 className="text-sm font-medium text-zinc-300">文本来源分布</h2>
        {sourceData.length > 0 ? (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={sourceData}
                layout="vertical"
                margin={{ left: 80, right: 20, top: 8, bottom: 8 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="rgba(255,255,255,0.04)"
                  horizontal={false}
                />
                <XAxis type="number" tick={{ fill: "#71717a", fontSize: 12 }} />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={{ fill: "#a1a1aa", fontSize: 12 }}
                  width={70}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#18181b",
                    border: "1px solid rgba(255,255,255,0.06)",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "#e4e4e7" }}
                  itemStyle={{ color: "#3b82f6" }}
                />
                <Bar
                  dataKey="value"
                  fill="#3b82f6"
                  radius={[0, 4, 4, 0]}
                  barSize={20}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="text-sm text-zinc-500">暂无数据</p>
        )}
      </section>

      <Separator />

      {/* Quality distribution placeholder */}
      <section className="space-y-4">
        <h2 className="text-sm font-medium text-zinc-300">数据质量分布</h2>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={[
                { name: "高质量", value: Math.round(stats.total_papers * stats.avg_quality) },
                {
                  name: "中等",
                  value: Math.round(
                    stats.total_papers * (1 - stats.avg_quality) * 0.6,
                  ),
                },
                {
                  name: "低质量",
                  value: Math.round(
                    stats.total_papers * (1 - stats.avg_quality) * 0.4,
                  ),
                },
              ]}
              margin={{ left: 20, right: 20, top: 8, bottom: 8 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(255,255,255,0.04)"
                vertical={false}
              />
              <XAxis
                dataKey="name"
                tick={{ fill: "#a1a1aa", fontSize: 12 }}
              />
              <YAxis tick={{ fill: "#71717a", fontSize: 12 }} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#18181b",
                  border: "1px solid rgba(255,255,255,0.06)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelStyle={{ color: "#e4e4e7" }}
                itemStyle={{ color: "#3b82f6" }}
              />
              <Bar
                dataKey="value"
                fill="#3b82f6"
                radius={[4, 4, 0, 0]}
                barSize={40}
              />
            </BarChart>
          </ResponsiveContainer>
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
    <div className="space-y-1">
      <p className="text-xs font-medium text-zinc-500">{label}</p>
      <p className="text-2xl font-semibold tracking-tight text-zinc-100">
        <AnimatedNumber value={value} suffix={suffix} />
      </p>
    </div>
  );
}
