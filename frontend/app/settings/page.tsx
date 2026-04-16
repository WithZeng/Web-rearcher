"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  Eye,
  EyeOff,
  FileUp,
  ShieldCheck,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  api,
  type ConfigResponse,
  type EnvImportResult,
  type ModelProfile,
  type NotionStatus,
} from "@/lib/api";

type Feedback = { success: boolean; message: string };

function FeedbackBanner({ feedback }: { feedback: Feedback | null }) {
  if (!feedback) return null;
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      className={`flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm ${
        feedback.success
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
          : "border-rose-500/30 bg-rose-500/10 text-rose-200"
      }`}
    >
      {feedback.success ? (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
      ) : (
        <XCircle className="mt-0.5 size-4 shrink-0" />
      )}
      <span>{feedback.message}</span>
    </motion.div>
  );
}

function SectionShell({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[28px] border border-white/10 bg-white/[0.035] p-5 shadow-[0_24px_80px_rgba(0,0,0,0.24)] backdrop-blur">
      <p className="text-[11px] uppercase tracking-[0.28em] text-cyan-300/70">{eyebrow}</p>
      <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">{title}</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">{description}</p>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-zinc-200">{label}</span>
        {hint ? <span className="text-xs text-zinc-500">{hint}</span> : null}
      </div>
      {children}
    </label>
  );
}

export default function SettingsPage() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [models, setModels] = useState<ModelProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiType, setApiType] = useState("openai");
  const [llmFeedback, setLlmFeedback] = useState<Feedback | null>(null);
  const [notionToken, setNotionToken] = useState("");
  const [notionPageId, setNotionPageId] = useState("");
  const [notionDbName, setNotionDbName] = useState("");
  const [showNotionToken, setShowNotionToken] = useState(false);
  const [notionStatus, setNotionStatus] = useState<NotionStatus | null>(null);
  const [notionFeedback, setNotionFeedback] = useState<Feedback | null>(null);
  const [unpaywallEmail, setUnpaywallEmail] = useState("");
  const [httpProxy, setHttpProxy] = useState("");
  const [ieeeApiKey, setIeeeApiKey] = useState("");
  const [scopusApiKey, setScopusApiKey] = useState("");
  const [grobidUrl, setGrobidUrl] = useState("");
  const [researchFeedback, setResearchFeedback] = useState<Feedback | null>(null);
  const [showNewModel, setShowNewModel] = useState(false);
  const [newName, setNewName] = useState("");
  const [modelFeedback, setModelFeedback] = useState<Feedback | null>(null);
  const [blacklistCount, setBlacklistCount] = useState(0);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [importingEnv, setImportingEnv] = useState(false);
  const [importFeedback, setImportFeedback] = useState<Feedback | null>(null);
  const [importResult, setImportResult] = useState<EnvImportResult | null>(null);
  const [lastFileName, setLastFileName] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [cfg, mdls, ns, bl] = await Promise.all([
        api.config.get(),
        api.models.list(),
        api.notion.status().catch(() => null),
        api.blacklist.count().catch(() => ({ count: 0 })),
      ]);
      setConfig(cfg);
      setModels(mdls);
      setBaseUrl(cfg.base_url || "");
      setModel(cfg.model || "");
      setApiType(cfg.api_type || "openai");
      setNotionPageId(cfg.notion_parent_page_id || "");
      setNotionDbName(cfg.notion_db_name || "Team Research Database");
      setUnpaywallEmail(cfg.unpaywall_email || "");
      setHttpProxy(cfg.http_proxy || "");
      setIeeeApiKey(cfg.ieee_api_key || "");
      setScopusApiKey(cfg.scopus_api_key || "");
      setGrobidUrl(cfg.grobid_url || "");
      if (ns) setNotionStatus(ns);
      setBlacklistCount(bl?.count ?? 0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSaveLLM = useCallback(async () => {
    try {
      await api.config.update({
        api_key: apiKey || undefined,
        base_url: baseUrl,
        model,
        api_type: apiType,
      });
      setApiKey("");
      setLlmFeedback({ success: true, message: "LLM 配置已保存到当前项目环境。" });
      await fetchData();
    } catch (err) {
      setLlmFeedback({ success: false, message: String(err) });
    }
  }, [apiKey, baseUrl, model, apiType, fetchData]);

  const handleTestLLM = useCallback(async () => {
    try {
      const result = await api.config.test({
        api_key: apiKey || undefined,
        base_url: baseUrl,
        model,
        api_type: apiType,
      });
      setLlmFeedback(result);
    } catch (err) {
      setLlmFeedback({ success: false, message: String(err) });
    }
  }, [apiKey, baseUrl, model, apiType]);

  const handleSaveNotion = useCallback(async () => {
    try {
      await api.config.update({
        notion_token: notionToken || undefined,
        notion_parent_page_id: notionPageId || undefined,
        notion_db_name: notionDbName || undefined,
      });
      setNotionToken("");
      const result = await api.config.testNotion().catch(() => null);
      if (result) setNotionFeedback(result);
      const ns = await api.notion.status().catch(() => null);
      if (ns) setNotionStatus(ns);
      await fetchData();
    } catch (err) {
      setNotionFeedback({ success: false, message: String(err) });
    }
  }, [notionToken, notionPageId, notionDbName, fetchData]);

  const handleTestNotion = useCallback(async () => {
    try {
      const result = await api.config.testNotion();
      setNotionFeedback(result);
      const ns = await api.notion.status().catch(() => null);
      if (ns) setNotionStatus(ns);
    } catch (err) {
      setNotionFeedback({ success: false, message: String(err) });
    }
  }, []);

  const handleSaveResearch = useCallback(async () => {
    try {
      await api.config.update({
        unpaywall_email: unpaywallEmail || undefined,
        http_proxy: httpProxy || undefined,
        ieee_api_key: ieeeApiKey || undefined,
        scopus_api_key: scopusApiKey || undefined,
        grobid_url: grobidUrl,
      });
      setResearchFeedback({ success: true, message: "文献获取相关配置已更新。" });
      await fetchData();
    } catch (err) {
      setResearchFeedback({ success: false, message: String(err) });
    }
  }, [unpaywallEmail, httpProxy, ieeeApiKey, scopusApiKey, grobidUrl, fetchData]);

  const handleAddModel = useCallback(async () => {
    if (!newName.trim()) return;
    const profile: ModelProfile = {
      name: newName.trim(),
      base_url: baseUrl,
      model,
      api_key: apiKey || undefined,
      api_type: apiType,
    };
    try {
      const savedProfile = await api.models.create(profile);
      setModels((prev) => [...prev, savedProfile]);
      setNewName("");
      setShowNewModel(false);
      setModelFeedback({
        success: true,
        message:
          config?.has_api_key && !apiKey.trim()
            ? `已保存模型档案「${savedProfile.name}」，并继承当前 API Key。`
            : `已保存模型档案「${savedProfile.name}」。`,
      });
    } catch (err) {
      setModelFeedback({ success: false, message: String(err) });
    }
  }, [newName, baseUrl, model, apiKey, apiType, config?.has_api_key]);

  const handleDeleteModel = useCallback(async (name: string) => {
    try {
      await api.models.delete(name);
      setModels((prev) => prev.filter((item) => item.name !== name));
    } catch (err) {
      setModelFeedback({ success: false, message: String(err) });
    }
  }, []);

  const handleSwitchModel = useCallback(async (profile: ModelProfile) => {
    setBaseUrl(profile.base_url || "");
    setModel(profile.model || "");
    setApiType(profile.api_type || "openai");
    try {
      await api.models.apply(profile.name);
      setLlmFeedback({ success: true, message: `已切换到模型档案「${profile.name}」。` });
      await fetchData();
    } catch (err) {
      setLlmFeedback({ success: false, message: String(err) });
    }
  }, [fetchData]);

  const handleClearBlacklist = useCallback(async () => {
    try {
      const result = await api.blacklist.clear();
      setBlacklistCount(0);
      setClearConfirm(false);
      setResearchFeedback({
        success: true,
        message: `黑名单已清空，本次移除了 ${result.removed} 条 DOI 记录。`,
      });
    } catch (err) {
      setResearchFeedback({ success: false, message: String(err) });
    }
  }, []);

  const handleImportEnv = useCallback(async (file: File) => {
    setImportingEnv(true);
    setLastFileName(file.name);
    setImportFeedback(null);
    setImportResult(null);
    try {
      const result = await api.config.importEnv(file);
      setImportResult(result);
      setImportFeedback({
        success: true,
        message: `团队配置已导入，共写入 ${result.imported.length} 项环境变量。`,
      });
      setApiKey("");
      setNotionToken("");
      await fetchData();
    } catch (err) {
      setImportFeedback({ success: false, message: String(err) });
    } finally {
      setImportingEnv(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [fetchData]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-zinc-400">
        正在加载设置中心...
      </div>
    );
  }

  const configuredCount = [
    config?.has_api_key,
    config?.has_notion,
    Boolean(config?.unpaywall_email || config?.http_proxy),
    Boolean(config?.ieee_api_key || config?.scopus_api_key),
    Boolean(config?.grobid_url),
  ].filter(Boolean).length;

  return (
    <div className="min-h-full bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.16),transparent_30%),radial-gradient(circle_at_top_right,rgba(59,130,246,0.12),transparent_28%),linear-gradient(180deg,#060816_0%,#0b1020_44%,#080a12_100%)] px-4 py-6 md:px-8 md:py-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <section className="overflow-hidden rounded-[32px] border border-cyan-400/20 bg-[linear-gradient(135deg,rgba(10,18,36,0.96),rgba(7,10,18,0.9))] shadow-[0_30px_120px_rgba(0,0,0,0.42)]">
          <div className="grid gap-8 px-6 py-7 md:grid-cols-[1.35fr_0.95fr] md:px-8 md:py-8">
            <div className="relative">
              <p className="text-[11px] uppercase tracking-[0.34em] text-cyan-300/72">系统设置</p>
              <h1 className="mt-4 max-w-3xl text-3xl font-semibold tracking-tight text-white md:text-5xl">
                配置 AI、Notion 和文献检索所需环境。
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-300 md:text-base">
                可以上传团队共享的 `.env` 文件，快速完成模型、Notion 和数据源配置。
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                <Button
                  className="h-11 rounded-full bg-cyan-400 px-5 text-slate-950 hover:bg-cyan-300"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={importingEnv}
                >
                  <Upload className="size-4" data-icon="inline-start" />
                  {importingEnv ? "正在导入..." : "上传团队 env"}
                </Button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".env,.txt"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleImportEnv(file);
                }}
              />
              <div className="mt-8 flex flex-wrap gap-3">
                {[
                  "OPENAI_API_KEY",
                  "OPENAI_BASE_URL",
                  "OPENAI_MODEL",
                  "API_TYPE",
                  "NOTION_TOKEN",
                  "NOTION_PARENT_PAGE_ID",
                  "NOTION_DB_NAME",
                  "UNPAYWALL_EMAIL",
                  "HTTP_PROXY",
                  "GROBID_URL",
                ].map((key) => (
                  <span key={key} className="rounded-full border border-white/10 bg-white/[0.045] px-3 py-1 text-xs text-zinc-300">
                    {key}
                  </span>
                ))}
              </div>
            </div>

            <div className="grid gap-4">
              <div className="rounded-[28px] border border-white/10 bg-white/[0.055] p-5">
                <div className="flex items-center gap-3">
                  <div className="rounded-2xl bg-cyan-400/12 p-3 text-cyan-300">
                    <FileUp className="size-5" />
                  </div>
                  <div>
                    <p className="text-sm text-zinc-400">上次导入文件</p>
                    <p className="mt-1 text-base font-medium text-white">{lastFileName || "还没有导入过团队配置"}</p>
                  </div>
                </div>
                <p className="mt-4 text-sm leading-6 text-zinc-400">
                  支持上传 `.env` 或 `.txt`。系统会忽略未允许的 key，并在下面显示导入结果。
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                {[
                  { label: "已完成模块", value: `${configuredCount}/5`, tone: "text-cyan-300" },
                  { label: "模型档案", value: String(models.length), tone: "text-white" },
                  { label: "Notion 记录", value: String(notionStatus?.record_count ?? 0), tone: "text-emerald-300" },
                ].map((item) => (
                  <div key={item.label} className="rounded-[24px] border border-white/10 bg-black/20 p-4">
                    <p className="text-xs uppercase tracking-[0.22em] text-zinc-500">{item.label}</p>
                    <p className={`mt-3 text-2xl font-semibold tracking-tight ${item.tone}`}>{item.value}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <AnimatePresence>{importFeedback ? <FeedbackBanner feedback={importFeedback} /> : null}</AnimatePresence>

        {importResult ? (
          <section className="grid gap-4 md:grid-cols-3">
            <div className="rounded-[26px] border border-emerald-500/20 bg-emerald-500/8 p-5">
              <p className="text-xs uppercase tracking-[0.22em] text-emerald-300/70">已导入</p>
              <p className="mt-3 text-3xl font-semibold text-white">{importResult.imported.length}</p>
              <p className="mt-3 text-sm leading-6 text-emerald-100/80">
                {importResult.imported.length > 0 ? importResult.imported.join(", ") : "这次没有可写入的配置项。"}
              </p>
            </div>
            <div className="rounded-[26px] border border-amber-500/20 bg-amber-500/8 p-5">
              <p className="text-xs uppercase tracking-[0.22em] text-amber-300/70">警告</p>
              <p className="mt-3 text-3xl font-semibold text-white">{importResult.warnings.length}</p>
              <p className="mt-3 text-sm leading-6 text-amber-100/80">
                {importResult.warnings.length > 0 ? importResult.warnings.join("；") : "没有发现格式异常。"}
              </p>
            </div>
            <div className="rounded-[26px] border border-white/10 bg-white/[0.04] p-5">
              <p className="text-xs uppercase tracking-[0.22em] text-zinc-500">已忽略</p>
              <p className="mt-3 text-3xl font-semibold text-white">{importResult.ignored.length}</p>
              <p className="mt-3 text-sm leading-6 text-zinc-400">
                {importResult.ignored.length > 0 ? importResult.ignored.join(", ") : "上传文件中的字段都在允许范围内。"}
              </p>
            </div>
          </section>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
          <div className="space-y-6">
            <SectionShell eyebrow="AI Access" title="LLM API 配置" description="适合在共享配置后继续微调 Base URL、模型名，或切换到其他供应商。">
              <div className="grid gap-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="API 类型" hint="支持 OpenAI 兼容和 Anthropic">
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { value: "openai", label: "OpenAI 兼容" },
                        { value: "anthropic", label: "Claude / Anthropic" },
                      ].map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => setApiType(option.value)}
                          className={`rounded-2xl border px-4 py-3 text-sm transition ${
                            apiType === option.value
                              ? "border-cyan-400/40 bg-cyan-400/12 text-cyan-200"
                              : "border-white/10 bg-white/[0.03] text-zinc-400 hover:border-white/20 hover:text-zinc-200"
                          }`}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </Field>
                  <div className="rounded-[24px] border border-white/10 bg-black/20 p-4">
                    <p className="text-xs uppercase tracking-[0.22em] text-zinc-500">当前状态</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Badge className="border-cyan-400/20 bg-cyan-400/10 text-cyan-200">{apiType}</Badge>
                      <Badge className="border-white/10 bg-white/5 text-zinc-200">{model || "未设置模型"}</Badge>
                    </div>
                  </div>
                </div>

                <Field label="API Key" hint={config?.has_api_key ? "已配置，可覆盖" : "尚未配置"}>
                  <div className="relative">
                    <Input
                      type={showApiKey ? "text" : "password"}
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder={config?.has_api_key ? "输入新值即可覆盖当前 API Key" : "sk-..."}
                      className="h-12 rounded-2xl border-white/10 bg-black/20 pr-10 text-zinc-100 placeholder:text-zinc-600"
                    />
                    <button type="button" onClick={() => setShowApiKey((value) => !value)} className="absolute top-1/2 right-3 -translate-y-1/2 text-zinc-500 transition hover:text-zinc-200">
                      {showApiKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                </Field>

                <div className="grid gap-4 md:grid-cols-[1.2fr_0.8fr]">
                  <Field label="Base URL">
                    <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={apiType === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"} className="h-12 rounded-2xl border-white/10 bg-black/20 text-zinc-100 placeholder:text-zinc-600" />
                  </Field>
                  <Field label="模型名称">
                    <Input value={model} onChange={(event) => setModel(event.target.value)} placeholder={apiType === "anthropic" ? "claude-sonnet-4-5" : "gpt-5.4"} className="h-12 rounded-2xl border-white/10 bg-black/20 text-zinc-100 placeholder:text-zinc-600" />
                  </Field>
                </div>

                <div className="flex flex-wrap gap-3">
                  <Button className="h-11 rounded-full bg-cyan-400 px-5 text-slate-950 hover:bg-cyan-300" onClick={handleSaveLLM}>保存 LLM 配置</Button>
                  <Button variant="outline" className="h-11 rounded-full border-white/15 bg-white/5 text-zinc-100 hover:bg-white/10" onClick={handleTestLLM}>测试连接</Button>
                </div>
                <AnimatePresence>{llmFeedback ? <FeedbackBanner feedback={llmFeedback} /> : null}</AnimatePresence>
              </div>
            </SectionShell>

            <SectionShell eyebrow="Workspace Sync" title="Notion 集成" description="适合把研究结果同步到统一数据库。上传 env 后通常只需要验证一次连接即可。">
              <div className="grid gap-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Badge className={config?.has_notion ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-200" : "border-white/10 bg-white/5 text-zinc-300"}>
                    {config?.has_notion ? "已配置" : "未配置"}
                  </Badge>
                  {notionStatus?.connected ? <Badge className="border-cyan-400/20 bg-cyan-400/10 text-cyan-200">数据库已连接，当前 {notionStatus.record_count} 条记录</Badge> : null}
                </div>

                <Field label="Notion Token" hint={config?.has_notion ? "已配置，可覆盖" : "需要集成令牌"}>
                  <div className="relative">
                    <Input
                      type={showNotionToken ? "text" : "password"}
                      value={notionToken}
                      onChange={(event) => setNotionToken(event.target.value)}
                      placeholder={config?.has_notion ? "输入新 Token 覆盖当前值" : "secret_..."}
                      className="h-12 rounded-2xl border-white/10 bg-black/20 pr-10 text-zinc-100 placeholder:text-zinc-600"
                    />
                    <button type="button" onClick={() => setShowNotionToken((value) => !value)} className="absolute top-1/2 right-3 -translate-y-1/2 text-zinc-500 transition hover:text-zinc-200">
                      {showNotionToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                </Field>

                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Parent Page ID">
                    <Input value={notionPageId} onChange={(event) => setNotionPageId(event.target.value)} placeholder="输入共享页面 ID" className="h-12 rounded-2xl border-white/10 bg-black/20 text-zinc-100 placeholder:text-zinc-600" />
                  </Field>
                  <Field label="数据库名称">
                    <Input value={notionDbName} onChange={(event) => setNotionDbName(event.target.value)} placeholder="例如 Team Research Database" className="h-12 rounded-2xl border-white/10 bg-black/20 text-zinc-100 placeholder:text-zinc-600" />
                  </Field>
                </div>

                <div className="flex flex-wrap gap-3">
                  <Button className="h-11 rounded-full bg-cyan-400 px-5 text-slate-950 hover:bg-cyan-300" onClick={handleSaveNotion}>保存 Notion 配置</Button>
                  <Button variant="outline" className="h-11 rounded-full border-white/15 bg-white/5 text-zinc-100 hover:bg-white/10" onClick={handleTestNotion}>测试 Notion 连接</Button>
                </div>
                <AnimatePresence>{notionFeedback ? <FeedbackBanner feedback={notionFeedback} /> : null}</AnimatePresence>
              </div>
            </SectionShell>

            <SectionShell eyebrow="Research Sources" title="文献获取与数据库 API" description="这些能力也适合跟团队共享，用来统一全文抓取、代理设置，以及 IEEE / Scopus 数据源访问。">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Unpaywall Email">
                  <Input value={unpaywallEmail} onChange={(event) => setUnpaywallEmail(event.target.value)} placeholder="your@email.com" className="h-12 rounded-2xl border-white/10 bg-black/20 text-zinc-100 placeholder:text-zinc-600" />
                </Field>
                <Field label="HTTP 代理">
                  <Input value={httpProxy} onChange={(event) => setHttpProxy(event.target.value)} placeholder="http://127.0.0.1:7890" className="h-12 rounded-2xl border-white/10 bg-black/20 text-zinc-100 placeholder:text-zinc-600" />
                </Field>
                <Field label="GROBID URL" hint={config?.grobid_url ? "已配置" : undefined}>
                  <Input value={grobidUrl} onChange={(event) => setGrobidUrl(event.target.value)} placeholder="http://grobid:8070" className="h-12 rounded-2xl border-white/10 bg-black/20 text-zinc-100 placeholder:text-zinc-600" />
                </Field>
                <Field label="IEEE API Key" hint={config?.ieee_api_key ? "已配置" : undefined}>
                  <Input type="password" value={ieeeApiKey} onChange={(event) => setIeeeApiKey(event.target.value)} placeholder="输入 IEEE API Key" className="h-12 rounded-2xl border-white/10 bg-black/20 text-zinc-100 placeholder:text-zinc-600" />
                </Field>
                <Field label="Scopus API Key" hint={config?.scopus_api_key ? "已配置" : undefined}>
                  <Input type="password" value={scopusApiKey} onChange={(event) => setScopusApiKey(event.target.value)} placeholder="输入 Scopus API Key" className="h-12 rounded-2xl border-white/10 bg-black/20 text-zinc-100 placeholder:text-zinc-600" />
                </Field>
              </div>
              <div className="mt-5 flex flex-wrap gap-3">
                <Button className="h-11 rounded-full bg-cyan-400 px-5 text-slate-950 hover:bg-cyan-300" onClick={handleSaveResearch}>保存文献源配置</Button>
              </div>
              <div className="mt-5">
                <AnimatePresence>{researchFeedback ? <FeedbackBanner feedback={researchFeedback} /> : null}</AnimatePresence>
              </div>
            </SectionShell>
          </div>

          <div className="space-y-6">
            <SectionShell eyebrow="Profiles" title="模型档案" description="保存常用模型组合，方便你和团队在不同供应商之间快速切换。">
              <div className="space-y-3">
                {models.length === 0 ? (
                  <div className="rounded-[24px] border border-dashed border-white/12 bg-black/20 px-4 py-6 text-sm text-zinc-500">
                    还没有保存模型档案。先把当前 LLM 配置调好，再保存成一套可复用组合。
                  </div>
                ) : models.map((item) => (
                  <div key={item.name} className="rounded-[24px] border border-white/10 bg-black/20 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-base font-medium text-white">{item.name}</p>
                        <p className="mt-1 truncate text-sm text-zinc-500">{item.base_url || "默认地址"} / {item.model || "未设置模型"}</p>
                      </div>
                      <Badge className="border-white/10 bg-white/5 text-zinc-200">{item.api_type || "openai"}</Badge>
                    </div>
                    <div className="mt-4 flex gap-2">
                      <Button variant="outline" className="flex-1 rounded-full border-white/15 bg-white/5 text-zinc-100 hover:bg-white/10" onClick={() => handleSwitchModel(item)}>
                        <ArrowRightLeft className="size-4" data-icon="inline-start" />
                        切换
                      </Button>
                      <Button variant="destructive" className="rounded-full" onClick={() => handleDeleteModel(item.name)}>
                        <Trash2 className="size-4" data-icon="inline-start" />
                        删除
                      </Button>
                    </div>
                  </div>
                ))}

                {showNewModel ? (
                  <div className="rounded-[24px] border border-cyan-400/20 bg-cyan-400/8 p-4">
                    <Field label="档案名称">
                      <Input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="例如：组会专用 GPT-5.4" className="h-12 rounded-2xl border-white/10 bg-black/20 text-zinc-100 placeholder:text-zinc-600" />
                    </Field>
                    <p className="mt-3 text-xs leading-6 text-zinc-400">
                      未重新输入的 API Key 会自动继承当前已保存配置，避免档案只保存了模型名却丢失鉴权信息。
                    </p>
                    <div className="mt-4 flex gap-2">
                      <Button className="rounded-full bg-cyan-400 text-slate-950 hover:bg-cyan-300" onClick={handleAddModel} disabled={!newName.trim()}>保存档案</Button>
                      <Button variant="outline" className="rounded-full border-white/15 bg-white/5 text-zinc-100 hover:bg-white/10" onClick={() => { setShowNewModel(false); setNewName(""); }}>取消</Button>
                    </div>
                  </div>
                ) : (
                  <Button variant="outline" className="w-full rounded-full border-white/15 bg-white/5 text-zinc-100 hover:bg-white/10" onClick={() => setShowNewModel(true)}>
                    把当前配置保存成模型档案
                  </Button>
                )}
                <AnimatePresence>{modelFeedback ? <FeedbackBanner feedback={modelFeedback} /> : null}</AnimatePresence>
              </div>
            </SectionShell>

            <SectionShell eyebrow="Safety" title="共享建议" description="给团队分发配置时，建议按下面这三条来做，能少很多后续维护成本。">
              <div className="space-y-4">
                {[
                  "建议单独准备一份团队共享用 `.env`，不要直接分发你个人开发机上的全部变量。",
                  "如果要共享 Notion Token，最好使用专门为小组创建的集成，而不是个人工作区主令牌。",
                  "上传后系统只会导入受支持的 key，其余字段会显示在“已忽略”中，不会静默写入。",
                ].map((line) => (
                  <div key={line} className="flex gap-3 rounded-[22px] border border-white/8 bg-black/20 p-4">
                    <ShieldCheck className="mt-0.5 size-4 shrink-0 text-cyan-300" />
                    <p className="text-sm leading-6 text-zinc-300">{line}</p>
                  </div>
                ))}
              </div>
            </SectionShell>

            <SectionShell eyebrow="Maintenance" title="黑名单管理" description="获取失败的 DOI 会加入黑名单。清空后，下次检索会重新尝试它们。">
              <div className="rounded-[24px] border border-white/10 bg-black/20 p-4">
                <p className="text-xs uppercase tracking-[0.22em] text-zinc-500">当前黑名单</p>
                <p className="mt-3 text-3xl font-semibold text-white">{blacklistCount}</p>
                <p className="mt-3 text-sm leading-6 text-zinc-400">当论文抓取失败时，对应 DOI 会被跳过，避免重复浪费检索配额。</p>
              </div>
              <div className="mt-4">
                {clearConfirm ? (
                  <div className="rounded-[24px] border border-amber-500/25 bg-amber-500/8 p-4">
                    <div className="flex gap-3">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" />
                      <div>
                        <p className="text-sm font-medium text-amber-100">确认清空整个 DOI 黑名单？</p>
                        <p className="mt-1 text-sm leading-6 text-amber-100/75">清空后，历史上抓取失败的 DOI 会重新进入后续检索流程。</p>
                        <div className="mt-4 flex gap-2">
                          <Button variant="destructive" className="rounded-full" onClick={handleClearBlacklist}>确认清空</Button>
                          <Button variant="outline" className="rounded-full border-white/15 bg-white/5 text-zinc-100 hover:bg-white/10" onClick={() => setClearConfirm(false)}>取消</Button>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <Button variant="outline" className="w-full rounded-full border-white/15 bg-white/5 text-zinc-100 hover:bg-white/10" onClick={() => setClearConfirm(true)} disabled={blacklistCount === 0}>
                    清空黑名单
                  </Button>
                )}
              </div>
            </SectionShell>
          </div>
        </div>
      </div>
    </div>
  );
}
