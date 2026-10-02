// Cloud Function "api" — API de produção dos Bakalovers (Firebase Functions 2ª geração).
// Exposta em <site>/api/** via rewrite do Firebase Hosting (firebase.json).
//
// O downloader de VODs e o pipeline de análise continuam rodando no servidor
// local (server/index.ts) — aqui só entram os endpoints leves de produção:
// auth, perfil, apoio (Stripe), bakalovers públicos e config.

import crypto from "crypto";
import express from "express";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { defineString } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";

if (getApps().length === 0) {
  initializeApp(); // credenciais automáticas do ambiente Cloud Functions (ADC)
}

// ===== Variáveis de ambiente =====
// ./deploy-firebase.sh --secrets envia o .env para o Secret Manager. Cada chave
// declarada aqui é injetada no ambiente da function a partir do secret de mesmo
// nome (defineString resolve de Secret Manager quando o secret existe).
const ENV_KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PORTAL_CONFIGURATION",
  "TWITCH_OAUTH_CLIENT_ID",
  "TWITCH_OAUTH_REDIRECT_URI",
  "SITE_URL",
  "FANPAGE_URL",
  "CLIENT_URL",
  "CLIENT_FIREBASE_PROJECT_ID",
  "CLIENT_FIREBASE_API_KEY",
  "CLIENT_FIREBASE_AUTH_DOMAIN",
  "CLIENT_FIREBASE_APP_ID",
  "STRIPE_PRICE_CALCINHA_MENSAL",
  "STRIPE_PRICE_CALCINHA_ANUAL",
  "STRIPE_PRICE_SEXO2_MENSAL",
  "STRIPE_PRICE_SEXO2_ANUAL",
  "STRIPE_PRICE_PUNHETACO_MENSAL",
  "STRIPE_PRICE_PUNHETACO_ANUAL",
  "STRIPE_PRICE_SUPREMO_VITALICIO",
];

const PARAMS: Record<string, ReturnType<typeof defineString>> = {};
for (const key of ENV_KEYS) {
  PARAMS[key] = defineString(key, { default: "" });
}
// .value() é chamado apenas em tempo de execução (dentro dos handlers) — evita
// leitura prematura quando a CLI carrega o módulo para montar o manifest.
function env(key: string): string {
  return PARAMS[key]?.value() ?? "";
}

const AUTH_COOKIE = "bakalover_auth=1; Path=/; Max-Age=31536000; SameSite=Lax";
const firebaseReady = getApps().length > 0;

const TWITCH_GQL_URL = "https://gql.twitch.tv/gql";
const TWITCH_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const TWITCH_OAUTH_VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";
const TWITCH_HELIX_USERS_URL = "https://api.twitch.tv/helix/users";

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
  const twitchOauthClientId = env("TWITCH_OAUTH_CLIENT_ID");
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
  if (twitchOauthClientId && identity.client_id && identity.client_id !== twitchOauthClientId) {
    throw new Error("Token emitido para outra aplicação Twitch");
  }

  let displayName = identity.login;
  let profileImageUrl = "";
  let email = "";
  if (twitchOauthClientId) {
    try {
      const usersRes = await fetch(TWITCH_HELIX_USERS_URL, {
        headers: {
          "Client-Id": twitchOauthClientId,
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
async function getSupportProducts(): Promise<SupportProduct[]> {
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

// Espelho público no Firestore: contém apenas nome e twitch (nada sensível).
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

function createApp() {
  const app = express();

  // Webhook do Stripe: registrado ANTES do express.json() porque precisa do
  // corpo bruto para verificar a assinatura (STRIPE_WEBHOOK_SECRET).
  app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    const secret = env("STRIPE_WEBHOOK_SECRET");
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

  // Obtém o usuário da Twitch dono de um user access token (fluxo implícito).
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

  // Registra o perfil do usuário no Firestore (Admin SDK, server-side).
  //  - Google: Authorization: Bearer <ID token do Firebase>, verificado aqui.
  //  - Twitch: twitchAccessToken no body, validado direto na Twitch.
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

  // Lista os bakalovers (apenas oficiais com ?official=true).
  // Fonte: coleção pública bakalovers_public (nome/twitch) + status da coleção
  // privada (lida somente aqui via Admin SDK). E-mail nunca é exposto.
  app.get("/api/bakalovers", async (req, res) => {
    const officialOnly = req.query.official === "true";
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
    } catch (error) {
      console.warn("[bakalovers] falha ao ler do Firestore:", error);
      res.status(500).json({ error: "Falha ao carregar os bakalovers" });
    }
  });

  // Catálogo público + consolidado: produtos (Firestore) e contagem de compras.
  app.get("/api/support/products", async (_req, res) => {
    try {
      const [products, purchSnap] = await Promise.all([
        getSupportProducts(),
        getFirestore().collection("support_purchases").get(),
      ]);
      const counts: Record<string, number> = {};
      let totalRaised = 0;
      purchSnap.docs.forEach((doc) => {
        const d = doc.data() as Record<string, any>;
        const pid = typeof d.productId === "string" ? d.productId : "";
        if (pid) counts[pid] = (counts[pid] || 0) + 1;
        totalRaised += typeof d.preco === "number" ? d.preco : 0;
      });
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
    const secretKey = env("STRIPE_SECRET_KEY");
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
      // Price IDs do Stripe por produto/período (STRIPE_PRICE_<ID>_<MENSAL|ANUAL>).
      // Vitalício (Supremo) também aceita price fixo (STRIPE_PRICE_SUPREMO_VITALICIO);
      // sem price id configurado, cai no price_data dinâmico.
      const idUpper = product.id.toUpperCase();
      const priceId = vitalicio
        ? env(`STRIPE_PRICE_${idUpper}_VITALICIO`)
        : env(`STRIPE_PRICE_${idUpper}_${anual ? "ANUAL" : "MENSAL"}`);
      const clientUrl = env("CLIENT_URL") || "";
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

  // Registra a compra de um produto de apoio (usado apenas em teste local/legado)
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
    const secretKey = env("STRIPE_SECRET_KEY");
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
      const clientUrl = env("CLIENT_URL") || "";
      const params = new URLSearchParams({
        customer: customerId,
        return_url: `${clientUrl}/perfil`,
      });
      const portalConfig = env("STRIPE_PORTAL_CONFIGURATION");
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

  // Configurações de URLs do site (ajustáveis via Secret Manager)
  app.get("/api/config", (_req, res) => {
    res.json({
      // Em produção (functions), "voltar para o site" aponta para a raiz do Hosting
      siteUrl: env("SITE_URL") || "/",
      fanpageUrl: env("FANPAGE_URL") || "/saida/",
      clientUrl: env("CLIENT_URL"),
      twitchClientId: env("TWITCH_OAUTH_CLIENT_ID"),
      twitchRedirectUri: env("TWITCH_OAUTH_REDIRECT_URI"),
      firebase: {
        enabled: firebaseReady,
        apiKey: env("CLIENT_FIREBASE_API_KEY"),
        authDomain: env("CLIENT_FIREBASE_AUTH_DOMAIN"),
        // Em produção o GCLOUD_PROJECT é injetado pelo ambiente; a env
        // CLIENT_FIREBASE_PROJECT_ID existe como override explícito.
        projectId: env("CLIENT_FIREBASE_PROJECT_ID") || process.env.GCLOUD_PROJECT || "",
        appId: env("CLIENT_FIREBASE_APP_ID"),
      },
    });
  });

  // Qualquer outra rota /api/* cai aqui (o Hosting cuida do resto)
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Rota não encontrada" });
  });

  return app;
}

const app = createApp();

// Expondo a function "api": o rewrite do Hosting manda /api/** para cá.
export const api = onRequest({ region: "us-central1", timeoutSeconds: 120 }, app);

// redeploy: força novas instâncias lerem a versão atual do secret TWITCH_OAUTH_REDIRECT_URI
