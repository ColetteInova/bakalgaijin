import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = path.resolve(__dirname, "..");
const DOWNLOADS_DIR = path.join(ROOT_DIR, "downloads");
const SAIDA_DIR = path.join(ROOT_DIR, "saida");
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
fs.mkdirSync(SAIDA_DIR, { recursive: true });

interface PipelineState {
  status: "idle" | "running" | "done" | "error";
  step: string;
  stepLabel: string;
  commentsCount?: number;
  folder?: string;
  videoId?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
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
  startedAt: number;
  child?: ChildProcess;
  pipeline?: PipelineState;
}

const jobs = new Map<string, VodJob>();

interface VodComment {
  id: string;
  offset: number;
  login: string;
  displayName: string;
  text: string;
}

interface VodCommentsJob {
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

const commentsJobs = new Map<string, VodCommentsJob>();

const TWITCH_GQL_URL = "https://gql.twitch.tv/gql";
const TWITCH_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchCommentsPage(videoId: string, offset: number) {
  const query = `query { video(id: "${videoId}") { title comments(contentOffsetSeconds: ${offset}) { pageInfo { hasNextPage } edges { cursor node { id contentOffsetSeconds commenter { login displayName } message { fragments { text } } } } } } }`;
  const res = await fetch(TWITCH_GQL_URL, {
    method: "POST",
    headers: {
      "Client-Id": TWITCH_CLIENT_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: {} }),
  });
  if (!res.ok) throw new Error(`Twitch GQL respondeu ${res.status}`);
  const json = (await res.json()) as any;
  if (json?.errors?.length) throw new Error(json.errors[0].message || "Erro na consulta GQL");
  return json?.data?.video as {
    title?: string;
    comments?: {
      pageInfo?: { hasNextPage?: boolean };
      edges?: Array<{
        node: {
          id: string;
          contentOffsetSeconds: number;
          commenter?: { login?: string; displayName?: string };
          message?: { fragments?: Array<{ text?: string }> };
        };
      }>;
    };
  };
}

function sanitizeFilename(name: string) {
  return (
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\w\-. ]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "vod"
  );
}

async function collectAllComments(
  videoId: string,
  onProgress: (page: number, count: number) => void
): Promise<{ title: string; comments: VodComment[] }> {
  const seen = new Map<string, VodComment>();
  let offset = 0;
  let page = 0;
  let title = "";

  while (true) {
    const data = await fetchCommentsPage(videoId, offset);
    if (!title && data?.title) title = data.title;
    const edges = data?.comments?.edges ?? [];
    for (const edge of edges) {
      const node = edge.node;
      const text = (node.message?.fragments ?? [])
        .map((f) => f.text ?? "")
        .join("")
        .trim();
      if (text && !seen.has(node.id)) {
        seen.set(node.id, {
          id: node.id,
          offset: node.contentOffsetSeconds ?? 0,
          login: node.commenter?.login ?? "",
          displayName: node.commenter?.displayName ?? "",
          text,
        });
      }
    }
    page += 1;
    onProgress(page, seen.size);

    const hasNext = data?.comments?.pageInfo?.hasNextPage;
    if (!hasNext) break;
    const maxOffset = edges.reduce(
      (mx, e) => Math.max(mx, e.node.contentOffsetSeconds ?? 0),
      0
    );
    if (!maxOffset) break;
    offset = maxOffset + 1;
    await sleep(300);
  }

  return {
    title: title || `vod-${videoId}`,
    comments: Array.from(seen.values()).sort((a, b) => a.offset - b.offset),
  };
}

const QUALITY_ARGS: Record<string, string[]> = {
  "1080p": ["bv*[height<=1080]+ba/b[height<=1080]/b", "--merge-output-format", "mp4"],
  "720p": ["bv*[height<=720]+ba/b[height<=720]/b", "--merge-output-format", "mp4"],
  "480p": ["bv*[height<=480]+ba/b[height<=480]/b", "--merge-output-format", "mp4"],
  "360p": ["bv*[height<=360]+ba/b[height<=360]/b", "--merge-output-format", "mp4"],
  audio: ["ba/b", "-x", "--audio-format", "mp3"],
};

function runYtdlp(args: string[], timeoutMs = 120000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Tempo esgotado ao buscar informações do vídeo"));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`yt-dlp não encontrado: ${err.message}`));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `yt-dlp saiu com código ${code}`));
    });
  });
}

function parseProgressLine(line: string, job: VodJob) {
  const parts = line
    .replace(/^PROGRESS\s*/, "")
    .split("|")
    .map((p) => p.trim());
  if (parts.length < 5) return;

  const percent = parseFloat(parts[0]);
  if (!Number.isNaN(percent)) {
    job.percent = Math.min(100, Math.max(0, percent));
  }
  job.totalBytes = parts[1];
  job.downloadedBytes = parts[2];
  job.speed = parts[3];
  job.eta = parts[4];
}

function serializeJob(job: VodJob) {
  const { child: _child, ...rest } = job;
  return rest;
}

// Roda um script shell (analisar.sh / preparar.sh) e retorna quando terminar.
function runScript(script: string, args: string[], onLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [script, ...args], {
      cwd: ROOT_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let errTail = "";
    const flush = (chunk: Buffer) => {
      const text = chunk.toString();
      if (onLine) onLine(text);
      errTail = (errTail + text).slice(-3000);
    };
    child.stdout.on("data", flush);
    child.stderr.on("data", flush);
    child.on("error", (err) => reject(err));
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(errTail.trim() || `Script ${script} saiu com código ${code}`));
    });
  });
}

// Coleta comentários de um VOD e grava em <folder>/comentarios.json
async function collectCommentsToFile(videoId: string, folder: string): Promise<number> {
  const result = await collectAllComments(videoId, () => {});
  const outFile = path.join(folder, "comentarios.json");
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      { videoId, title: result.title, total: result.comments.length, comments: result.comments },
      null,
      2
    ),
    "utf8"
  );
  return result.comments.length;
}

// Extrai o videoId da URL do Twitch
function extractVideoId(url: string): string | null {
  const match = url.match(/twitch\.tv\/videos\/(\d+)/);
  return match ? match[1] : null;
}

// Deriva o nome da pasta saida/ a partir do nome do arquivo baixado
// ex.: "DE VORTA AO JAPAO [v2871566138].mp4" -> "DE VORTA AO JAPAO [v2871566138]"
function folderNameFromFile(filePath: string): string {
  const base = path.basename(filePath);
  return base.replace(/\.[^.]+$/, "");
}

async function startServer() {
  const app = express();
  const server = createServer(app);

  app.use(express.json());

  // Serve downloaded files
  app.use(
    "/downloads",
    express.static(DOWNLOADS_DIR, {
      setHeaders: (res) => {
        res.setHeader("Content-Disposition", "attachment");
      },
    })
  );

  // Serve analysis output (dashboards, relatórios, vídeos) from saida/
  app.use("/saida", express.static(SAIDA_DIR));

  // Get VOD metadata
  app.post("/api/vod/info", async (req, res) => {
    const { url } = (req.body ?? {}) as { url?: string };
    if (!url) {
      res.status(400).json({ error: "URL é obrigatória" });
      return;
    }

    try {
      const { stdout } = await runYtdlp(["-J", "--no-playlist", "--no-warnings", url]);
      const info = JSON.parse(stdout);
      res.json({
        title: info.title,
        id: info.id,
        duration: info.duration,
        thumbnail: info.thumbnail,
        uploader: info.uploader,
        description: info.description?.slice(0, 500),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Falha ao buscar informações do VOD" });
    }
  });

  // Roda o fluxo completo pós-download: comentários -> transcrição -> análise
  async function runPostDownloadPipeline(job: VodJob) {
    const pipeline: PipelineState = {
      status: "running",
      step: "start",
      stepLabel: "Preparando...",
      startedAt: Date.now(),
    };
    job.pipeline = pipeline;

    try {
      const videoId = extractVideoId(job.url);
      if (!videoId) throw new Error("Não foi possível extrair o ID do VOD da URL");

      const sourceVideo = job.filename;
      if (!sourceVideo || !fs.existsSync(sourceVideo)) {
        throw new Error("Arquivo de vídeo baixado não encontrado");
      }

      // O analisar.sh cria saida/<nome-do-arquivo-sem-extensão>/
      const folderName = folderNameFromFile(sourceVideo);
      const folder = path.join(SAIDA_DIR, folderName);
      fs.mkdirSync(folder, { recursive: true });
      pipeline.folder = folderName;
      pipeline.videoId = videoId;

      // 1) coleta comentários (rápido)
      pipeline.step = "comments";
      pipeline.stepLabel = "Baixando comentários do VOD...";
      const count = await collectCommentsToFile(videoId, folder);
      pipeline.commentsCount = count;

      // 2) transcrição (analisar.sh no arquivo original -> gera audio.wav + audio.srt na pasta certa)
      pipeline.step = "transcribe";
      pipeline.stepLabel = "Transcrevendo áudio com MLX Whisper (pode demorar)...";
      await runScript("scripts/analisar.sh", [sourceVideo]);

      // 3) copia o vídeo para dentro da pasta de análise (player do dashboard)
      pipeline.step = "copy";
      pipeline.stepLabel = "Copiando vídeo para a pasta de análise...";
      const videoTarget = path.join(folder, "video.mp4");
      if (sourceVideo !== videoTarget && !fs.existsSync(videoTarget)) {
        fs.copyFileSync(sourceVideo, videoTarget);
      }

      // 4) análise (preparar.sh)
      pipeline.step = "analyze";
      pipeline.stepLabel = "Gerando relatório e dashboard...";
      await runScript("scripts/preparar.sh", [folderName]);

      pipeline.status = "done";
      pipeline.step = "done";
      pipeline.stepLabel = "Concluído!";
      pipeline.finishedAt = Date.now();
    } catch (err) {
      pipeline.status = "error";
      pipeline.step = "error";
      pipeline.stepLabel = "Erro no pipeline";
      pipeline.error = err instanceof Error ? err.message : "Falha no processamento";
      pipeline.finishedAt = Date.now();
    }
  }

  function launchDownload(job: VodJob, extraArgs: string[] = []) {
    const q = job.quality && QUALITY_ARGS[job.quality] ? job.quality : "1080p";

    const args = [
      "--progress",
      "--newline",
      "--no-playlist",
      "--no-warnings",
      ...extraArgs,
      "-f",
      QUALITY_ARGS[q][0],
      ...QUALITY_ARGS[q].slice(1),
      "-o",
      path.join(DOWNLOADS_DIR, "%(title)s [%(id)s].%(ext)s"),
      "--progress-template",
      "PROGRESS %(progress._percent_str)s|%(progress._total_bytes_str)s|%(progress._downloaded_bytes_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
      "--print",
      "after_move:filepath",
      job.url,
    ];

    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    job.child = child;

    let stderrTail = "";
    let stdoutBuffer = "";

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("PROGRESS")) {
          parseProgressLine(trimmed, job);
        } else if (trimmed.startsWith(DOWNLOADS_DIR) || trimmed.startsWith("/")) {
          job.filename = trimmed;
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });

    child.on("error", (err) => {
      job.status = "error";
      job.error = `Falha ao iniciar yt-dlp: ${err.message}`;
      job.child = undefined;
    });

    child.on("exit", (code) => {
      const leftover = stdoutBuffer.trim();
      if (leftover && (leftover.startsWith(DOWNLOADS_DIR) || leftover.startsWith("/"))) {
        job.filename = leftover;
      }
      job.child = undefined;
      if (job.status === "cancelled") return;
      if (code === 0) {
        job.status = "done";
        job.percent = 100;
        if (!job.filename) {
          job.filename = job.title;
        }
        // Após baixar o vídeo (não áudio), roda o fluxo completo automaticamente
        if (job.quality !== "audio") {
          runPostDownloadPipeline(job);
        }
      } else {
        job.status = "error";
        job.error = stderrTail.trim() || `yt-dlp saiu com código ${code}`;
      }
    });
  }

  // Start a download job
  app.post("/api/vod/download", (req, res) => {
    const { url, quality, title } = (req.body ?? {}) as { url?: string; quality?: string; title?: string };
    if (!url) {
      res.status(400).json({ error: "URL é obrigatória" });
      return;
    }

    const q = quality && QUALITY_ARGS[quality] ? quality : "1080p";
    const id = crypto.randomUUID();

    const job: VodJob = {
      id,
      url,
      title: title || url,
      quality: q,
      status: "running",
      percent: 0,
      speed: "",
      eta: "",
      downloadedBytes: "",
      totalBytes: "",
      startedAt: Date.now(),
    };
    jobs.set(id, job);

    launchDownload(job);

    res.json({ id });
  });

  // Retry post-processing (remux) for a download that failed with "Conversion failed!"
  app.post("/api/vod/retry/:id", (req, res) => {
    const original = jobs.get(req.params.id);
    if (!original) {
      res.status(404).json({ error: "Download não encontrado" });
      return;
    }

    const id = crypto.randomUUID();
    const job: VodJob = {
      id,
      url: original.url,
      title: `[retry] ${original.title}`,
      quality: original.quality,
      status: "running",
      percent: 0,
      speed: "",
      eta: "",
      downloadedBytes: "",
      totalBytes: "",
      startedAt: Date.now(),
    };
    jobs.set(id, job);

    // Força o download do arquivo já baixado + remux (copia streams sem reencodar),
    // evitando a falha de conversão do ffmpeg. Para mp4 usa remux, para mp3 força a extração.
    const extraArgs =
      original.quality === "audio"
        ? ["--force-overwrites", "--audio-format", "mp3"]
        : ["--force-overwrites", "--remux-video", "mp4"];

    launchDownload(job, extraArgs);

    res.json({ id });
  });

  // List jobs
  app.get("/api/vod/jobs", (_req, res) => {
    res.json(Array.from(jobs.values()).map(serializeJob));
  });

  // Start collecting all comments of a VOD
  app.post("/api/vod/comments", async (req, res) => {
    const { url } = (req.body ?? {}) as { url?: string };
    if (!url) {
      res.status(400).json({ error: "URL é obrigatória" });
      return;
    }

    const match = url.match(/twitch\.tv\/videos\/(\d+)/);
    if (!match) {
      res.status(400).json({ error: "URL inválida. Use o formato https://www.twitch.tv/videos/123456" });
      return;
    }

    const videoId = match[1];
    const id = crypto.randomUUID();
    const job: VodCommentsJob = {
      id,
      videoId,
      title: "",
      status: "running",
      page: 0,
      count: 0,
      startedAt: Date.now(),
    };
    commentsJobs.set(id, job);

    res.json({ id });

    // Run collection in the background
    collectAllComments(videoId, (page, count) => {
      job.page = page;
      job.count = count;
    })
      .then((result) => {
        job.title = result.title;
        job.comments = result.comments;
        job.count = result.comments.length;
        job.status = "done";
      })
      .catch((err) => {
        job.status = "error";
        job.error = err instanceof Error ? err.message : "Falha ao coletar comentários";
      });
  });

  // Get status of a comments job
  app.get("/api/vod/comments/:id", (req, res) => {
    const job = commentsJobs.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Coleta não encontrada" });
      return;
    }
    const { comments, ...rest } = job;
    res.json(comments ? { ...rest, comments } : rest);
  });

  // Download collected comments — also saves the file into the ./downloads folder
  app.get("/api/vod/comments/:id/download", (req, res) => {
    const job = commentsJobs.get(req.params.id);
    if (!job || job.status !== "done" || !job.comments) {
      res.status(404).json({ error: "Comentários não disponíveis" });
      return;
    }
    const format = (req.query.format as string) || "txt";
    const base = sanitizeFilename(job.title || `vod-${job.videoId}`);

    if (format === "json") {
      const content = JSON.stringify(
        {
          videoId: job.videoId,
          title: job.title,
          total: job.comments.length,
          comments: job.comments,
        },
        null,
        2
      );
      const filename = `${base}-comentarios.json`;
      fs.writeFileSync(path.join(DOWNLOADS_DIR, filename), content, "utf8");
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(content);
      return;
    }

    if (format === "csv") {
      const escapeCsv = (value: string) => `"${(value ?? "").replace(/"/g, '""')}"`;
      const header = "offset_segundos,timestamp,usuario,nome,comentario";
      const rows = job.comments.map((c) =>
        [
          c.offset,
          formatTimestamp(c.offset),
          escapeCsv(c.login),
          escapeCsv(c.displayName),
          escapeCsv(c.text),
        ].join(",")
      );
      const content = "\uFEFF" + [header, ...rows].join("\n");
      const filename = `${base}-comentarios.csv`;
      fs.writeFileSync(path.join(DOWNLOADS_DIR, filename), content, "utf8");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(content);
      return;
    }

    // Default: txt (one comment per line with timestamp)
    const lines = job.comments.map(
      (c) => `[${formatTimestamp(c.offset)}] ${c.displayName || c.login}: ${c.text}`
    );
    const content = lines.join("\n");
    const filename = `${base}-comentarios.txt`;
    fs.writeFileSync(path.join(DOWNLOADS_DIR, filename), content, "utf8");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(content);
  });

  function formatTimestamp(seconds: number) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const pad = (n: number) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  // Cancel a job
  app.post("/api/vod/cancel/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Download não encontrado" });
      return;
    }
    if (job.status === "running") {
      job.status = "cancelled";
      job.child?.kill("SIGTERM");
      setTimeout(() => job.child?.kill("SIGKILL"), 5000);
    }
    res.json({ ok: true });
  });

  // Remove a finished job from the list
  app.delete("/api/vod/jobs/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.status === "running") {
      res.status(404).json({ error: "Download não encontrado" });
      return;
    }
    jobs.delete(req.params.id);
    res.json({ ok: true });
  });

  // Serve static files from dist/public in production
  const staticPath =
    process.env.NODE_ENV === "production"
      ? path.resolve(__dirname, "public")
      : path.resolve(__dirname, "..", "dist", "public");

  app.use(express.static(staticPath));

  // Handle client-side routing - serve index.html for all routes
  app.get("*", (_req, res) => {
    res.sendFile(path.join(staticPath, "index.html"));
  });

  const port = process.env.PORT || (process.env.NODE_ENV === "production" ? 3000 : 3001);

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
