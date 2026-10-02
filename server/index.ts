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

// Verifica a assinatura do webhook do Stripe (t=<ts>,v1=<hmac>) sem dependência externa
function verifyStripeSignature(rawBody: Buffer, sigHeader: string, secret: string): boolean {
  try {
    const parts = sigHeader.split(",").map((s) => s.trim());
    const ts = parts.find((s) => s.startsWith("t="))?.slice(2) || "";
    const v1 = parts.find((s) => s.startsWith("v1="))?.slice(3) || "";
    if (!ts || !v1) return false;
    const expected = crypto.createHmac("sha256", secret).update(`${ts}.${rawBody.toString("utf8")}`).digest();
    const received = Buffer.from(v1, "hex");
    return expected.length === received.length && crypto.timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}

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
  let email = "";
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
          data?: Array<{
            login?: string;
            display_name?: string;
            profile_image_url?: string;
            email?: string;
          }>;
        };
        const user = users.data?.[0];
        if (user) {
          displayName = user.display_name || displayName;
          profileImageUrl = user.profile_image_url || "";
          email = user.email || "";
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
    email,
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

// Normaliza o nome da pasta de saída para o ID do vídeo (ex.: 2871566138).
// Sem ID identificável no nome do arquivo, usa o nome sem extensão.
function folderNameForVideo(filePath: string): string {
  const videoId = extractVideoIdFromFilename(filePath);
  return videoId ? videoId : folderNameFromFile(filePath);
}

async function startServer() {
  const app = express();
  const server = createServer(app);

  // Webhook do Stripe: registrado ANTES do express.json() porque precisa do
  // corpo bruto para verificar a assinatura (STRIPE_WEBHOOK_SECRET).
  app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
    const sig = String(req.headers["stripe-signature"] || "");
    if (!secret) {
      res.status(503).json({ error: "Webhook do Stripe não configurado" });
      return;
    }
    if (!sig || !verifyStripeSignature(req.body as Buffer, sig, secret)) {
      res.status(401).json({ error: "Assinatura inválida" });
      return;
    }
    let event: any;
    try {
      event = JSON.parse((req.body as Buffer).toString("utf8"));
    } catch {
      res.status(400).json({ error: "Corpo inválido" });
      return;
    }

    // Pagamento concluído: registra o apoio no usuário (support_purchases),
    // que alimenta o consolidado público de /api/support/products.
    if (event.type === "checkout.session.completed") {
      try {
        const session = (event.data?.object ?? {}) as Record<string, any>;
        const metadata = session.metadata ?? {};
        const productId = typeof metadata.productId === "string" ? metadata.productId : "";
        const uid =
          typeof metadata.uid === "string"
            ? metadata.uid
            : typeof session.client_reference_id === "string"
              ? session.client_reference_id
              : "";
        if (!firebaseReady || !uid || !productId) {
          res.status(400).json({ error: "Metadados ausentes (uid/productId)" });
          return;
        }
        const products = await getSupportProducts();
        const product = products.find((p) => p.id === productId);
        if (!product) {
          res.status(400).json({ error: "Produto inválido" });
          return;
        }
        const stripeSessionId = typeof session.id === "string" ? session.id : "";
        const stripeCustomerId = typeof session.customer === "string" ? session.customer : "";
        const stripeSubscriptionId =
          typeof session.subscription === "string" ? session.subscription : "";
        const periodo = typeof metadata.periodo === "string" ? metadata.periodo : "";
        const anual = product.tipo === "mensal" && periodo === "anual" && !!product.precoAnual;
        const preco = anual ? (product.precoAnual as number) : product.preco;
        const nome = anual ? `${product.nome} (Anual)` : product.nome;
        const tipo =
          product.tipo === "vitalicio" ? "vitalicio" : anual ? "anual" : "mensal";
        // Mensais/anuais são únicos por usuário; Supremo (vitalício) pode repetir
        if (tipo !== "vitalicio") {
          const jaTem = await getFirestore()
            .collection("support_purchases")
            .where("uid", "==", uid)
            .where("productId", "==", product.id)
            .limit(1)
            .get();
          if (!jaTem.empty) {
            console.log(`[stripe] assinatura duplicada ignorada: ${nome} para ${uid}`);
            res.json({ received: true, duplicated: true });
            return;
          }
        }
        const existing = await getFirestore()
          .collection("support_purchases")
          .where("stripeSessionId", "==", stripeSessionId)
          .limit(1)
          .get();
        if (!existing.empty) {
          res.json({ received: true, duplicated: true });
          return;
        }
        await getFirestore().collection("support_purchases").add({
          uid,
          productId: product.id,
          nome,
          preco,
          tipo,
          emoji: product.emoji,
          stripeSessionId,
          stripeCustomerId,
          stripeSubscriptionId,
          status: "ativo",
          createdAt: FieldValue.serverTimestamp(),
        });
        console.log(`[stripe] apoio registrado: ${nome} para ${uid}`);
        await syncPublicSupportMirror(uid);
        res.json({ received: true });
        return;
      } catch (error) {
        console.warn("[stripe] falha ao processar webhook:", error);
        res.status(500).json({ error: "Falha ao processar o webhook" });
        return;
      }
    }

    // Assinatura cancelada no portal do Stripe: remove o apoio do Firestore.
    if (event.type === "customer.subscription.deleted") {
      try {
        const sub = (event.data?.object ?? {}) as Record<string, any>;
        const subId = typeof sub.id === "string" ? sub.id : "";
        if (!firebaseReady || !subId) {
          res.status(400).json({ error: "Subscription id ausente" });
          return;
        }
        const snap = await getFirestore()
          .collection("support_purchases")
          .where("stripeSubscriptionId", "==", subId)
          .limit(1)
          .get();
        if (snap.empty) {
          console.log(`[stripe] cancelamento sem apoio correspondente: ${subId}`);
          res.json({ received: true, notFound: true });
          return;
        }
        const purchaseData = snap.docs[0].data() as Record<string, any>;
        const uid = typeof purchaseData.uid === "string" ? purchaseData.uid : "";
        await snap.docs[0].ref.delete();
        if (uid) await syncPublicSupportMirror(uid);
        console.log(`[stripe] apoio removido após cancelamento: ${subId}`);
        res.json({ received: true });
        return;
      } catch (error) {
        console.warn("[stripe] falha ao processar cancelamento:", error);
        res.status(500).json({ error: "Falha ao processar o cancelamento" });
        return;
      }
    }

    // Assinatura pausada: marca o apoio como pausado (não remove — pode ser retomada).
    if (event.type === "customer.subscription.paused") {
      try {
        const sub = (event.data?.object ?? {}) as Record<string, any>;
        const subId = typeof sub.id === "string" ? sub.id : "";
        if (!firebaseReady || !subId) {
          res.status(400).json({ error: "Subscription id ausente" });
          return;
        }
        const snap = await getFirestore()
          .collection("support_purchases")
          .where("stripeSubscriptionId", "==", subId)
          .limit(1)
          .get();
        if (snap.empty) {
          console.log(`[stripe] pausa sem apoio correspondente: ${subId}`);
          res.json({ received: true, notFound: true });
          return;
        }
        await snap.docs[0].ref.update({ status: "pausado" });
        {
          const d = snap.docs[0].data() as Record<string, any>;
          if (typeof d.uid === "string") await syncPublicSupportMirror(d.uid);
        }
        console.log(`[stripe] apoio pausado: ${subId}`);
        res.json({ received: true });
        return;
      } catch (error) {
        console.warn("[stripe] falha ao processar pausa:", error);
        res.status(500).json({ error: "Falha ao processar a pausa" });
        return;
      }
    }

    // Assinatura retomada: volta o apoio para ativo.
    if (event.type === "customer.subscription.resumed") {
      try {
        const sub = (event.data?.object ?? {}) as Record<string, any>;
        const subId = typeof sub.id === "string" ? sub.id : "";
        if (!firebaseReady || !subId) {
          res.status(400).json({ error: "Subscription id ausente" });
          return;
        }
        const snap = await getFirestore()
          .collection("support_purchases")
          .where("stripeSubscriptionId", "==", subId)
          .limit(1)
          .get();
        if (snap.empty) {
          console.log(`[stripe] retomada sem apoio correspondente: ${subId}`);
          res.json({ received: true, notFound: true });
          return;
        }
        await snap.docs[0].ref.update({ status: "ativo" });
        {
          const d = snap.docs[0].data() as Record<string, any>;
          if (typeof d.uid === "string") await syncPublicSupportMirror(d.uid);
        }
        console.log(`[stripe] apoio retomado: ${subId}`);
        res.json({ received: true });
        return;
      } catch (error) {
        console.warn("[stripe] falha ao processar retomada:", error);
        res.status(500).json({ error: "Falha ao processar a retomada" });
        return;
      }
    }

    res.json({ received: true });
  });

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

      // Pasta de saída normalizada pelo ID do vídeo (ex.: saida/2871566138)
      const folderName = videoId;
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

      const videoId = extractVideoIdFromFilename(sourceVideo) || extractVideoId(job.url);
      pipeline.videoId = videoId ?? undefined;

      // Pasta de saída normalizada pelo ID do vídeo (ex.: saida/2871566138)
      const folderName = videoId ? videoId : folderNameForVideo(sourceVideo);
      const folder = path.join(SAIDA_DIR, folderName);
      fs.mkdirSync(folder, { recursive: true });
      pipeline.folder = folderName;

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
    bairro?: string,
    inicio?: string
  ) {
    const pipeline = job.pipeline!;
    const folderName = path.basename(folderPath);
    try {
      if (step === "local") {
        const localFile = path.join(folderPath, "local.json");
        const bairroLimpo = (bairro || "").trim();
        const inicioLimpo = (inicio || "").trim();
        if ((!local || local === "auto") && !bairroLimpo && !inicioLimpo) {
          fs.rmSync(localFile, { force: true });
        } else {
          let data: Record<string, unknown> = {};
          if (fs.existsSync(localFile)) {
            try {
              const loaded = JSON.parse(fs.readFileSync(localFile, "utf8"));
              if (loaded && typeof loaded === "object") data = loaded as Record<string, unknown>;
            } catch {
              data = {};
            }
          }
          if (local === "japao" || local === "sao-paulo") {
            data.pais = local === "japao" ? "japao" : "brasil";
            data.cidade = local === "japao" ? "toquio" : "sao-paulo";
            data.local = local;
          } else {
            delete data.pais;
            delete data.cidade;
            data.local = "auto";
          }
          if (bairroLimpo) data.bairro = bairroLimpo;
          else delete data.bairro;
          if (inicioLimpo) data.inicio = inicioLimpo;
          else delete data.inicio;
          fs.writeFileSync(localFile, JSON.stringify(data, null, 2), "utf8");
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
    const { filename, local, bairro, inicio } = (req.body ?? {}) as {
      filename?: string;
      local?: string;
      bairro?: string;
      inicio?: string;
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
      const folder = path.join(SAIDA_DIR, folderNameForVideo(target));
      const localFile = path.join(folder, "local.json");
      const bairroLimpo = (bairro || "").trim();
      const inicioLimpo = (inicio || "").trim();
      if (local === "auto" && !bairroLimpo && !inicioLimpo) {
        fs.rmSync(localFile, { force: true });
      } else {
        let data: Record<string, unknown> = {};
        if (fs.existsSync(localFile)) {
          try {
            const loaded = JSON.parse(fs.readFileSync(localFile, "utf8"));
            if (loaded && typeof loaded === "object") data = loaded as Record<string, unknown>;
          } catch {
            data = {};
          }
        }
        if (local === "auto") {
          delete data.pais;
          delete data.cidade;
          data.local = "auto";
        } else {
          data.pais = local === "japao" ? "japao" : "brasil";
          data.cidade = local === "japao" ? "toquio" : "sao-paulo";
          data.local = local;
        }
        if (bairroLimpo) data.bairro = bairroLimpo;
        else delete data.bairro;
        if (inicioLimpo) data.inicio = inicioLimpo;
        else delete data.inicio;
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(localFile, JSON.stringify(data, null, 2), "utf8");
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
        let inicio = "";
        if (has("local.json")) {
          try {
            const localData = JSON.parse(fs.readFileSync(path.join(folderPath, "local.json"), "utf8"));
            local = localData.local || localData.cidade || "auto";
            bairro = localData.bairro || "";
            inicio = typeof localData.inicio === "string" ? localData.inicio : "";
          } catch {
            // mantém "auto"
          }
        }

        // Nome do episódio: relatorio.json → metricas.title (título da live na Twitch)
        let title = "";
        if (has("relatorio.json")) {
          try {
            const relatorio = JSON.parse(
              fs.readFileSync(path.join(folderPath, "relatorio.json"), "utf8")
            );
            title =
              relatorio &&
              relatorio.metricas &&
              typeof relatorio.metricas.title === "string"
                ? relatorio.metricas.title
                : "";
          } catch {
            // sem título
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
          title,
          local,
          bairro,
          inicio,
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

  async function runGlobalReprepare(job: VodJob, skipCortes: boolean, skipMapa: boolean, skipAnalise: boolean) {
    const pipeline = job.pipeline!;
    let pendingOutput = "";
    const env: Record<string, string> = {};
    if (skipCortes) env.SKIP_CORTES = "1";
    if (skipMapa) env.SKIP_MAPA = "1";
    if (skipAnalise) env.SKIP_ANALISE = "1";
    let idx = 0;
    let total = 0;
    let current = "";
    let stage = "iniciando";
    try {
      await runScript(
        "scripts/repreparar_todos.sh",
        [],
        (chunk) => {
          const lines = (pendingOutput + chunk).split(/\r?\n/);
          pendingOutput = lines.pop() ?? "";
          for (const line of lines) {
            const m = line.match(/^==> Processando \((\d+)\/(\d+)\):\s*(.+)$/);
            if (m) {
              idx = Number(m[1]);
              total = Number(m[2]);
              current = m[3];
              stage = "análise (IA + relatório)";
            } else if (/==> Analisando:/.test(line)) {
              stage = "análise (IA + relatório)";
            } else if (/==> Cortando trechos virais/.test(line)) {
              stage = "cortando trechos virais (ffmpeg)";
            } else if (/==> Atualizando dashboard com os cortes gerados/.test(line)) {
              stage = "atualizando dashboard";
            } else if (/==> Cortes já existem/.test(line)) {
              stage = "cortes mantidos";
            } else if (/==> SKIP_CORTES=1/.test(line)) {
              stage = "pulando cortes virais";
            } else if (/==> SKIP_MAPA=1/.test(line)) {
              stage = "pulando mapas";
            } else if (/==> SKIP_ANALISE=1/.test(line)) {
              stage = "pulando análise (mantendo relatório/dashboard)";
            } else if (/==> \[pulando\]/.test(line)) {
              stage = "pulado (sem pré-requisitos)";
            } else if (/==> Atualizando índice geral/.test(line)) {
              stage = "atualizando índice do site";
            }
            if (current && idx >= 1 && total >= 1) {
              pipeline.stepLabel = `Repreparando ${idx}/${total}: ${current} — ${stage}`;
              job.percent = Math.min(99, Math.round((idx / total) * 100));
            }
          }
        },
        Object.keys(env).length ? env : undefined
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

    const { skipCortes, skipMapa, skipAnalise } = (req.body ?? {}) as {
      skipCortes?: boolean;
      skipMapa?: boolean;
      skipAnalise?: boolean;
    };

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
    void runGlobalReprepare(job, skipCortes === true, skipMapa === true, skipAnalise === true);
    res.status(202).json({ id: job.id, eligibleCount, skippedCount: folders.length - eligibleCount });
  });

  async function runGlobalReprocess(job: VodJob, step: string) {
    const pipeline = job.pipeline!;
    let pendingOutput = "";
    try {
      await runScript(
        "scripts/reprocessar_todos.sh",
        [step],
        (chunk) => {
          const lines = (pendingOutput + chunk).split(/\r?\n/);
          pendingOutput = lines.pop() ?? "";
          for (const line of lines) {
            const match = line.match(/==> Processando:\s*(.+)/);
            if (match) pipeline.stepLabel = `Reprocessando ${step} de ${match[1]}...`;
          }
        },
        undefined
      );
      pipeline.status = "done";
      pipeline.stepLabel = `Etapa "${step}" reprocessada em todos os episódios.`;
      pipeline.finishedAt = Date.now();
      job.status = "done";
      job.percent = 100;
    } catch (err) {
      pipeline.status = "error";
      pipeline.stepLabel = `Falha ao reprocessar a etapa "${step}" em lote.`;
      pipeline.error = err instanceof Error ? err.message : `Falha no reprocessamento de "${step}"`;
      pipeline.finishedAt = Date.now();
      job.status = "error";
      job.error = pipeline.error;
    }
  }

  app.post("/api/vod/reprocess-all", (req, res) => {
    if (Array.from(jobs.values()).some((job) => job.status === "running")) {
      res.status(409).json({ error: "Aguarde o processamento atual terminar antes de iniciar o lote." });
      return;
    }

    const { step } = (req.body ?? {}) as { step?: string };
    const validSteps = ["mapa", "cortes", "qualidade"];
    if (!step || !validSteps.includes(step)) {
      res.status(400).json({ error: `Etapa inválida. Use: ${validSteps.join(", ")}` });
      return;
    }

    const folders = fs.readdirSync(SAIDA_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    const hasVideo = (folderPath: string) =>
      ["video.mp4", "video.webm", "video.mov", "video.m4v"].some((f) => fs.existsSync(path.join(folderPath, f)));
    const eligible = folders.filter((entry) => {
      const folderPath = path.join(SAIDA_DIR, entry.name);
      if (step === "qualidade") return hasVideo(folderPath);
      return hasVideo(folderPath) && fs.existsSync(path.join(folderPath, "audio.srt"));
    });
    if (!eligible.length) {
      res.status(400).json({ error: `Nenhum episódio elegível para reprocessar a etapa "${step}" (vídeo + audio.srt).` });
      return;
    }

    const labels: Record<string, string> = {
      mapa: "mapas",
      cortes: "cortes virais",
      qualidade: "qualidades",
    };
    const job: VodJob = {
      id: crypto.randomUUID(),
      url: "",
      title: `Reprocessar ${labels[step]} de todos os episódios`,
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
        step: "reprocess_all",
        stepLabel: `Iniciando lote de "${step}" para ${eligible.length} episódio(s)...`,
        startedAt: Date.now(),
      },
    };
    jobs.set(job.id, job);
    void runGlobalReprocess(job, step);
    res.status(202).json({ id: job.id, eligibleCount: eligible.length, skippedCount: folders.length - eligible.length });
  });

  // Re-executa UMA etapa de um episódio já preparado.
  // step: analise | cortes | mapa | comentarios | transcricao | local
  app.post("/api/vod/prepare-folder", (req, res) => {
    const { folder, step, local, bairro, inicio } = (req.body ?? {}) as {
      folder?: string;
      step?: string;
      local?: string;
      bairro?: string;
      inicio?: string;
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

    runPreparedFolderStep(job, folderPath, step, local, bairro, inicio);

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
    apoios?: { emoji: string; nome: string }[];
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

  // Espelho público no Firestore: contém apenas nome e twitch (nada sensível).
  // O site pode ler essa coleção diretamente; e-mail/avisos ficam só no doc privado.
  async function writePublicMirror(uid: string, nome: string, twitch: string) {
    if (!firebaseReady) return;
    try {
      await getFirestore()
        .collection("bakalovers_public")
        .doc(uid)
        .set({ nome, ...(twitch ? { twitch } : {}) }, { merge: true });
    } catch (error) {
      console.warn("[bakalovers] falha ao gravar espelho público:", error);
    }
  }

  // Espelha no doc público os apoios ativos do usuário (emoji + nome de cada
  // assinatura) para o site exibir os ícones do que ele apoia.
  async function syncPublicSupportMirror(uid: string) {
    if (!firebaseReady) return;
    try {
      const snap = await getFirestore()
        .collection("support_purchases")
        .where("uid", "==", uid)
        .get();
      const apoios = snap.docs
        .map((doc) => {
          const d = doc.data() as Record<string, any>;
          if (typeof d.status === "string" && d.status !== "ativo") return null;
          const nome = typeof d.nome === "string" ? d.nome : "";
          const emoji = typeof d.emoji === "string" ? d.emoji : "";
          return nome ? { emoji, nome } : null;
        })
        .filter((a): a is { emoji: string; nome: string } => a !== null);
      await getFirestore()
        .collection("bakalovers_public")
        .doc(uid)
        .set({ apoios }, { merge: true });
    } catch (error) {
      console.warn("[bakalovers] falha ao gravar apoios no espelho público:", error);
    }
  }

  // Sincroniza os bakalovers do Firestore para .bakalovers.json — a fanpage
  // (saida/index.html) é gerada a partir desse arquivo pelo atualizar_index.py.
  async function syncBakaloversFromFirestore() {
    if (!firebaseReady) return;
    try {
      const [snap, pubSnap] = await Promise.all([
        getFirestore().collection("bakalovers").get(),
        getFirestore().collection("bakalovers_public").get(),
      ]);
      const pubApoios = new Map<string, { emoji: string; nome: string }[]>();
      pubSnap.docs.forEach((doc) => {
        const d = doc.data() as Record<string, any>;
        if (Array.isArray(d.apoios)) pubApoios.set(doc.id, d.apoios);
      });
      const fromFirestore: Bakalover[] = snap.docs.map((doc) => {
        const d = doc.data() as Record<string, any>;
        const createdAt =
          d.createdAt && typeof d.createdAt.toDate === "function"
            ? d.createdAt.toDate().toISOString()
            : typeof d.createdAt === "string"
              ? d.createdAt
              : new Date().toISOString();
        const email = typeof d.email === "string" ? d.email : "";
        const twitch = typeof d.twitch === "string" ? d.twitch : "";
        return {
          id: doc.id,
          nome: typeof d.nome === "string" ? d.nome : email || doc.id,
          apelido: twitch || (email ? email.split("@")[0] : doc.id.slice(0, 8)),
          twitch,
          email,
          apoios: pubApoios.get(doc.id) || [],
          official: d.status !== "rejeitado" && d.status !== "removido",
          createdAt,
        };
      });
      // espelha somente nome/twitch na coleção pública legível pelo site
      for (const f of fromFirestore) {
        void writePublicMirror(f.id, f.nome, f.twitch || "");
      }
      // mantém membros legados do .bakalovers.json que não existem no Firestore
      const legacy = loadBakalovers().filter(
        (b) =>
          !fromFirestore.some(
            (f) => f.email && b.email && f.email.toLowerCase() === b.email.toLowerCase()
          )
      );
      const merged = [...fromFirestore, ...legacy];
      saveBakalovers(merged);
      bakalovers.splice(0, bakalovers.length, ...merged);
      console.log(`[bakalovers] sincronizados do Firestore: ${fromFirestore.length}`);
    } catch (error) {
      console.warn("[bakalovers] falha ao sincronizar do Firestore:", error);
    }
  }

  if (firebaseReady) {
    void syncBakaloversFromFirestore();
    setInterval(() => void syncBakaloversFromFirestore(), 10 * 60 * 1000);
  }

  // Lista os bakalovers (apenas oficiais com ?official=true).
  // Privacidade: o site só pode ler o nome e o usuário da Twitch (se houver) —
  // e-mail, avisos e demais campos nunca são expostos publicamente.
  // Fonte: coleção pública bakalovers_public (nome/twitch) + status "oficial"
  // da coleção privada (lida somente pelo servidor via Admin SDK).
  app.get("/api/bakalovers", async (req, res) => {
    const officialOnly = req.query.official === "true";
    if (firebaseReady) {
      try {
        const [pubSnap, privSnap] = await Promise.all([
          getFirestore().collection("bakalovers_public").get(),
          getFirestore().collection("bakalovers").get(),
        ]);
        const oficial = new Set(
          privSnap.docs
            .filter((doc) => {
              const d = doc.data() as Record<string, any>;
              return d.status !== "rejeitado" && d.status !== "removido";
            })
            .map((doc) => doc.id)
        );
        let list = pubSnap.docs.map((doc) => {
          const d = doc.data() as Record<string, any>;
          return {
            id: doc.id,
            nome: typeof d.nome === "string" ? d.nome : doc.id,
            ...(typeof d.twitch === "string" && d.twitch ? { twitch: d.twitch } : {}),
            ...(Array.isArray(d.apoios) && d.apoios.length ? { apoios: d.apoios } : {}),
            official: oficial.has(doc.id),
          };
        });
        if (officialOnly) list = list.filter((b) => b.official);
        res.json(list);
        return;
      } catch (error) {
        console.warn("[bakalovers] falha ao ler do Firestore:", error);
      }
    }
    // Fallback: arquivo local .bakalovers.json (já sincronizado/sanitizado)
    const list = officialOnly ? bakalovers.filter((b) => b.official) : bakalovers;
    res.json(
      [...list]
        .sort((a, b) => {
          if (a.official !== b.official) return a.official ? -1 : 1;
          return b.createdAt.localeCompare(a.createdAt);
        })
        .map((b) => ({
          id: b.id,
          nome: b.nome,
          ...(b.twitch ? { twitch: b.twitch } : {}),
          ...(Array.isArray(b.apoios) && b.apoios.length ? { apoios: b.apoios } : {}),
          official: b.official,
        }))
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
      // espelha nome/twitch na coleção pública (leitura liberada no site)
      void writePublicMirror(uid, nomeLimpo, twitchLimpo);
      res.setHeader("Set-Cookie", AUTH_COOKIE);
      res.json({ ok: true, uid });
      void syncBakaloversFromFirestore();
    } catch (error) {
      res.status(401).json({
        error: error instanceof Error ? error.message : "Falha ao registrar no Firebase",
      });
    }
  });

  // Resolve a identidade autenticada: Google (ID token do Firebase) ou
  // Twitch (access token validado na própria Twitch, fora do Firebase Auth).
  async function resolveProfileIdentity(req: express.Request): Promise<{
    uid: string;
    provider: string;
    login?: string;
    displayName?: string;
    email?: string;
    profileImageUrl?: string;
    userId?: string;
  }> {
    const authHeader = String(req.headers.authorization || "");
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const queryToken = typeof req.query.twitchAccessToken === "string" ? req.query.twitchAccessToken : "";
    const { twitchAccessToken: bodyToken } = (req.body ?? {}) as { twitchAccessToken?: string };
    const twitchAccessToken = bodyToken || queryToken;
    if (twitchAccessToken) {
      const twitchUser = await fetchTwitchUser(twitchAccessToken);
      return {
        uid: `twitch:${twitchUser.login.toLowerCase()}`,
        provider: "twitch",
        login: twitchUser.login,
        displayName: twitchUser.displayName,
        email: twitchUser.email,
        profileImageUrl: twitchUser.profileImageUrl,
        userId: twitchUser.userId,
      };
    }
    if (idToken) {
      const decoded = await getAuth().verifyIdToken(idToken);
      return {
        uid: decoded.uid,
        provider: decoded.firebase.sign_in_provider || "unknown",
        displayName: typeof decoded.name === "string" ? decoded.name : "",
        email: typeof decoded.email === "string" ? decoded.email : "",
        profileImageUrl: typeof decoded.picture === "string" ? decoded.picture : "",
      };
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
      const identity = await resolveProfileIdentity(req);
      const { uid } = identity;
      const doc = await getFirestore().collection("bakalovers").doc(uid).get();
      if (!doc.exists) {
        // Auto-cadastro: cria o perfil na hora com os dados da identidade
        // (login Twitch ou nome/e-mail do Google) em vez de devolver 404.
        const login = typeof identity.login === "string" ? identity.login : "";
        const nome =
          (typeof identity.displayName === "string" && identity.displayName) ||
          login ||
          (uid.startsWith("twitch:") ? uid.slice(7) : "Bakalover");
        const email = typeof identity.email === "string" ? identity.email : "";
        const twitchUserId = typeof identity.userId === "string" ? identity.userId : "";
        const twitchProfileImage =
          typeof identity.profileImageUrl === "string" ? identity.profileImageUrl : "";
        const now = FieldValue.serverTimestamp();
        await getFirestore()
          .collection("bakalovers")
          .doc(uid)
          .set({
            uid,
            nome,
            email,
            twitch: login,
            twitchUserId,
            twitchProfileImage,
            notify: true,
            provider: identity.provider,
            status: "aprovado",
            updatedAt: now,
            createdAt: now,
          });
        void writePublicMirror(uid, nome, login);
        res.setHeader("Set-Cookie", AUTH_COOKIE);
        res.json({
          uid,
          nome,
          email,
          twitch: login,
          twitchUserId,
          twitchProfileImage,
          notify: true,
          provider: identity.provider,
          status: "aprovado",
        });
        return;
      }
      // Perfil existe: refresca campos de identidade que vierem vazios
      // (e-mail, avatar e userId da Twitch) sem sobrescrever o que o usuário editou.
      const data = (doc.data() ?? {}) as Record<string, any>;
      const patch: Record<string, unknown> = {};
      if (identity.email && !data.email) patch.email = identity.email;
      if (identity.profileImageUrl && !data.twitchProfileImage) {
        patch.twitchProfileImage = identity.profileImageUrl;
      }
      if (identity.userId && !data.twitchUserId) patch.twitchUserId = identity.userId;
      if (Object.keys(patch).length) {
        patch.updatedAt = FieldValue.serverTimestamp();
        await getFirestore().collection("bakalovers").doc(uid).set(patch, { merge: true });
      }
      res.setHeader("Set-Cookie", AUTH_COOKIE);
      res.json({ ...data, ...patch, updatedAt: undefined });
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
      const data = updated.data() as Record<string, any>;
      if (data) {
        void writePublicMirror(
          uid,
          typeof data.nome === "string" ? data.nome : "",
          typeof data.twitch === "string" ? data.twitch : ""
        );
      }
      res.setHeader("Set-Cookie", AUTH_COOKIE);
      res.json(updated.data());
    } catch (error) {
      res.status(401).json({
        error: error instanceof Error ? error.message : "Falha ao atualizar o perfil",
      });
    }
  });

  // ===== Apoio (produtos virtuais inspirados nas lives) =====
  interface SupportProduct {
    id: string;
    nome: string;
    preco: number; // em R$
    precoAnual?: number; // preço anual (12x) para produtos mensais
    tipo: "mensal" | "vitalicio";
    emoji: string;
    desc: string;
  }

  // Valores padrão usados APENAS para semear o Firestore na primeira execução
  // (a fonte de verdade é a coleção support_products no Firestore).
  const DEFAULT_SUPPORT_PRODUCTS: SupportProduct[] = [
    {
      id: "calcinha",
      nome: "Calcinha no Prédio",
      preco: 2,
      precoAnual: 24,
      tipo: "mensal",
      emoji: "🩲",
      desc: "1 mês de apoio e a calcinha continua no prédio.",
    },
    {
      id: "sexo2",
      nome: "Atualização Sexo 2",
      preco: 5,
      precoAnual: 60,
      tipo: "mensal",
      emoji: "🔥",
      desc: "1 mês de apoio com a atualização que o chat mais gosta.",
    },
    {
      id: "punhetaco",
      nome: "Punhetaço",
      preco: 10,
      precoAnual: 120,
      tipo: "mensal",
      emoji: "✊",
      desc: "1 mês de apoio no nível Punhetaço todos oss dias as 00h.",
    },
    {
      id: "supremo",
      nome: "Bakalover Supremo",
      preco: 100,
      tipo: "vitalicio",
      emoji: "👑",
      desc: "Apoio vitalício único",
    },
  ];

  // Lê os produtos do Firestore (semeia com os padrões na primeira vez).
  // O retorno é anotado como SupportProduct para o tipo de `tipo` não alargar para string.
  async function getSupportProducts(): Promise<SupportProduct[]> {
    if (!firebaseReady) return DEFAULT_SUPPORT_PRODUCTS;
    try {
      const snap = await getFirestore().collection("support_products").get();
      if (!snap.empty) {
        return snap.docs
          .map((doc): SupportProduct => {
            const d = doc.data() as Record<string, any>;
            return {
              id: typeof d.id === "string" ? d.id : doc.id,
              nome: typeof d.nome === "string" ? d.nome : doc.id,
              preco: typeof d.preco === "number" ? d.preco : 0,
              precoAnual: typeof d.precoAnual === "number" ? d.precoAnual : undefined,
              tipo: (d.tipo === "vitalicio" ? "vitalicio" : "mensal") as SupportProduct["tipo"],
              emoji: typeof d.emoji === "string" ? d.emoji : "",
              desc: typeof d.desc === "string" ? d.desc : "",
            };
          })
          .filter((p) => p.id && p.nome);
      }
      // primeira execução: semeia os produtos padrão no Firestore
      const batch = getFirestore().batch();
      for (const p of DEFAULT_SUPPORT_PRODUCTS) {
        batch.set(getFirestore().collection("support_products").doc(p.id), { ...p });
      }
      await batch.commit();
      console.log("[apoio] produtos semeados no Firestore");
      return DEFAULT_SUPPORT_PRODUCTS;
    } catch (error) {
      console.warn("[apoio] falha ao ler produtos do Firestore:", error);
      return DEFAULT_SUPPORT_PRODUCTS;
    }
  }

  // Catálogo público + consolidado: produtos (Firestore) e contagem de compras.
  app.get("/api/support/products", async (_req, res) => {
    try {
      const [products, purchSnap] = await Promise.all([
        getSupportProducts(),
        firebaseReady
          ? getFirestore().collection("support_purchases").get()
          : Promise.resolve(null),
      ]);
      const counts: Record<string, number> = {};
      let totalRaised = 0;
      if (purchSnap) {
        purchSnap.docs.forEach((doc) => {
          const d = doc.data() as Record<string, any>;
          const pid = typeof d.productId === "string" ? d.productId : "";
          if (pid) counts[pid] = (counts[pid] || 0) + 1;
          totalRaised += typeof d.preco === "number" ? d.preco : 0;
        });
      }
      res.json({
        products: products.map((p) => ({
          ...p,
          compras: counts[p.id] || 0,
        })),
        totalRaised,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Falha ao carregar os produtos",
      });
    }
  });

  // Cria uma sessão de checkout no Stripe para o produto (usuário logado).
  // O webhook /api/stripe/webhook registra a compra quando o pagamento concluir.
  app.post("/api/support/checkout", async (req, res) => {
    const secretKey = process.env.STRIPE_SECRET_KEY || "";
    if (!secretKey) {
      res.status(503).json({ error: "Stripe não configurado no servidor" });
      return;
    }
    try {
      const { uid } = await resolveProfileIdentity(req);
      const { productId, periodo } = (req.body ?? {}) as { productId?: string; periodo?: string };
      const products = await getSupportProducts();
      const product = products.find((p) => p.id === productId);
      if (!product) {
        res.status(400).json({ error: "Produto inválido" });
        return;
      }
      // Apoiar é exclusivo de Bakalovers cadastrados (evita checkout automático
      // para quem só fez login na Twitch mas ainda não confirmou o cadastro).
      const profileDoc = await getFirestore().collection("bakalovers").doc(uid).get();
      if (!profileDoc.exists) {
        res.status(403).json({ error: "Complete seu cadastro para virar Bakalover antes de apoiar." });
        return;
      }
      // Mensais são únicos por usuário (Supremo pode repetir)
      if (product.tipo === "mensal") {
        const existing = await getFirestore()
          .collection("support_purchases")
          .where("uid", "==", uid)
          .where("productId", "==", product.id)
          .limit(1)
          .get();
        if (!existing.empty) {
          res.status(409).json({ error: `Você já tem "${product.nome}" — cada apoio mensal é único.` });
          return;
        }
      }
      const vitalicio = product.tipo === "vitalicio";
      const anual = !vitalicio && periodo === "anual" && !!product.precoAnual;
      const preco = vitalicio ? product.preco : anual ? (product.precoAnual as number) : product.preco;
      const nome = vitalicio ? product.nome : anual ? `${product.nome} (Anual)` : product.nome;
      // Price IDs do Stripe por produto/período:
      //   STRIPE_PRICE_<ID>_<MENSAL|ANUAL|VITALICIO>
      // Vitalício (Supremo) também aceita price fixo (STRIPE_PRICE_SUPREMO_VITALICIO);
      // sem price id configurado, cai no price_data dinâmico.
      const idUpper = product.id.toUpperCase();
      const priceId = vitalicio
        ? process.env[`STRIPE_PRICE_${idUpper}_VITALICIO`] || ""
        : process.env[`STRIPE_PRICE_${idUpper}_${anual ? "ANUAL" : "MENSAL"}`] || "";
      const clientUrl = process.env.CLIENT_URL || "http://localhost:3000";
      // Mensais/anuais viram assinaturas no Stripe (modo subscription) para
      // poderem ser canceladas pelo portal de gerenciamento do cliente.
      const profileData = (profileDoc.data() ?? {}) as Record<string, any>;
      const customerEmail = typeof profileData.email === "string" ? profileData.email : "";
      const params = new URLSearchParams({
        "line_items[0][quantity]": "1",
        mode: vitalicio ? "payment" : "subscription",
        client_reference_id: uid,
        "metadata[productId]": product.id,
        "metadata[uid]": uid,
        "metadata[periodo]": vitalicio ? "vitalicio" : anual ? "anual" : "mensal",
        success_url: `${clientUrl}/perfil?apoio=ok`,
        cancel_url: `${clientUrl}/perfil`,
      });
      if (!vitalicio) {
        if (customerEmail) params.set("customer_email", customerEmail);
      }
      if (priceId) {
        params.set("line_items[0][price]", priceId);
      } else {
        params.set("line_items[0][price_data][currency]", "brl");
        params.set("line_items[0][price_data][product_data][name]", nome);
        params.set("line_items[0][price_data][unit_amount]", String(Math.round(preco * 100)));
        if (!vitalicio) {
          params.set("line_items[0][price_data][recurring][interval]", anual ? "year" : "month");
        }
      }
      const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: { Authorization: `Bearer ${secretKey}` },
        body: params,
      });
      const data = (await stripeRes.json()) as any;
      if (!stripeRes.ok) {
        throw new Error(data?.error?.message || `Stripe respondeu ${stripeRes.status}`);
      }
      res.json({ url: typeof data.url === "string" ? data.url : "" });
    } catch (error) {
      res.status(401).json({
        error: error instanceof Error ? error.message : "Falha ao criar o checkout",
      });
    }
  });

  // Registra a compra de um produto de apoio (Google ou Twitch)
  app.post("/api/support/purchase", async (req, res) => {
    if (!firebaseReady) {
      res.status(503).json({ error: "Firebase não configurado no servidor" });
      return;
    }
    try {
      const { uid } = await resolveProfileIdentity(req);
      const { productId, periodo } = (req.body ?? {}) as { productId?: string; periodo?: string };
      const products = await getSupportProducts();
      const product = products.find((p) => p.id === productId);
      if (!product) {
        res.status(400).json({ error: "Produto inválido" });
        return;
      }
      let tipo: "mensal" | "anual" | "vitalicio";
      let preco: number;
      let nome: string;
      if (product.tipo === "vitalicio") {
        tipo = "vitalicio";
        preco = product.preco;
        nome = product.nome;
      } else if (periodo === "anual" && product.precoAnual) {
        tipo = "anual";
        preco = product.precoAnual;
        nome = `${product.nome} (Anual)`;
      } else {
        tipo = "mensal";
        preco = product.preco;
        nome = product.nome;
      }
      // Mensais/anuais: apenas UMA assinatura por produto por usuário.
      // Supremo (vitalício): pode ser comprado quantas vezes quiser.
      if (tipo !== "vitalicio") {
        const existing = await getFirestore()
          .collection("support_purchases")
          .where("uid", "==", uid)
          .where("productId", "==", product.id)
          .limit(1)
          .get();
        if (!existing.empty) {
          res.status(409).json({ error: `Você já tem "${product.nome}" — cada assinatura é única.` });
          return;
        }
      }
      const purchase = {
        uid,
        productId: product.id,
        nome,
        preco,
        tipo,
        emoji: product.emoji,
        createdAt: FieldValue.serverTimestamp(),
      };
      const ref = await getFirestore().collection("support_purchases").add(purchase);
      await syncPublicSupportMirror(uid);
      res.status(201).json({ id: ref.id, ...purchase, createdAt: new Date().toISOString() });
    } catch (error) {
      res.status(401).json({
        error: error instanceof Error ? error.message : "Falha ao registrar o apoio",
      });
    }
  });

  // Histórico de apoios do usuário + total já ajudado
  app.get("/api/support/purchases", async (req, res) => {
    if (!firebaseReady) {
      res.status(503).json({ error: "Firebase não configurado no servidor" });
      return;
    }
    try {
      const { uid } = await resolveProfileIdentity(req);
      const snap = await getFirestore()
        .collection("support_purchases")
        .where("uid", "==", uid)
        .get();
      const purchases = snap.docs
        .map((doc) => {
          const d = doc.data() as Record<string, any>;
          const createdAt =
            d.createdAt && typeof d.createdAt.toDate === "function"
              ? d.createdAt.toDate().toISOString()
              : typeof d.createdAt === "string"
                ? d.createdAt
                : "";
          return {
            id: doc.id,
            productId: typeof d.productId === "string" ? d.productId : "",
            nome: typeof d.nome === "string" ? d.nome : "",
            preco: typeof d.preco === "number" ? d.preco : 0,
            tipo: typeof d.tipo === "string" ? d.tipo : "",
            emoji: typeof d.emoji === "string" ? d.emoji : "",
            status: typeof d.status === "string" ? d.status : "",
            createdAt,
          };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const total = purchases.reduce((sum, p) => sum + p.preco, 0);
      res.json({ purchases, total });
    } catch (error) {
      res.status(401).json({
        error: error instanceof Error ? error.message : "Falha ao carregar os apoios",
      });
    }
  });

  // Abre o portal de gerenciamento do Stripe para o usuário cancelar um apoio.
  // A remoção do Firestore acontece no webhook customer.subscription.deleted.
  app.post("/api/support/portal", async (req, res) => {
    const secretKey = process.env.STRIPE_SECRET_KEY || "";
    if (!secretKey) {
      res.status(503).json({ error: "Stripe não configurado no servidor" });
      return;
    }
    try {
      const { uid } = await resolveProfileIdentity(req);
      const { purchaseId } = (req.body ?? {}) as { purchaseId?: string };
      if (!purchaseId) {
        res.status(400).json({ error: "Apoio inválido" });
        return;
      }
      const purchaseDoc = await getFirestore()
        .collection("support_purchases")
        .doc(purchaseId)
        .get();
      if (!purchaseDoc.exists) {
        res.status(404).json({ error: "Apoio não encontrado" });
        return;
      }
      const d = purchaseDoc.data() as Record<string, any>;
      if (d.uid !== uid) {
        res.status(403).json({ error: "Este apoio não pertence a você" });
        return;
      }
      if (d.tipo === "vitalicio") {
        res.status(400).json({ error: "O apoio vitalício é único e não tem cancelamento pelo portal." });
        return;
      }
      const customerId = typeof d.stripeCustomerId === "string" ? d.stripeCustomerId : "";
      if (!customerId) {
        res.status(400).json({
          error: "Este apoio não tem cliente Stripe vinculado. Fale com o suporte para cancelar.",
        });
        return;
      }
      const clientUrl = process.env.CLIENT_URL || "http://localhost:3000";
      const params = new URLSearchParams({
        customer: customerId,
        return_url: `${clientUrl}/perfil`,
      });
      const portalConfig = process.env.STRIPE_PORTAL_CONFIGURATION || "";
      if (portalConfig) params.set("configuration", portalConfig);
      const stripeRes = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
        method: "POST",
        headers: { Authorization: `Bearer ${secretKey}` },
        body: params,
      });
      const data = (await stripeRes.json()) as any;
      if (!stripeRes.ok) {
        throw new Error(data?.error?.message || `Stripe respondeu ${stripeRes.status}`);
      }
      res.json({ url: typeof data.url === "string" ? data.url : "" });
    } catch (error) {
      res.status(401).json({
        error: error instanceof Error ? error.message : "Falha ao abrir o portal do Stripe",
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
