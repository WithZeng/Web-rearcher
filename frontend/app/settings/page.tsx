"use client";

import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plus,
  Trash2,
  ArrowRightLeft,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Eye,
  EyeOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  api,
  type ConfigResponse,
  type ModelProfile,
  type NotionStatus,
} from "@/lib/api";

export default function SettingsPage() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [models, setModels] = useState<ModelProfile[]>([]);
  const [loading, setLoading] = useState(true);

  // Section 1: LLM API
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiType, setApiType] = useState("openai");
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  // Section 2: Notion
  const [notionToken, setNotionToken] = useState("");
  const [notionPageId, setNotionPageId] = useState("");
  const [notionDbName, setNotionDbName] = useState("");
  const [showNotionToken, setShowNotionToken] = useState(false);
  const [notionStatus, setNotionStatus] = useState<NotionStatus | null>(null);
  const [notionTestResult, setNotionTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  // Section 3: 文献获取
  const [unpaywallEmail, setUnpaywallEmail] = useState("");
  const [httpProxy, setHttpProxy] = useState("");
  const [fetchSaveResult, setFetchSaveResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  // Section 4: 文献库 API
  const [ieeeApiKey, setIeeeApiKey] = useState("");
  const [scopusApiKey, setScopusApiKey] = useState("");
  const [dbSaveResult, setDbSaveResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  // Section 5: Saved models
  const [showNewModel, setShowNewModel] = useState(false);
  const [newName, setNewName] = useState("");
  const [modelSaveResult, setModelSaveResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  // Section 6: Blacklist
  const [blacklistCount, setBlacklistCount] = useState(0);
  const [clearConfirm, setClearConfirm] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [cfg, mdls] = await Promise.all([
        api.config.get(),
        api.models.list(),
      ]);
      setConfig(cfg);
      setModels(mdls);
      setBaseUrl(cfg.base_url || "");
      setModel(cfg.model || "");
      setApiType(cfg.api_type || "openai");
      setNotionPageId(cfg.notion_parent_page_id || "");
      setNotionDbName(cfg.notion_db_name || "GelMA 高质量文献库");
      setUnpaywallEmail(cfg.unpaywall_email || "");
      setHttpProxy(cfg.http_proxy || "");
      setIeeeApiKey(cfg.ieee_api_key || "");
      setScopusApiKey(cfg.scopus_api_key || "");

      const [ns, bl] = await Promise.all([
        api.notion.status().catch(() => null),
        api.blacklist.count().catch(() => ({ count: 0 })),
      ]);
      if (ns) setNotionStatus(ns);
      setBlacklistCount(bl?.count ?? 0);
    } catch (err) {
      console.error("Failed to load settings:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Section 1 handlers
  const handleSaveLLM = useCallback(async () => {
    try {
      await api.config.update({
        api_key: apiKey || undefined,
        base_url: baseUrl,
        model,
        api_type: apiType,
      });
      setTestResult({ success: true, message: "配置已保存" });
      setApiKey("");
    } catch (err) {
      setTestResult({ success: false, message: String(err) });
    }
  }, [apiKey, baseUrl, model, apiType]);

  const handleTestLLM = useCallback(async () => {
    setTestResult(null);
    try {
      const result = await api.config.test({
        api_key: apiKey || undefined,
        base_url: baseUrl,
        model,
        api_type: apiType,
      });
      setTestResult(result);
    } catch (err) {
      setTestResult({ success: false, message: String(err) });
    }
  }, [apiKey, baseUrl, model, apiType]);

  // Section 2 handlers
  const handleSaveNotion = useCallback(async () => {
    if (!notionToken && !notionPageId) {
      setNotionTestResult({ success: false, message: "请输入 Notion Token" });
      return;
    }
    try {
      await api.config.update({
        notion_token: notionToken || undefined,
        notion_parent_page_id: notionPageId || undefined,
        notion_db_name: notionDbName || undefined,
      });
      setNotionToken("");
      const cfg = await api.config.get();
      setConfig(cfg);
      // Auto-test after save
      const result = await api.config.testNotion();
      setNotionTestResult(result);
      if (result.success) {
        const ns = await api.notion.status().catch(() => null);
        if (ns) setNotionStatus(ns);
      }
    } catch (err) {
      setNotionTestResult({ success: false, message: String(err) });
    }
  }, [notionToken, notionPageId, notionDbName]);

  const handleTestNotion = useCallback(async () => {
    setNotionTestResult(null);
    try {
      const result = await api.config.testNotion();
      setNotionTestResult(result);
      if (result.success) {
        const ns = await api.notion.status().catch(() => null);
        if (ns) setNotionStatus(ns);
      }
    } catch (err) {
      setNotionTestResult({ success: false, message: String(err) });
    }
  }, []);

  // Section 3 handler
  const handleSaveFetch = useCallback(async () => {
    try {
      await api.config.update({
        unpaywall_email: unpaywallEmail || undefined,
        http_proxy: httpProxy || undefined,
      });
      setFetchSaveResult({ success: true, message: "配置已保存" });
    } catch (err) {
      setFetchSaveResult({ success: false, message: String(err) });
    }
  }, [unpaywallEmail, httpProxy]);

  // Section 4 handler
  const handleSaveDbApi = useCallback(async () => {
    try {
      await api.config.update({
        ieee_api_key: ieeeApiKey || undefined,
        scopus_api_key: scopusApiKey || undefined,
      });
      setDbSaveResult({ success: true, message: "配置已保存" });
    } catch (err) {
      setDbSaveResult({ success: false, message: String(err) });
    }
  }, [ieeeApiKey, scopusApiKey]);

  // Section 5 handlers
  const handleAddModel = useCallback(async () => {
    if (!newName.trim()) return;
    setModelSaveResult(null);
    const profile: ModelProfile = {
      name: newName.trim(),
      base_url: baseUrl,
      model,
      api_key: apiKey || undefined,
      api_type: apiType,
    };
    try {
      await api.models.create(profile);
      setModels((prev) => [...prev, profile]);
      setNewName("");
      setShowNewModel(false);
      setModelSaveResult({ success: true, message: `已保存配置「${profile.name}」` });
    } catch (err) {
      setModelSaveResult({ success: false, message: String(err instanceof Error ? err.message : err) });
    }
  }, [newName, baseUrl, model, apiKey]);

  const handleDeleteModel = useCallback(async (name: string) => {
    try {
      await api.models.delete(name);
      setModels((prev) => prev.filter((m) => m.name !== name));
    } catch (err) {
      console.error("Failed to delete model:", err);
    }
  }, []);

  const handleSwitchModel = useCallback(
    async (profile: ModelProfile) => {
      setBaseUrl(profile.base_url || "");
      setModel(profile.model || "");
      setApiType(profile.api_type || "openai");
      try {
        await api.config.update({
          api_key: profile.api_key,
          base_url: profile.base_url || "",
          model: profile.model || "",
          api_type: profile.api_type || "openai",
        });
        setTestResult({ success: true, message: `已切换到 ${profile.name}` });
      } catch (err) {
        setTestResult({ success: false, message: String(err) });
      }
    },
    [],
  );

  // Section 6 handler
  const handleClearBlacklist = useCallback(async () => {
    try {
      const result = await api.blacklist.clear();
      setBlacklistCount(0);
      setClearConfirm(false);
      setTestResult({
        success: true,
        message: `已清除 ${result.removed} 个黑名单记录`,
      });
    } catch (err) {
      console.error("Failed to clear blacklist:", err);
    }
  }, []);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-zinc-500">
        加载中...
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8 px-6 py-10">
      <h1 className="text-xl font-semibold tracking-tight text-zinc-100">
        设置
      </h1>

      {/* Section 1: LLM API 配置 */}
      <section className="space-y-4">
        <h2 className="text-sm font-medium text-zinc-300">LLM API 配置</h2>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500">API Key</label>
            <div className="relative">
              <Input
                type={showApiKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={config?.has_api_key ? "••••••••（已配置，输入新值可覆盖）" : "sk-..."}
                className="pr-9"
              />
              <button
                type="button"
                onClick={() => setShowApiKey((v) => !v)}
                className="absolute top-1/2 right-2.5 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                {showApiKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500">API 类型</label>
            <div className="flex gap-2">
              {[
                { value: "openai", label: "OpenAI 兼容" },
                { value: "anthropic", label: "Claude (Anthropic)" },
              ].map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setApiType(opt.value)}
                  className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                    apiType === opt.value
                      ? "border-blue-500/50 bg-blue-500/10 text-blue-400"
                      : "border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-600 hover:text-zinc-300"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-zinc-600">
              {apiType === "anthropic"
                ? "支持 Anthropic 官方 API 及 Claude 中转站（自动兼容 Bearer 认证）"
                : "兼容 OpenAI 格式的 API（含 DeepSeek、Ollama、vLLM 等）"}
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500">Base URL</label>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={apiType === "anthropic" ? "https://api.anthropic.com 或中转站地址" : "https://api.openai.com/v1"}
            />
            {apiType === "anthropic" && (
              <p className="text-xs text-zinc-600">
                URL 末尾的 /v1、/v1/messages 会自动处理，直接粘贴中转站地址即可
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500">模型名称</label>
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={apiType === "anthropic" ? "claude-sonnet-4-20250514" : "gpt-4o"}
            />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button onClick={handleSaveLLM}>保存</Button>
            <Button variant="outline" onClick={handleTestLLM}>
              测试连接
            </Button>
          </div>
          <AnimatePresence>
            {testResult && (
              <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                className={`flex items-center gap-2 text-sm ${
                  testResult.success ? "text-green-400" : "text-red-400"
                }`}
              >
                {testResult.success ? (
                  <CheckCircle className="size-3.5" />
                ) : (
                  <XCircle className="size-3.5" />
                )}
                {testResult.message}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </section>

      <Separator />

      {/* Section 2: Notion 集成 */}
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-medium text-zinc-300">Notion 集成</h2>
          {config?.has_notion ? (
            <Badge
              variant="outline"
              className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
            >
              已配置
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="border-zinc-500/30 bg-zinc-500/10 text-zinc-400"
            >
              未配置
            </Badge>
          )}
        </div>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500">Notion Token</label>
            <div className="relative">
              <Input
                type={showNotionToken ? "text" : "password"}
                value={notionToken}
                onChange={(e) => setNotionToken(e.target.value)}
                placeholder={config?.has_notion ? "••••••••（已配置，输入新值可覆盖）" : "secret_..."}
                className="pr-9"
              />
              <button
                type="button"
                onClick={() => setShowNotionToken((v) => !v)}
                className="absolute top-1/2 right-2.5 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                {showNotionToken ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500">Parent Page ID</label>
            <Input
              value={notionPageId}
              onChange={(e) => setNotionPageId(e.target.value)}
              placeholder="Notion 页面 ID"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500">数据库名称</label>
            <Input
              value={notionDbName}
              onChange={(e) => setNotionDbName(e.target.value)}
              placeholder="GelMA 高质量文献库"
            />
            <p className="text-xs text-zinc-600">
              将在父页面下查找或创建此名称的数据库
            </p>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button onClick={handleSaveNotion}>保存</Button>
            <Button variant="outline" onClick={handleTestNotion}>
              测试 Notion 连接
            </Button>
          </div>
          <AnimatePresence>
            {notionTestResult && (
              <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                className={`flex items-center gap-2 text-sm ${
                  notionTestResult.success ? "text-green-400" : "text-red-400"
                }`}
              >
                {notionTestResult.success ? (
                  <CheckCircle className="size-3.5" />
                ) : (
                  <XCircle className="size-3.5" />
                )}
                {notionTestResult.message}
              </motion.div>
            )}
          </AnimatePresence>
          <AnimatePresence>
            {notionStatus?.connected && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-xs text-zinc-500"
              >
                数据库已连接，当前共{" "}
                <span className="font-medium text-zinc-300">
                  {notionStatus.record_count}
                </span>{" "}
                条记录
              </motion.p>
            )}
          </AnimatePresence>
        </div>
      </section>

      <Separator />

      {/* Section 3: 文献获取配置 */}
      <section className="space-y-4">
        <h2 className="text-sm font-medium text-zinc-300">文献获取配置</h2>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500">Unpaywall Email</label>
            <Input
              value={unpaywallEmail}
              onChange={(e) => setUnpaywallEmail(e.target.value)}
              placeholder="your@email.com"
            />
            <p className="text-xs leading-relaxed text-zinc-600">
              配置后可通过 Unpaywall 获取开放获取 PDF，大幅提升全文获取率
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500">HTTP 代理</label>
            <Input
              value={httpProxy}
              onChange={(e) => setHttpProxy(e.target.value)}
              placeholder="http://127.0.0.1:7890"
            />
            <p className="text-xs leading-relaxed text-zinc-600">
              如需代理访问出版商网站，填写代理地址（如 http://127.0.0.1:7890）
            </p>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button onClick={handleSaveFetch}>保存</Button>
          </div>
          <AnimatePresence>
            {fetchSaveResult && (
              <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                className={`flex items-center gap-2 text-sm ${
                  fetchSaveResult.success ? "text-green-400" : "text-red-400"
                }`}
              >
                {fetchSaveResult.success ? (
                  <CheckCircle className="size-3.5" />
                ) : (
                  <XCircle className="size-3.5" />
                )}
                {fetchSaveResult.message}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </section>

      <Separator />

      {/* Section 4: 文献库 API */}
      <section className="space-y-4">
        <h2 className="text-sm font-medium text-zinc-300">文献库 API</h2>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500">IEEE API Key</label>
            <Input
              type="password"
              value={ieeeApiKey}
              onChange={(e) => setIeeeApiKey(e.target.value)}
              placeholder={config?.ieee_api_key ? "••••••••（已配置）" : "输入 IEEE API Key"}
            />
            <p className="text-xs leading-relaxed text-zinc-600">
              配置后可搜索 IEEE Xplore 数据库
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500">Scopus API Key</label>
            <Input
              type="password"
              value={scopusApiKey}
              onChange={(e) => setScopusApiKey(e.target.value)}
              placeholder={config?.scopus_api_key ? "••••••••（已配置）" : "输入 Scopus API Key"}
            />
            <p className="text-xs leading-relaxed text-zinc-600">
              配置后可搜索 Scopus 数据库
            </p>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button onClick={handleSaveDbApi}>保存</Button>
          </div>
          <AnimatePresence>
            {dbSaveResult && (
              <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                className={`flex items-center gap-2 text-sm ${
                  dbSaveResult.success ? "text-green-400" : "text-red-400"
                }`}
              >
                {dbSaveResult.success ? (
                  <CheckCircle className="size-3.5" />
                ) : (
                  <XCircle className="size-3.5" />
                )}
                {dbSaveResult.message}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </section>

      <Separator />

      {/* Section 5: 已保存的模型配置 */}
      <section className="space-y-4">
        <h2 className="text-sm font-medium text-zinc-300">已保存的模型配置</h2>

        {models.length === 0 ? (
          <p className="text-sm text-zinc-500">暂无保存的配置</p>
        ) : (
          <div className="space-y-2">
            {models.map((m) => (
              <div
                key={m.name}
                className="flex items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-white/[0.02]"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-zinc-200">{m.name}</p>
                    {m.api_type === "anthropic" && (
                      <Badge variant="outline" className="border-orange-500/30 bg-orange-500/10 text-orange-400 text-[10px] px-1.5 py-0">
                        Claude
                      </Badge>
                    )}
                  </div>
                  <p className="truncate text-xs text-zinc-500">
                    {m.base_url} · {m.model}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleSwitchModel(m)}
                >
                  <ArrowRightLeft
                    className="size-3.5"
                    data-icon="inline-start"
                  />
                  切换
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => handleDeleteModel(m.name)}
                >
                  <Trash2 className="size-3.5" data-icon="inline-start" />
                  删除
                </Button>
              </div>
            ))}
          </div>
        )}

        <AnimatePresence>
          {showNewModel && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="flex items-center gap-2 pt-1">
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="配置名称（如：GPT-4o-mini）"
                  className="flex-1"
                />
                <Button onClick={handleAddModel} disabled={!newName.trim()}>
                  保存
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setShowNewModel(false);
                    setNewName("");
                  }}
                >
                  取消
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {!showNewModel && (
          <Button variant="outline" onClick={() => setShowNewModel(true)}>
            <Plus className="size-3.5" data-icon="inline-start" />
            添加新配置
          </Button>
        )}

        <AnimatePresence>
          {modelSaveResult && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className={`flex items-center gap-2 text-sm ${
                modelSaveResult.success ? "text-green-400" : "text-red-400"
              }`}
            >
              {modelSaveResult.success ? (
                <CheckCircle className="size-3.5" />
              ) : (
                <XCircle className="size-3.5" />
              )}
              {modelSaveResult.message}
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      <Separator />

      {/* Section 6: 黑名单管理 */}
      <section className="space-y-4">
        <h2 className="text-sm font-medium text-zinc-300">黑名单管理</h2>
        <p className="text-sm text-zinc-400">
          当前黑名单中有{" "}
          <span className="font-medium text-zinc-200">{blacklistCount}</span>{" "}
          个 DOI
        </p>
        <p className="text-xs leading-relaxed text-zinc-600">
          获取失败的论文 DOI 会自动加入黑名单，下次检索时跳过
        </p>
        <AnimatePresence mode="wait">
          {clearConfirm ? (
            <motion.div
              key="confirm"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="flex items-center gap-3"
            >
              <AlertTriangle className="size-4 text-yellow-400" />
              <span className="text-sm text-yellow-400">确认清空所有黑名单？</span>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleClearBlacklist}
              >
                确认清空
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setClearConfirm(false)}
              >
                取消
              </Button>
            </motion.div>
          ) : (
            <motion.div
              key="button"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
            >
              <Button
                variant="outline"
                onClick={() => setClearConfirm(true)}
                disabled={blacklistCount === 0}
              >
                清空黑名单
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </section>
    </div>
  );
}
