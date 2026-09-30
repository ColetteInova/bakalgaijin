import { spawn, type ChildProcess } from "child_process";
import crypto from "crypto";
import express from "express";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import fs from "fs";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = path.resolve(__dirname, "..");
const DOWNLOADS_DIR = path.join(ROOT_DIR, "downloads");
const SAIDA_DIR = path.join(ROOT_DIR, "saida");
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
fs.mkdirSync(SAIDA_DIR, { recursive: true });

// Carrega variáveis do .env (ex.: DEEPSEEK_API_KEY) para os scripts de análise
function loadDotEnv() {
  const envPath = path.join(ROOT_DIR, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2].replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

// ===== Firebase Admin (somente servidor) =====
// A service account é secreta: fica no .env (FIREBASE_SERVICE_ACCOUNT, JSON em linha única)
// ou no arquivo firebase-service-account.json (ou GOOGLE_APPLICATION_CREDENTIALS).
function loadFirebaseServiceAccount(): object | null {
  const inline = (process.env.FIREBASE_SERVICE_ACCOUNT || "").trim();
  if (inline) {
    try {
      return JSON.parse(inline);
    } catch {
      console.warn("[firebase] FIREBASE_SERVICE_ACCOUNT não é um JSON válido");
      return null;
    }
  }
  const credPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(ROOT_DIR, "firebase-service-account.json");
  const candidatePaths = [credPath, path.join(ROOT_DIR, "client", "firebase-service-account.json")];
  for (const candidate of candidatePaths) {
    if (!fs.existsSync(candidate)) continue;
    try {
      return JSON.parse(fs.readFileSync(candidate, "utf8"));
    } catch {
      console.warn(`[firebase] não foi possível ler a service account em ${candidate}`);
      return null;
    }
  }
  return null;
}

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "";
// Cookie de sessão (UI) usado pela fanpage para saber se o visitante está logado
const AUTH_COOKIE = "bakalover_auth=1; Path=/; Max-Age=31536000; SameSite=Lax";
let firebaseReady = false;
{
  const serviceAccount = loadFirebaseServiceAccount();
  if (serviceAccount && FIREBASE_PROJECT_ID && getApps().length === 0) {
    try {
      initializeApp({ credential: cert(serviceAccount as any), projectId: FIREBASE_PROJECT_ID });
      firebaseReady = true;
      console.log("[firebase] inicializado");
    } catch (error) {
      console.warn("[firebase] falha ao inicializar:", error);
    }
  } else if (!serviceAccount) {
    console.warn("[firebase] service account ausente — login/cadastro Firebase desativado");
  }
}

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

// Histórico de downloads concluídos, persistido em arquivo para sobreviver a reinícios
interface HistoryItem {
  filename: string;
  title: string;
  quality: string;
  date: string;
}

const HISTORY_FILE = path.join(ROOT_DIR, ".vod-history.json");

function loadHistory(): HistoryItem[] {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
      if (Array.isArray(data)) {
        return data.filter((h) => h && typeof h.filename === "string");
      }
    }
  } catch {
    // arquivo corrompido: começa vazio
  }
  return [];
}

function saveHistory(items: HistoryItem[]) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(items, null, 2), "utf8");
  } catch {
    // falha ao gravar não deve derrubar o servidor
  }
}

function addToHistory(job: VodJob) {
  if (!job.filename || !job.quality) return;
  if (history.some((h) => h.filename === job.filename)) return;
  history.unshift({
    filename: job.filename,
    title: job.title,
    quality: job.quality,
    date: new Date().toLocaleString("pt-BR"),
  });
  if (history.length > 200) history.length = 200;
  saveHistory(history);
}

const history: HistoryItem[] = loadHistory();

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

// Twitch OAuth (user access token, fluxo implícito) — configurado via .env.
// Docs: https://dev.twitch.tv/docs/authentication/#user-access-tokens
const TWITCH_OAUTH_CLIENT_ID = process.env.TWITCH_OAUTH_CLIENT_ID || "";
const TWITCH_OAUTH_VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";
const TWITCH_HELIX_USERS_URL = "https://api.twitch.tv/helix/users";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Valida um user access token da Twitch e devolve os dados do usuário dono do token.
async function fetchTwitchUser(accessToken: string) {
  const validation = await fetch(TWITCH_OAUTH_VALIDATE_URL, {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  if (!validation.ok) {
    throw new Error(
      validation.status === 401
        ? "Token da Twitch inválido ou expirado. Tente conectar novamente."
        : `Twitch respondeu ${validation.status}`
    );
  }
  const identity = (await validation.json()) as {
    client_id?: string;
    login?: string;
    user_id?: string;
    expires_in?: number;
  };
  if (!identity.login) {
    throw new Error("O token da Twitch não contém um usuário");
  }
  if (TWITCH_OAUTH_CLIENT_ID && identity.client_id && identity.client_id !== TWITCH_OAUTH_CLIENT_ID) {
    throw new Error("Token emitido para outra aplicação Twitch");
  }

  let displayName = identity.login;
  let profileImageUrl = "";
  if (TWITCH_OAUTH_CLIENT_ID) {
    try {
      const usersRes = await fetch(TWITCH_HELIX_USERS_URL, {
        headers: {
          "Client-Id": TWITCH_OAUTH_CLIENT_ID,
          Authorization: `Bearer ${accessToken}`,
        },
      });
      if (usersRes.ok) {
        const users = (await usersRes.json()) as {
          data?: Array<{ login?: string; display_name?: string; profile_image_url?: string }>;
        };
        const user = users.data?.[0];
        if (user) {
          displayName = user.display_name || displayName;
          profileImageUrl = user.profile_image_url || "";
        }
      }
    } catch {
      // sem detalhes extras: mantém apenas o login validado
    }
  }

  return {
    login: identity.login,
    displayName,
    profileImageUrl,
    userId: identity.user_id || "",
    expiresIn: identity.expires_in || 0,
  };
}

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
function runScript(
  script: string,
  args: string[],
  onLine?: (line: string) => void,
  env?: Record<string, string>
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [script, ...args], {
      cwd: ROOT_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : process.env,
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

// Roda um script Python (.venv-ia ou python3 do sistema) e retorna quando terminar.
const PY_BIN = path.join(ROOT_DIR, ".venv-ia", "bin", "python");

function runPython(args: string[], onLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const bin = fs.existsSync(PY_BIN) ? PY_BIN : "python3";
    const child = spawn(bin, args, {
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
      else reject(new Error(errTail.trim() || `Python ${args[0]} saiu com código ${code}`));
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

// Extrai o videoId do nome do arquivo baixado, ex.: "... [v2885710366].mp4"
function extractVideoIdFromFilename(filePath: string): string | null {
  const match = path.basename(filePath).match(/\[v(\d+)\]/i);
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

      // 2) transcrição + cópia do vídeo (analisar.sh gera audio.wav/audio.srt e copia video.mp4 para a pasta)
      pipeline.step = "transcribe";
      pipeline.stepLabel = "Transcrevendo áudio com MLX Whisper (pode demorar)...";
      await runScript("scripts/analisar.sh", [sourceVideo]);

      // 3) análise (preparar.sh usa o video.mp4 da pasta para o dashboard e os cortes)
      pipeline.step = "analyze";
      pipeline.stepLabel = "Gerando relatório, dashboard e cortes...";
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

  // Re-roda o fluxo de preparação (comentários -> transcrição -> análise)
  // usando um vídeo já baixado, refazendo apenas as etapas que faltam.
  async function runPreparePipeline(job: VodJob) {
    const pipeline: PipelineState = {
      status: "running",
      step: "start",
      stepLabel: "Preparando...",
      startedAt: Date.now(),
    };
    job.pipeline = pipeline;

    try {
      const sourceVideo = job.filename;
      if (!sourceVideo || !fs.existsSync(sourceVideo)) {
        throw new Error("Arquivo de vídeo baixado não encontrado");
      }

      const folderName = folderNameFromFile(sourceVideo);
      const folder = path.join(SAIDA_DIR, folderName);
      fs.mkdirSync(folder, { recursive: true });
      pipeline.folder = folderName;

      const videoId = extractVideoIdFromFilename(sourceVideo) || extractVideoId(job.url);
      pipeline.videoId = videoId ?? undefined;

      // 1) comentários (re-coleta apenas se ainda não existir)
      if (videoId) {
        pipeline.step = "comments";
        pipeline.stepLabel = "Baixando comentários do VOD...";
        if (!fs.existsSync(path.join(folder, "comentarios.json"))) {
          const count = await collectCommentsToFile(videoId, folder);
          pipeline.commentsCount = count;
        }
      }

      // 2) transcrição (refaz apenas se audio.srt ainda não existir)
      if (!fs.existsSync(path.join(folder, "audio.srt"))) {
        pipeline.step = "transcribe";
        pipeline.stepLabel = "Transcrevendo áudio com MLX Whisper (pode demorar)...";
        await runScript("scripts/analisar.sh", [sourceVideo]);
      }

      // 3) análise (sempre refaz)
      pipeline.step = "analyze";
      pipeline.stepLabel = "Gerando relatório, dashboard e cortes...";
      await runScript("scripts/preparar.sh", [folderName]);

      // 4) refaz a preparação de todos os vídeos antigos (repreparar_todos.sh)
      pipeline.step = "reprepare_all";
      pipeline.stepLabel = "Refazendo preparação de todos os vídeos antigos...";
      await runScript("scripts/repreparar_todos.sh", []);

      pipeline.status = "done";
      pipeline.step = "done";
      pipeline.stepLabel = "Concluído!";
      pipeline.finishedAt = Date.now();
      if (job.status === "running") {
        job.status = "done";
        job.percent = 100;
      }
    } catch (err) {
      pipeline.status = "error";
      pipeline.step = "error";
      pipeline.stepLabel = "Erro no pipeline";
      pipeline.error = err instanceof Error ? err.message : "Falha no processamento";
      pipeline.finishedAt = Date.now();
      if (job.status === "running") {
        job.status = "error";
        job.error = pipeline.error;
      }
    }
  }

  // Re-executa UMA etapa do pré-processamento de um episódio já preparado (pasta em saida/).
  // Etapas: tudo, analise, cortes, mapa, comentarios, transcricao, local (muda a cidade do Baka).
  async function runPreparedFolderStep(
    job: VodJob,
    folderPath: string,
    step: string,
    local?: string,
    bairro?: string
  ) {
    const pipeline = job.pipeline!;
    const folderName = path.basename(folderPath);
    try {
      if (step === "local") {
        const localFile = path.join(folderPath, "local.json");
        const bairroLimpo = (bairro || "").trim();
        if (!local || local === "auto") {
          if (bairroLimpo) {
            fs.writeFileSync(
              localFile,
              JSON.stringify({ local: "auto", bairro: bairroLimpo }, null, 2),
              "utf8"
            );
          } else {
            fs.rmSync(localFile, { force: true });
          }
        } else if (local === "japao" || local === "sao-paulo") {
          fs.writeFileSync(
            localFile,
            JSON.stringify(
              {
                pais: local === "japao" ? "japao" : "brasil",
                cidade: local === "japao" ? "toquio" : "sao-paulo",
                local,
                bairro: bairroLimpo,
              },
              null,
              2
            ),
            "utf8"
          );
        }
        // invalida o cache de geoloc para re-geolocalizar na nova cidade
        fs.rmSync(path.join(folderPath, "mapa", "geoloc.json"), { force: true });
        fs.rmSync(path.join(folderPath, "mapa", "osrm_route.json"), { force: true });
        pipeline.stepLabel = "Re-geolocalizando o mapa na nova cidade...";
        await runPython(["scripts/preparar.py", folderPath]);
      } else if (step === "comentarios") {
        pipeline.stepLabel = "Coletando comentários do VOD...";
        let videoId: string | null = null;
        const commentsFile = path.join(folderPath, "comentarios.json");
        if (fs.existsSync(commentsFile)) {
          try {
            videoId = JSON.parse(fs.readFileSync(commentsFile, "utf8")).videoId || null;
          } catch {
            // tenta inferir pelo nome da pasta
          }
        }
        if (!videoId) {
          const m = folderName.match(/\[v(\d+)\]/i);
          videoId = m ? m[1] : null;
        }
        if (!videoId) throw new Error("Não foi possível identificar o videoId deste episódio");
        const count = await collectCommentsToFile(videoId, folderPath);
        pipeline.commentsCount = count;
      } else if (step === "transcricao") {
        pipeline.stepLabel = "Re-transcrevendo áudio com MLX Whisper (pode demorar)...";
        const videoFile = ["video.mp4", "video.webm", "video.mov", "video.m4v"]
          .map((f) => path.join(folderPath, f))
          .find((f) => fs.existsSync(f));
        if (!videoFile) throw new Error("Nenhum vídeo (video.mp4 etc.) na pasta do episódio");
        await runScript("scripts/analisar.sh", [videoFile]);
      } else if (step === "tudo") {
        // reprocessa tudo: comentários -> transcrição -> cortes + análise completa
        let videoId: string | null = null;
        const commentsFile = path.join(folderPath, "comentarios.json");
        if (fs.existsSync(commentsFile)) {
          try {
            videoId = JSON.parse(fs.readFileSync(commentsFile, "utf8")).videoId || null;
          } catch {
            // tenta inferir pelo nome da pasta
          }
        }
        if (!videoId) {
          const m = folderName.match(/\[v(\d+)\]/i);
          videoId = m ? m[1] : null;
        }
        if (videoId) {
          pipeline.stepLabel = "Baixando comentários do VOD...";
          const count = await collectCommentsToFile(videoId, folderPath);
          pipeline.commentsCount = count;
        }

        const videoFile = ["video.mp4", "video.webm", "video.mov", "video.m4v"]
          .map((f) => path.join(folderPath, f))
          .find((f) => fs.existsSync(f));
        if (videoFile) {
          pipeline.stepLabel = "Re-transcrevendo áudio com MLX Whisper (pode demorar)...";
          await runScript("scripts/analisar.sh", [videoFile]);
        }

        pipeline.stepLabel = "Refazendo cortes e análise completa...";
        fs.rmSync(path.join(folderPath, "cortes"), { recursive: true, force: true });
        await runScript("scripts/preparar.sh", [folderName]);
      } else if (step === "cortes") {
        pipeline.stepLabel = "Refazendo cortes virais com ffmpeg...";
        await runPython(["scripts/cortar.py", "--force", folderPath]);
        pipeline.stepLabel = "Atualizando dashboard com os cortes...";
        await runPython(["scripts/preparar.py", folderPath]);
      } else if (step === "mapa") {
        pipeline.stepLabel = "Refazendo geolocalização do mapa...";
        fs.rmSync(path.join(folderPath, "mapa", "geoloc.json"), { force: true });
        fs.rmSync(path.join(folderPath, "mapa", "osrm_route.json"), { force: true });
        await runPython(["scripts/preparar.py", folderPath]);
      } else if (step === "qualidade") {
        pipeline.stepLabel = "Gerando versões em qualidade baixa (ffmpeg)...";
        await runPython(["scripts/qualidade.py", folderPath]);
      } else {
        // "analise": fluxo completo do preparar.sh (relatório, dashboard e cortes se faltarem)
        pipeline.stepLabel = "Refazendo análise completa (relatório, dashboard, cortes)...";
        await runScript("scripts/preparar.sh", [folderName]);
      }

      pipeline.status = "done";
      pipeline.step = "done";
      pipeline.stepLabel = "Concluído!";
      pipeline.finishedAt = Date.now();
      if (job.status === "running") {
        job.status = "done";
        job.percent = 100;
      }
    } catch (err) {
      pipeline.status = "error";
      pipeline.step = "error";
      pipeline.stepLabel = "Erro";
      pipeline.error = err instanceof Error ? err.message : "Falha no processamento";
      pipeline.finishedAt = Date.now();
      if (job.status === "running") {
        job.status = "error";
        job.error = pipeline.error;
      }
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
        addToHistory(job);
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

  // Histórico de downloads concluídos (persistido em .vod-history.json)
  app.get("/api/vod/history", (_req, res) => {
    res.json(history);
  });

  // Limpa o histórico persistido
  app.delete("/api/vod/history", (_req, res) => {
    history.length = 0;
    saveHistory(history);
    res.json({ ok: true });
  });

  // Migração: adiciona itens de histórico vindos do cliente (ex.: localStorage antigo)
  app.post("/api/vod/history", (req, res) => {
    const { items } = (req.body ?? {}) as { items?: HistoryItem[] };
    if (!Array.isArray(items)) {
      res.status(400).json({ error: "items deve ser uma lista" });
      return;
    }
    for (const item of items) {
      if (!item || typeof item.filename !== "string") continue;
      if (history.some((h) => h.filename === item.filename)) continue;
      history.unshift({
        filename: item.filename,
        title: item.title ?? "",
        quality: item.quality ?? "",
        date: item.date ?? "",
      });
    }
    if (history.length > 200) history.length = 200;
    saveHistory(history);
    res.json(history);
  });

  // Re-roda a preparação (comentários -> transcrição -> análise) de um vídeo já baixado
  app.post("/api/vod/prepare", (req, res) => {
    const { filename, local, bairro } = (req.body ?? {}) as {
      filename?: string;
      local?: string;
      bairro?: string;
    };
    if (!filename || typeof filename !== "string") {
      res.status(400).json({ error: "Nome de arquivo é obrigatório" });
      return;
    }

    const target = path.isAbsolute(filename) ? path.resolve(filename) : path.join(DOWNLOADS_DIR, filename);
    if (!target.startsWith(DOWNLOADS_DIR + path.sep) && target !== DOWNLOADS_DIR) {
      res.status(400).json({ error: "Arquivo fora da pasta ./downloads" });
      return;
    }
    if (!fs.existsSync(target)) {
      res.status(404).json({ error: `Arquivo não encontrado: ${path.basename(filename)}` });
      return;
    }

    // Persiste a escolha do local da live (japao/sao-paulo + bairro livre) na pasta do vídeo;
    // "auto" apaga a escolha anterior para o DeepSeek redetectar pela fala/comentários
    // (a menos que haja um bairro digitado — ele é mantido).
    if (local && ["japao", "sao-paulo", "auto"].includes(local)) {
      const folder = path.join(SAIDA_DIR, folderNameFromFile(target));
      const localFile = path.join(folder, "local.json");
      const bairroLimpo = (bairro || "").trim();
      if (local === "auto") {
        if (bairroLimpo) {
          fs.mkdirSync(folder, { recursive: true });
          fs.writeFileSync(localFile, JSON.stringify({ local: "auto", bairro: bairroLimpo }, null, 2), "utf8");
        } else {
          fs.rmSync(localFile, { force: true });
        }
      } else {
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(
          localFile,
          JSON.stringify(
            {
              pais: local === "japao" ? "japao" : "brasil",
              cidade: local === "japao" ? "toquio" : "sao-paulo",
              local,
              bairro: bairroLimpo,
            },
            null,
            2
          ),
          "utf8"
        );
      }
    }

    const id = crypto.randomUUID();
    const job: VodJob = {
      id,
      url: "",
      title: `[preparar] ${path.basename(target)}`,
      quality: "",
      status: "running",
      percent: 0,
      speed: "",
      eta: "",
      downloadedBytes: "",
      totalBytes: "",
      startedAt: Date.now(),
      filename: target,
    };
    jobs.set(id, job);

    runPreparePipeline(job);

    res.json({ id });
  });

  // Lista os episódios já preparados (pastas em saida/) com o status de cada etapa
  app.get("/api/vod/prepared", (_req, res) => {
    const folders = fs
      .readdirSync(SAIDA_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const folderPath = path.join(SAIDA_DIR, d.name);
        const has = (f: string) => fs.existsSync(path.join(folderPath, f));
        const statOf = (f: string) => {
          try {
            return fs.statSync(path.join(folderPath, f)).mtimeMs;
          } catch {
            return 0;
          }
        };

        let local = "auto";
        let bairro = "";
        if (has("local.json")) {
          try {
            const localData = JSON.parse(fs.readFileSync(path.join(folderPath, "local.json"), "utf8"));
            local = localData.local || localData.cidade || "auto";
            bairro = localData.bairro || "";
          } catch {
            // mantém "auto"
          }
        }

        let commentsCount: number | undefined;
        if (has("comentarios.json")) {
          try {
            commentsCount = (JSON.parse(fs.readFileSync(path.join(folderPath, "comentarios.json"), "utf8")).comments || []).length;
          } catch {
            // sem contagem
          }
        }

        const cortesDir = path.join(folderPath, "cortes");
        let cortes = 0;
        if (fs.existsSync(cortesDir)) {
          cortes = fs.readdirSync(cortesDir).filter((f) => f.toLowerCase().endsWith(".mp4")).length;
        }

        const mapaDir = path.join(folderPath, "mapa");
        let mapFrames = 0;
        if (fs.existsSync(mapaDir)) {
          mapFrames = fs.readdirSync(mapaDir).filter((f) => f.startsWith("marco_")).length;
        }

        let qualidades = 0;
        try {
          qualidades = fs
            .readdirSync(folderPath)
            .filter((f) => /^video_\d+\.mp4$/i.test(f)).length;
        } catch {
          // pasta sem leitura: mantém 0
        }

        return {
          folder: d.name,
          local,
          bairro,
          hasComments: has("comentarios.json"),
          commentsCount,
          hasSrt: has("audio.srt"),
          hasVideo: ["video.mp4", "video.webm", "video.mov", "video.m4v"].some(has),
          hasReport: has("relatorio.json"),
          hasDashboard: has("dashboard.html"),
          cortes,
          mapFrames,
          qualidades,
          hasGeoloc: has(path.join("mapa", "geoloc.json")),
          reportMtime: statOf("relatorio.json"),
        };
      })
      .sort((a, b) => b.reportMtime - a.reportMtime);
    res.json(folders);
  });

  async function runGlobalReprepare(job: VodJob, skipCortes: boolean) {
    const pipeline = job.pipeline!;
    let pendingOutput = "";
    try {
      await runScript(
        "scripts/repreparar_todos.sh",
        [],
        (chunk) => {
          const lines = (pendingOutput + chunk).split(/\r?\n/);
          pendingOutput = lines.pop() ?? "";
          for (const line of lines) {
            const match = line.match(/==> Processando:\s*(.+)/);
            if (match) pipeline.stepLabel = `Repreparando ${match[1]}...`;
          }
        },
        skipCortes ? { SKIP_CORTES: "1" } : undefined
      );
      pipeline.status = "done";
      pipeline.stepLabel = "Todos os episódios elegíveis foram re-preparados.";
      pipeline.finishedAt = Date.now();
      job.status = "done";
      job.percent = 100;
    } catch (err) {
      pipeline.status = "error";
      pipeline.stepLabel = "Falha ao re-preparar os episódios.";
      pipeline.error = err instanceof Error ? err.message : "Falha no re-preparo global";
      pipeline.finishedAt = Date.now();
      job.status = "error";
      job.error = pipeline.error;
    }
  }

  app.post("/api/vod/reprepare-all", (req, res) => {
    if (Array.from(jobs.values()).some((job) => job.status === "running")) {
      res.status(409).json({ error: "Aguarde o processamento atual terminar antes de iniciar o lote." });
      return;
    }

    const { skipCortes } = (req.body ?? {}) as { skipCortes?: boolean };

    const folders = fs.readdirSync(SAIDA_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    const eligibleCount = folders.filter((entry) => {
      const folderPath = path.join(SAIDA_DIR, entry.name);
      return fs.existsSync(path.join(folderPath, "comentarios.json")) && fs.existsSync(path.join(folderPath, "audio.srt"));
    }).length;
    if (!eligibleCount) {
      res.status(400).json({ error: "Nenhum episódio com comentarios.json e audio.srt para re-preparar." });
      return;
    }

    const job: VodJob = {
      id: crypto.randomUUID(),
      url: "",
      title: "Re-preparar todos os episódios",
      quality: "",
      status: "running",
      percent: 0,
      speed: "",
      eta: "",
      downloadedBytes: "",
      totalBytes: "",
      startedAt: Date.now(),
      pipeline: {
        status: "running",
        step: "reprepare_all",
        stepLabel: `Iniciando lote para ${eligibleCount} episódio(s)...`,
        startedAt: Date.now(),
      },
    };
    jobs.set(job.id, job);
    void runGlobalReprepare(job, skipCortes === true);
    res.status(202).json({ id: job.id, eligibleCount, skippedCount: folders.length - eligibleCount });
  });

  // Re-executa UMA etapa de um episódio já preparado.
  // step: analise | cortes | mapa | comentarios | transcricao | local
  app.post("/api/vod/prepare-folder", (req, res) => {
    const { folder, step, local, bairro } = (req.body ?? {}) as {
      folder?: string;
      step?: string;
      local?: string;
      bairro?: string;
    };
    if (!folder || path.basename(folder) !== folder) {
      res.status(400).json({ error: "Pasta inválida" });
      return;
    }
    const folderPath = path.join(SAIDA_DIR, folder);
    if (!folderPath.startsWith(SAIDA_DIR + path.sep)) {
      res.status(400).json({ error: "Pasta fora de ./saida" });
      return;
    }
    if (!fs.existsSync(folderPath)) {
      res.status(404).json({ error: `Pasta não encontrada: ${folder}` });
      return;
    }
    const validSteps = ["tudo", "analise", "cortes", "mapa", "comentarios", "transcricao", "local", "qualidade"];
    if (!step || !validSteps.includes(step)) {
      res.status(400).json({ error: `Etapa inválida. Use: ${validSteps.join(", ")}` });
      return;
    }
    if (step === "local" && local && !["japao", "sao-paulo", "auto"].includes(local)) {
      res.status(400).json({ error: "Local inválido. Use: japao, sao-paulo ou auto" });
      return;
    }

    const id = crypto.randomUUID();
    const job: VodJob = {
      id,
      url: "",
      title: `[${step}] ${folder}`,
      quality: "",
      status: "running",
      percent: 0,
      speed: "",
      eta: "",
      downloadedBytes: "",
      totalBytes: "",
      startedAt: Date.now(),
      filename: folderPath,
    };
    const pipeline: PipelineState = {
      status: "running",
      step: "start",
      stepLabel: "Preparando...",
      startedAt: Date.now(),
      folder,
    };
    job.pipeline = pipeline;
    jobs.set(id, job);

    runPreparedFolderStep(job, folderPath, step, local, bairro);

    res.json({ id });
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

  // ===== Bakalovers =====
  interface Bakalover {
    id: string;
    nome: string;
    apelido: string;
    twitch?: string;
    foto?: string;
    email?: string;
    notify?: boolean;
    official: boolean;
    createdAt: string;
  }

  const BAKALOVERS_FILE = path.join(ROOT_DIR, ".bakalovers.json");

  function loadBakalovers(): Bakalover[] {
    try {
      if (fs.existsSync(BAKALOVERS_FILE)) {
        const data = JSON.parse(fs.readFileSync(BAKALOVERS_FILE, "utf8"));
        if (Array.isArray(data)) {
          return data.filter((b) => b && typeof b.nome === "string" && typeof b.apelido === "string");
        }
      }
    } catch {
      // arquivo corrompido: começa vazio
    }
    return [];
  }

  function saveBakalovers(items: Bakalover[]) {
    try {
      fs.writeFileSync(BAKALOVERS_FILE, JSON.stringify(items, null, 2), "utf8");
    } catch {
      // falha ao gravar não deve derrubar o servidor
    }
  }

  const bakalovers: Bakalover[] = loadBakalovers();

  // Lista os bakalovers (apenas oficiais com ?official=true)
  app.get("/api/bakalovers", (req, res) => {
    const officialOnly = req.query.official === "true";
    const list = officialOnly ? bakalovers.filter((b) => b.official) : bakalovers;
    res.json(
      [...list].sort((a, b) => {
        if (a.official !== b.official) return a.official ? -1 : 1;
        return b.createdAt.localeCompare(a.createdAt);
      })
    );
  });

  // Busca o avatar de um usuário da Twitch pelo login (usado no cadastro de bakalovers)
  async function fetchTwitchUserAvatar(login: string): Promise<{ displayName?: string; avatar?: string }> {
    const safeLogin = login.replace(/[^a-zA-Z0-9_]/g, "");
    if (!safeLogin) return {};
    const query = `query { user(login: "${safeLogin}") { displayName profileImageURL(width: 300) } }`;
    try {
      const res = await fetch(TWITCH_GQL_URL, {
        method: "POST",
        headers: {
          "Client-Id": TWITCH_CLIENT_ID,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables: {} }),
      });
      if (!res.ok) return {};
      const json = (await res.json()) as any;
      const user = json?.data?.user;
      return {
        displayName: typeof user?.displayName === "string" ? user.displayName : undefined,
        avatar: typeof user?.profileImageURL === "string" ? user.profileImageURL : undefined,
      };
    } catch {
      return {};
    }
  }

  // Cadastra um novo bakalover (aguarda aprovação como oficial)
  app.post("/api/bakalovers", async (req, res) => {
    const { nome, apelido, twitch, email, notify } = (req.body ?? {}) as {
      nome?: string;
      apelido?: string;
      twitch?: string;
      email?: string;
      notify?: boolean;
    };
    const nomeLimpo = (nome || "").trim();
    const twitchLimpo = (twitch || "").trim().replace(/^@/, "");
    const emailLimpo = (email || "").trim().toLowerCase();
    const querAvisos = notify === true;
    const apelidoLimpo = (apelido || "").trim() || twitchLimpo || nomeLimpo;
    if (!nomeLimpo) {
      res.status(400).json({ error: "Nome é obrigatório" });
      return;
    }
    if (!emailLimpo) {
      res.status(400).json({ error: "E-mail é obrigatório" });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLimpo)) {
      res.status(400).json({ error: "E-mail inválido" });
      return;
    }
    if (bakalovers.some((b) => (b.email || "").toLowerCase() === emailLimpo)) {
      res.status(409).json({ error: "Já existe um bakalover cadastrado com esse e-mail" });
      return;
    }

    // Avatar só é incluído quando o usuário informa a conta da Twitch
    let foto = "";
    if (twitchLimpo) {
      const twitchInfo = await fetchTwitchUserAvatar(twitchLimpo);
      foto = twitchInfo.avatar || "";
    }

    const member: Bakalover = {
      id: crypto.randomUUID(),
      nome: nomeLimpo,
      apelido: apelidoLimpo,
      twitch: twitchLimpo,
      foto,
      email: emailLimpo,
      notify: querAvisos,
      official: false,
      createdAt: new Date().toISOString(),
    };
    bakalovers.unshift(member);
    saveBakalovers(bakalovers);
    res.status(201).json(member);
  });

  // Aprova/desaprova um bakalover como oficial (ou remove)
  app.patch("/api/bakalovers/:id", (req, res) => {
    const member = bakalovers.find((b) => b.id === req.params.id);
    if (!member) {
      res.status(404).json({ error: "Bakalover não encontrado" });
      return;
    }
    const { official } = (req.body ?? {}) as { official?: boolean };
    if (typeof official === "boolean") {
      member.official = official;
      saveBakalovers(bakalovers);
    }
    res.json(member);
  });

  app.delete("/api/bakalovers/:id", (req, res) => {
    const idx = bakalovers.findIndex((b) => b.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: "Bakalover não encontrado" });
      return;
    }
    bakalovers.splice(idx, 1);
    saveBakalovers(bakalovers);
    res.json({ ok: true });
  });

  // Obtém o usuário da Twitch dono de um user access token (fluxo implícito).
  // O token chega via header Authorization: Bearer ou query ?access_token=.
  app.get("/api/twitch/user", async (req, res) => {
    const authHeader = String(req.headers.authorization || "");
    const queryToken = typeof req.query.access_token === "string" ? req.query.access_token : "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : queryToken;
    if (!token) {
      res.status(400).json({ error: "Token de acesso ausente" });
      return;
    }
    try {
      const twitchUser = await fetchTwitchUser(token);
      res.setHeader("Set-Cookie", AUTH_COOKIE);
      res.json(twitchUser);
    } catch (error) {
      res.status(401).json({
        error: error instanceof Error ? error.message : "Falha ao validar o token da Twitch",
      });
    }
  });

  // ===== Auth Firebase (cadastro de Bakalovers) =====

  // Registra o perfil do usuário no Firestore (Admin SDK, server-side).
  // Dois caminhos de credencial:
  //  - Google: Authorization: Bearer <ID token do Firebase>, verificado aqui.
  //  - Twitch: twitchAccessToken no body, validado direto na Twitch (fora do Firebase Auth).
  app.post("/api/auth/register", async (req, res) => {
    if (!firebaseReady) {
      res.status(503).json({ error: "Firebase não configurado no servidor" });
      return;
    }
    const { nome, email, twitch, notify, twitchAccessToken } = (req.body ?? {}) as {
      nome?: string;
      email?: string;
      twitch?: string;
      notify?: boolean;
      twitchAccessToken?: string;
    };
    const authHeader = String(req.headers.authorization || "");
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!twitchAccessToken && !idToken) {
      res.status(400).json({ error: "Sessão inválida" });
      return;
    }
    try {
      let uid: string;
      let provider: string;
      let twitchLimpo = (twitch || "").trim().replace(/^@/, "");
      let firebaseEmail = "";
      if (twitchAccessToken) {
        // Twitch é tratada por fora: valida o token na própria Twitch
        const twitchUser = await fetchTwitchUser(twitchAccessToken);
        uid = `twitch:${twitchUser.login.toLowerCase()}`;
        provider = "twitch";
        twitchLimpo = twitchUser.login;
      } else {
        const decoded = await getAuth().verifyIdToken(idToken);
        uid = decoded.uid;
        provider = decoded.firebase.sign_in_provider || "unknown";
        firebaseEmail = decoded.email || "";
      }
      const nomeLimpo = (nome || "").trim();
      if (!nomeLimpo) {
        res.status(400).json({ error: "Nome é obrigatório" });
        return;
      }
      const emailLimpo = (email || "").trim().toLowerCase();
      if (emailLimpo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLimpo)) {
        res.status(400).json({ error: "E-mail inválido" });
        return;
      }
      const now = FieldValue.serverTimestamp();
      await getFirestore()
        .collection("bakalovers")
        .doc(uid)
        .set(
          {
            uid,
            nome: nomeLimpo,
            email: emailLimpo || firebaseEmail,
            twitch: twitchLimpo,
            notify: notify === true,
            provider,
            status: "aprovado",
            updatedAt: now,
            createdAt: now,
          },
          { merge: true }
        );
      res.setHeader("Set-Cookie", AUTH_COOKIE);
      res.json({ ok: true, uid });
    } catch (error) {
      res.status(401).json({
        error: error instanceof Error ? error.message : "Falha ao registrar no Firebase",
      });
    }
  });

  // Resolve a identidade autenticada: Google (ID token do Firebase) ou
  // Twitch (access token validado na própria Twitch, fora do Firebase Auth).
  async function resolveProfileIdentity(req: express.Request) {
    const authHeader = String(req.headers.authorization || "");
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const queryToken = typeof req.query.twitchAccessToken === "string" ? req.query.twitchAccessToken : "";
    const { twitchAccessToken: bodyToken } = (req.body ?? {}) as { twitchAccessToken?: string };
    const twitchAccessToken = bodyToken || queryToken;
    if (twitchAccessToken) {
      const twitchUser = await fetchTwitchUser(twitchAccessToken);
      return { uid: `twitch:${twitchUser.login.toLowerCase()}`, provider: "twitch" };
    }
    if (idToken) {
      const decoded = await getAuth().verifyIdToken(idToken);
      return { uid: decoded.uid, provider: decoded.firebase.sign_in_provider || "unknown" };
    }
    throw new Error("Sessão inválida");
  }

  // Painel do bakalover: retorna o perfil salvo no Firestore
  app.get("/api/auth/profile", async (req, res) => {
    if (!firebaseReady) {
      res.status(503).json({ error: "Firebase não configurado no servidor" });
      return;
    }
    try {
      const { uid } = await resolveProfileIdentity(req);
      const doc = await getFirestore().collection("bakalovers").doc(uid).get();
      if (!doc.exists) {
        res.status(404).json({ error: "Cadastro não encontrado" });
        return;
      }
      res.setHeader("Set-Cookie", AUTH_COOKIE);
      res.json(doc.data());
    } catch (error) {
      res.status(401).json({
        error: error instanceof Error ? error.message : "Falha ao carregar o perfil",
      });
    }
  });

  // Painel do bakalover: atualiza o perfil (nome, e-mail e avisos por e-mail)
  app.patch("/api/auth/profile", async (req, res) => {
    if (!firebaseReady) {
      res.status(503).json({ error: "Firebase não configurado no servidor" });
      return;
    }
    try {
      const { uid } = await resolveProfileIdentity(req);
      const { nome, email, notify } = (req.body ?? {}) as {
        nome?: string;
        email?: string;
        notify?: boolean;
      };
      const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
      if (typeof nome === "string") {
        const nomeLimpo = nome.trim();
        if (!nomeLimpo) {
          res.status(400).json({ error: "Nome é obrigatório" });
          return;
        }
        update.nome = nomeLimpo;
      }
      if (typeof email === "string") {
        const emailLimpo = email.trim().toLowerCase();
        if (emailLimpo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLimpo)) {
          res.status(400).json({ error: "E-mail inválido" });
          return;
        }
        update.email = emailLimpo;
      }
      if (typeof notify === "boolean") {
        update.notify = notify;
      }
      const docRef = getFirestore().collection("bakalovers").doc(uid);
      await docRef.set(update, { merge: true });
      const updated = await docRef.get();
      res.setHeader("Set-Cookie", AUTH_COOKIE);
      res.json(updated.data());
    } catch (error) {
      res.status(401).json({
        error: error instanceof Error ? error.message : "Falha ao atualizar o perfil",
      });
    }
  });

  // Configurações de URLs do site (ajustáveis por variáveis de ambiente)
  app.get("/api/config", (_req, res) => {
    res.json({
      // Em dev, "voltar para o site" aponta para a fanpage estática (porta 8080)
      siteUrl:
        process.env.SITE_URL ||
        (process.env.NODE_ENV === "production" ? "/" : "http://localhost:8080/"),
      fanpageUrl: process.env.FANPAGE_URL || "/saida/",
      clientUrl: process.env.CLIENT_URL || (process.env.NODE_ENV === "production" ? "" : "http://localhost:3000"),
      twitchClientId: TWITCH_OAUTH_CLIENT_ID,
      twitchRedirectUri: process.env.TWITCH_OAUTH_REDIRECT_URI || "",
      firebase: {
        enabled: firebaseReady,
        apiKey: process.env.FIREBASE_API_KEY || "",
        authDomain: process.env.FIREBASE_AUTH_DOMAIN || "",
        projectId: FIREBASE_PROJECT_ID,
        appId: process.env.FIREBASE_APP_ID || "",
      },
    });
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
