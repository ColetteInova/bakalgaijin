import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  Download,
  FileJson,
  FileSpreadsheet,
  FileText,
  Film,
  Loader2,
  MessageSquare,
  Music,
  Search,
  Twitch,
  User,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Link } from "wouter";

interface VodInfo {
  title: string;
  id: string;
  duration: number;
  thumbnail: string;
  uploader: string;
  description?: string;
}

interface VodJob {
  id: string;
  url: string;
  title: string;
  quality: string;
  status: "running" | "done" | "error" | "cancelled";
  percent: number;
  speed: string;
  eta: string;
  downloadedBytes: string;
  totalBytes: string;
  filename?: string;
  error?: string;
  pipeline?: {
    status: "idle" | "running" | "done" | "error";
    step: string;
    stepLabel: string;
    commentsCount?: number;
    folder?: string;
    videoId?: string;
    error?: string;
  };
}

interface DoneItem {
  filename: string;
  title: string;
  quality: string;
  date: string;
}

interface VodComment {
  id: string;
  offset: number;
  login: string;
  displayName: string;
  text: string;
}

interface CommentsJob {
  id: string;
  videoId: string;
  title: string;
  status: "running" | "done" | "error";
  page: number;
  count: number;
  error?: string;
  comments?: VodComment[];
  startedAt: number;
}

const QUALITY_OPTIONS = [
  { value: "1080p", label: "1080p (Melhor qualidade)", icon: Film },
  { value: "720p", label: "720p", icon: Film },
  { value: "480p", label: "480p", icon: Film },
  { value: "360p", label: "360p (Mais leve)", icon: Film },
  { value: "audio", label: "Somente Áudio (MP3)", icon: Music },
];

const TWITCH_VOD_REGEX = /twitch\.tv\/videos\/(\d+)/;

function formatDuration(seconds?: number) {
  if (!seconds) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function formatQuality(quality: string) {
  return QUALITY_OPTIONS.find((o) => o.value === quality)?.label ?? quality;
}

export default function VodDownloader() {
  const [url, setUrl] = useState("");
  const [info, setInfo] = useState<VodInfo | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(false);
  const [quality, setQuality] = useState("1080p");
  const [jobs, setJobs] = useState<VodJob[]>([]);
  const [history, setHistory] = useState<DoneItem[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("vod-history") || "[]");
    } catch {
      return [];
    }
  });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/vod/jobs");
      if (!res.ok) return;
      const data: VodJob[] = await res.json();
      setJobs(data);
      return data;
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    pollRef.current = setInterval(fetchJobs, 1000);
    fetchJobs();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchJobs]);

  useEffect(() => {
    localStorage.setItem("vod-history", JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    const justFinished = jobs.filter(
      (j) => j.status === "done" && j.filename && !history.some((h) => h.filename === j.filename)
    );
    if (justFinished.length > 0) {
      setHistory((prev) => [
        ...justFinished.map((j) => ({
          filename: j.filename!,
          title: j.title,
          quality: j.quality,
          date: new Date().toLocaleString("pt-BR"),
        })),
        ...prev,
      ]);
      toast.success(`${justFinished.length} download(s) concluído(s)!`);
    }
  }, [jobs, history]);

  const searchVod = async () => {
    if (!url.trim()) {
      toast.error("Cole a URL do VOD da Twitch primeiro.");
      return;
    }
    if (!TWITCH_VOD_REGEX.test(url)) {
      toast.error("URL inválida. Use o formato https://www.twitch.tv/videos/123456");
      return;
    }
    setLoadingInfo(true);
    setInfo(null);
    try {
      const res = await fetch("/api/vod/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro ao buscar o VOD");
      setInfo(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao buscar o VOD");
    } finally {
      setLoadingInfo(false);
    }
  };

  const startDownload = async () => {
    if (!info) return;
    try {
      const res = await fetch("/api/vod/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), quality, title: info.title }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro ao iniciar download");
      toast.success("Download iniciado!");
      fetchJobs();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao iniciar download");
    }
  };

  const cancelJob = async (id: string) => {
    try {
      await fetch(`/api/vod/cancel/${id}`, { method: "POST" });
      fetchJobs();
    } catch {
      toast.error("Erro ao cancelar o download");
    }
  };

  const removeJob = async (id: string) => {
    try {
      await fetch(`/api/vod/jobs/${id}`, { method: "DELETE" });
      fetchJobs();
    } catch {
      // ignore
    }
  };

  const retryJob = async (id: string) => {
    try {
      const res = await fetch(`/api/vod/retry/${id}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro ao refazer o download");
      toast.success("Refazendo pós-processamento (remux)...");
      fetchJobs();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao refazer o download");
    }
  };

  const clearHistory = () => {
    setHistory([]);
    toast.info("Histórico limpo.");
  };

  // ---- Comentários do VOD ----
  const [commentsUrl, setCommentsUrl] = useState("");
  const [commentsJob, setCommentsJob] = useState<CommentsJob | null>(null);
  const [loadingComments, setLoadingComments] = useState(false);
  const commentsPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchCommentsJob = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/vod/comments/${id}`);
      if (!res.ok) return;
      const data: CommentsJob = await res.json();
      setCommentsJob(data);
      if (data.status !== "running" && commentsPollRef.current) {
        clearInterval(commentsPollRef.current);
        commentsPollRef.current = null;
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    return () => {
      if (commentsPollRef.current) clearInterval(commentsPollRef.current);
    };
  }, []);

  const startCollectComments = async () => {
    if (!commentsUrl.trim()) {
      toast.error("Cole a URL do VOD da Twitch primeiro.");
      return;
    }
    if (!TWITCH_VOD_REGEX.test(commentsUrl)) {
      toast.error("URL inválida. Use o formato https://www.twitch.tv/videos/123456");
      return;
    }
    setLoadingComments(true);
    setCommentsJob(null);
    try {
      const res = await fetch("/api/vod/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: commentsUrl.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro ao coletar comentários");
      toast.success("Coleta de comentários iniciada!");
      const poll = () => fetchCommentsJob(data.id);
      commentsPollRef.current = setInterval(poll, 1500);
      fetchCommentsJob(data.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao coletar comentários");
    } finally {
      setLoadingComments(false);
    }
  };

  const resetComments = () => {
    if (commentsPollRef.current) {
      clearInterval(commentsPollRef.current);
      commentsPollRef.current = null;
    }
    setCommentsJob(null);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-purple-500 selection:text-white">
      {/* Header */}
      <header className="border-b border-slate-800/80 bg-slate-900/60 backdrop-blur-md sticky top-0 z-40">
        <div className="container max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-purple-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-purple-900/20 ring-1 ring-white/10">
              <Twitch className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-lg tracking-tight bg-gradient-to-r from-purple-200 via-slate-100 to-indigo-200 bg-clip-text text-transparent">
                  VOD Downloader
                </span>
                <Badge variant="outline" className="border-purple-500/40 text-purple-400 text-xs px-2 py-0">
                  Twitch
                </Badge>
              </div>
              <p className="text-xs text-slate-400">Baixe VODs e clipes da Twitch em MP4 ou MP3</p>
            </div>
          </div>

          <Link href="/">
            <Button
              variant="outline"
              size="sm"
              className="border-slate-700 bg-slate-800/50 hover:bg-slate-800 text-slate-300 text-xs"
            >
              <ArrowLeft className="w-3.5 h-3.5 mr-1 text-slate-400" />
              Tradutor de Voz
            </Button>
          </Link>
        </div>
      </header>

      <main className="container max-w-5xl mx-auto px-4 py-6 flex-1 flex flex-col gap-6">
        <Tabs defaultValue="download" className="flex flex-col gap-6">
          <TabsList className="w-full max-w-md mx-auto grid grid-cols-2 bg-slate-900 border border-slate-800">
            <TabsTrigger value="download" className="data-[state=active]:bg-purple-600 data-[state=active]:text-white">
              <Download className="w-4 h-4 mr-2" />
              Baixar VOD
            </TabsTrigger>
            <TabsTrigger value="comments" className="data-[state=active]:bg-purple-600 data-[state=active]:text-white">
              <MessageSquare className="w-4 h-4 mr-2" />
              Comentários
            </TabsTrigger>
          </TabsList>

          <TabsContent value="download" className="flex flex-col gap-6 mt-0">
        {/* Buscar VOD */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl ring-1 ring-white/5">
          <div className="flex flex-col md:flex-row gap-3">
            <div className="flex-1">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && searchVod()}
                placeholder="Cole a URL do VOD... ex: https://www.twitch.tv/videos/2871566138"
                className="bg-slate-950/70 border-slate-700 h-11 text-sm placeholder:text-slate-500"
              />
            </div>
            <Button
              onClick={searchVod}
              disabled={loadingInfo}
              className="h-11 px-6 bg-purple-600 hover:bg-purple-700 text-white font-medium"
            >
              {loadingInfo ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Search className="w-4 h-4 mr-2" />}
              Buscar VOD
            </Button>
          </div>

          {/* Info do VOD */}
          {info && (
            <div className="mt-5 p-4 rounded-xl bg-slate-950/60 border border-slate-800 flex flex-col md:flex-row gap-4">
              {info.thumbnail && (
                <img
                  src={info.thumbnail}
                  alt={info.title}
                  className="w-full md:w-64 h-36 object-cover rounded-lg border border-slate-800"
                />
              )}
              <div className="flex-1 flex flex-col gap-2">
                <h2 className="font-semibold text-base text-slate-100 leading-snug">{info.title}</h2>
                <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
                  <span className="flex items-center gap-1">
                    <User className="w-3.5 h-3.5 text-purple-400" />
                    {info.uploader}
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5 text-purple-400" />
                    {formatDuration(info.duration)}
                  </span>
                </div>
                {info.description && <p className="text-xs text-slate-500 line-clamp-2">{info.description}</p>}

                <div className="flex flex-col sm:flex-row sm:items-end gap-3 mt-auto pt-3">
                  <div className="flex-1">
                    <label className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold block mb-1.5">
                      Qualidade
                    </label>
                    <select
                      value={quality}
                      onChange={(e) => setQuality(e.target.value)}
                      className="w-full h-10 rounded-lg bg-slate-950/70 border border-slate-700 px-3 text-sm text-slate-200 outline-none focus:border-purple-500"
                    >
                      {QUALITY_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button
                    onClick={startDownload}
                    className="h-10 px-5 bg-emerald-600 hover:bg-emerald-700 text-white font-medium"
                  >
                    <Download className="w-4 h-4 mr-2" />
                    Baixar
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Downloads em andamento */}
        {jobs.length > 0 && (
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl ring-1 ring-white/5">
            <h3 className="text-sm font-semibold text-slate-200 mb-4">Downloads</h3>
            <div className="space-y-4">
              {jobs.map((job) => (
                <div key={job.id} className="p-4 rounded-xl bg-slate-950/60 border border-slate-800">
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-200 truncate">{job.title}</p>
                      <div className="flex items-center gap-2 mt-1 text-xs text-slate-400">
                        <Badge variant="secondary" className="bg-purple-950/60 text-purple-300 border-purple-800 text-[10px] px-1.5">
                          {formatQuality(job.quality)}
                        </Badge>
                        {job.status === "running" && job.eta && <span>ETA: {job.eta}</span>}
                        {job.status === "running" && job.speed && <span>{job.speed}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {job.status === "running" && (
                        <>
                          <span className="text-sm font-semibold text-slate-200 tabular-nums">
                            {job.percent.toFixed(1)}%
                          </span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-slate-400 hover:text-rose-400 hover:bg-rose-950/40"
                            onClick={() => cancelJob(job.id)}
                            title="Cancelar"
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        </>
                      )}
                      {job.status === "done" && (
                        <>
                          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                          {job.filename && (
                            <a
                              href={`/downloads/${encodeURIComponent(job.filename)}`}
                              className="text-xs font-medium text-emerald-400 hover:text-emerald-300 underline underline-offset-2"
                            >
                              Salvar arquivo
                            </a>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-slate-400 hover:text-white"
                            onClick={() => removeJob(job.id)}
                            title="Remover da lista"
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        </>
                      )}
                      {job.status === "cancelled" && (
                        <span className="text-xs text-slate-400 flex items-center gap-2">
                          Cancelado
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-slate-400 hover:text-white"
                            onClick={() => removeJob(job.id)}
                            title="Remover da lista"
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        </span>
                      )}
                      {job.status === "error" && (
                        <span className="flex items-center gap-2 text-rose-400">
                          <AlertTriangle className="w-4 h-4" />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-slate-400 hover:text-white"
                            onClick={() => removeJob(job.id)}
                            title="Remover da lista"
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        </span>
                      )}
                    </div>
                  </div>

                  <Progress value={job.percent} className="h-2 bg-slate-800" />

                  {job.status === "running" && (
                    <p className="text-[11px] text-slate-500 mt-2 tabular-nums">
                      {job.downloadedBytes}
                      {job.totalBytes && job.totalBytes !== "N/A" ? ` / ${job.totalBytes}` : ""}
                    </p>
                  )}
                  {job.status === "error" && (
                    <div className="mt-2">
                      <p className="text-xs text-rose-400 break-words max-h-20 overflow-y-auto">{job.error}</p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-2 h-8 px-3 text-xs border-amber-500/40 text-amber-300 hover:bg-amber-950/40"
                        onClick={() => retryJob(job.id)}
                      >
                        <Loader2 className="w-3.5 h-3.5 mr-1" />
                        Refazer pós-processamento
                      </Button>
                    </div>
                  )}

                  {/* Fluxo automático pós-download */}
                  {job.pipeline && (
                    <div
                      className={`mt-2 p-3 rounded-lg border text-xs ${
                        job.pipeline.status === "done"
                          ? "bg-emerald-950/40 border-emerald-800/40 text-emerald-300"
                          : job.pipeline.status === "error"
                            ? "bg-rose-950/40 border-rose-800/40 text-rose-300"
                            : "bg-indigo-950/40 border-indigo-800/40 text-indigo-300"
                      }`}
                    >
                      <div className="flex items-center gap-2 font-medium">
                        {job.pipeline.status === "running" && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        {job.pipeline.status === "done" && <CheckCircle2 className="w-3.5 h-3.5" />}
                        {job.pipeline.status === "error" && <AlertTriangle className="w-3.5 h-3.5" />}
                        Fluxo automático: {job.pipeline.stepLabel}
                      </div>
                      {job.pipeline.commentsCount != null && (
                        <div className="mt-1 opacity-80">💬 {job.pipeline.commentsCount} comentários coletados</div>
                      )}
                      {job.pipeline.error && <div className="mt-1 break-words opacity-80">{job.pipeline.error}</div>}
                      {job.pipeline.status === "done" && job.pipeline.folder && (
                        <a
                          href={`/saida/${encodeURIComponent(job.pipeline.folder)}/dashboard.html`}
                          className="inline-block mt-2 font-medium text-emerald-300 underline underline-offset-2 hover:text-emerald-200"
                        >
                          Abrir dashboard da análise →
                        </a>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Histórico de downloads concluídos */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl ring-1 ring-white/5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
              <Download className="w-4 h-4 text-emerald-400" />
              Downloads concluídos
            </h3>
            <div className="flex items-center gap-3">
              <span className="text-xs text-slate-400">{history.length} arquivo(s)</span>
              {history.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearHistory}
                  className="h-7 px-2 text-xs text-slate-400 hover:text-slate-200"
                >
                  Limpar histórico
                </Button>
              )}
            </div>
          </div>

          {history.length === 0 ? (
            <p className="text-xs text-slate-500 py-4 text-center">
              Nenhum download concluído ainda. Os arquivos são salvos na pasta <code className="text-slate-300">./downloads</code> do projeto.
            </p>
          ) : (
            <div className="space-y-2">
              {history.map((item, idx) => (
                <div
                  key={idx}
                  className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-slate-200 font-medium truncate">{item.title}</p>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      {formatQuality(item.quality)} · {item.date}
                    </p>
                  </div>
                  <a
                    href={`/downloads/${encodeURIComponent(item.filename)}`}
                    className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600/15 hover:bg-emerald-600/25 border border-emerald-600/30 text-emerald-400 text-xs font-medium transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Baixar
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>
          </TabsContent>

          <TabsContent value="comments" className="flex flex-col gap-6 mt-0">
            {/* Coletar comentários do VOD */}
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl ring-1 ring-white/5">
              <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-4">
                <MessageSquare className="w-4 h-4 text-purple-400" />
                Baixar todos os comentários do VOD
              </h3>
              <div className="flex flex-col md:flex-row gap-3">
                <div className="flex-1">
                  <Input
                    value={commentsUrl}
                    onChange={(e) => setCommentsUrl(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && startCollectComments()}
                    placeholder="Cole a URL do VOD... ex: https://www.twitch.tv/videos/2875158366"
                    className="bg-slate-950/70 border-slate-700 h-11 text-sm placeholder:text-slate-500"
                  />
                </div>
                <Button
                  onClick={startCollectComments}
                  disabled={loadingComments || commentsJob?.status === "running"}
                  className="h-11 px-6 bg-purple-600 hover:bg-purple-700 text-white font-medium"
                >
                  {loadingComments || commentsJob?.status === "running" ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <MessageSquare className="w-4 h-4 mr-2" />
                  )}
                  Coletar comentários
                </Button>
              </div>

              {/* Status da coleta */}
              {commentsJob && (
                <div className="mt-5 p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      {commentsJob.status === "running" && (
                        <Loader2 className="w-4 h-4 text-purple-400 animate-spin shrink-0" />
                      )}
                      {commentsJob.status === "done" && (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      )}
                      {commentsJob.status === "error" && (
                        <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                      )}
                      <span className="text-sm text-slate-200 truncate">
                        {commentsJob.status === "running"
                          ? `Coletando comentários... página ${commentsJob.page}`
                          : commentsJob.status === "done"
                            ? "Coleta concluída!"
                            : "Erro na coleta"}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-slate-400 hover:text-white shrink-0"
                      onClick={resetComments}
                      title="Limpar"
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>

                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-semibold text-slate-100 tabular-nums">{commentsJob.count.toLocaleString("pt-BR")}</span>
                    <span className="text-xs text-slate-400">comentário(s) coletado(s)</span>
                  </div>

                  {commentsJob.status === "running" && (
                    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
                      <div className="h-full w-1/3 rounded-full bg-purple-500 animate-pulse" />
                    </div>
                  )}

                  {commentsJob.status === "error" && (
                    <p className="text-xs text-rose-400 break-words">{commentsJob.error}</p>
                  )}

                  {commentsJob.status === "done" && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      <a
                        href={`/api/vod/comments/${commentsJob.id}/download?format=txt`}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-medium transition-colors"
                      >
                        <FileText className="w-3.5 h-3.5 text-slate-300" />
                        Baixar .txt
                      </a>
                      <a
                        href={`/api/vod/comments/${commentsJob.id}/download?format=csv`}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600/15 hover:bg-emerald-600/25 border border-emerald-600/30 text-emerald-400 text-xs font-medium transition-colors"
                      >
                        <FileSpreadsheet className="w-3.5 h-3.5" />
                        Baixar .csv
                      </a>
                      <a
                        href={`/api/vod/comments/${commentsJob.id}/download?format=json`}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600/15 hover:bg-indigo-600/25 border border-indigo-600/30 text-indigo-300 text-xs font-medium transition-colors"
                      >
                        <FileJson className="w-3.5 h-3.5" />
                        Baixar .json
                      </a>
                    </div>
                  )}
                </div>
              )}

              {!commentsJob && (
                <p className="text-xs text-slate-500 mt-4">
                  Coleta todos os comentários do chat do VOD e permite baixar em <code className="text-slate-300">.txt</code>, <code className="text-slate-300">.csv</code> ou <code className="text-slate-300">.json</code>, com timestamp de cada mensagem.
                </p>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </main>

      <footer className="border-t border-slate-800/80 bg-slate-950/80 py-4 text-center text-xs text-slate-500">
        <p>VOD Downloader &bull; Downloads de VODs da Twitch via yt-dlp &bull; Arquivos salvos na pasta ./downloads</p>
      </footer>
    </div>
  );
}
