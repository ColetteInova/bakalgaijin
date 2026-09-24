#!/usr/bin/env python3
"""preparar.py — Gera a análise completa de um VOD a partir da pasta em saida/.

Entradas (na pasta):
  - comentarios.json  -> {"videoId": ..., "title": ..., "comments": [{id, offset, login, displayName, text}]}
  - audio.srt         -> transcrição (timestamps)
  - video.mp4         -> opcional, só para nomear o vídeo

Saídas (na mesma pasta):
  - relatorio.json     -> "banco de dados" com métricas, sentimentos, temas, resumo e insights
  - relatorio.md       -> relatório em Markdown
  - relatorio.csv      -> comentários classificados
  - dashboard.html     -> dashboard interativo (lê relatorio.json e exibe toda a análise)

Uso:
  .venv-ia/bin/python scripts/preparar.py saida/<nome-da-pasta>
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import statistics
import subprocess
import sys
import urllib.request
from collections import Counter
from pathlib import Path

# --------------------------------------------------------------------------- #
# Configuração
# --------------------------------------------------------------------------- #

TWITCH_GQL_URL = "https://gql.twitch.tv/gql"
TWITCH_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"

# DeepSeek (API OpenAI-compatível) — usado para nomear/geolocalizar os marcos do mapa.
# Chave via env var DEEPSEEK_API_KEY (sem chave => fallback determinístico em Shinjuku).
DEEPSEEK_API_URL = os.environ.get("DEEPSEEK_API_URL", "https://api.deepseek.com/chat/completions")
DEEPSEEK_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")
DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")


def _deepseek_chat(messages: list[dict], max_tokens: int = 2000) -> str | None:
    """Chama a API DeepSeek (formato OpenAI). Retorna o texto ou None em erro."""
    if not DEEPSEEK_API_KEY:
        return None
    body = json.dumps(
        {
            "model": DEEPSEEK_MODEL,
            "messages": messages,
            "temperature": 0.3,
            "max_tokens": max_tokens,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        DEEPSEEK_API_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data["choices"][0]["message"]["content"]
    except Exception as exc:  # noqa: BLE001
        print(f"  [!] DeepSeek indisponível ({exc}) — usando rota aproximada.", file=sys.stderr)
        return None

# Categorias de sentimento (classificação determinística + LLM opcional)
SENTIMENT_CATEGORIES = [
    "positivo",
    "neutro",
    "neutro/pergunta",
    "negativo",
    "engraçado",
    "frustrado",
    "inspirado",
    "confuso",
]

# Palavras de referência para a classificação heurística
LEXICON = {
    "positivo": [
        "top", "bom", "boa", "amo", "amei", "gostei", "gosto", "adorei",
        "melhor", "perfeito", "incrivel", "incrível", "maravilhoso", "lindo",
        "genial", "brabo", "braba", "pika", "foda", "goat", "orgulho",
        "obrigado", "vlw", "valeu", "salve", "♥", "❤", "cheer",
    ],
    "engraçado": [
        "kkk", "haha", "rsrs", "lol", "lul", "kkkk", "racho", "ri",
        "piada", "zuera", "zoeira", "meme", "wtf", "kapp",
    ],
    "frustrado": [
        "raiva", "odeio", "aff", "pqp", "puta", "merda", "bosta", "desisto",
        "cansado", "cansado", "triste", "horrivel", "horrível", "tanko",
    ],
    "negativo": [
        "ruim", "péssimo", "pessimo", "chato", "feio", "lixo", "flop",
        "decepcion", "tava ruim", "não gostei", "nao gostei",
    ],
    "inspirado": [
        "inspir", "motiv", "aprend", "ajudou", "obrigado por", "faz live",
        "continua", "vai fundo", "sucesso", "orgulho de",
    ],
    "confuso": [
        "?", "??", "ué", "uai", "como assim", "nao entendi", "não entendi",
        "oxi", "que isso", "o que", "oq", "sera", "será", "q isso",
    ],
}

STOPWORDS = {
    "a", "o", "e", "é", "de", "da", "do", "que", "em", "um", "uma", "para",
    "pra", "pro", "com", "não", "nao", "se", "por", "os", "as", "ao", "aos",
    "eu", "vc", "voce", "você", "ele", "ela", "eles", "elas", "to", "tô",
    "ta", "tá", "ja", "já", "mais", "mas", "muito", "muita", "me", "te", "no",
    "na", "nos", "nas", "foi", "ser", "ter", "tem", "tava", "so", "só", "ai",
    "aí", "la", "lá", "ou", "isso", "aquilo", "tb", "tbm", "ne", "né", "viu",
    "tipo", "assim", "mesmo", "msm", "entao", "então", "ainda", "também",
    "tambem", "agora", "hoje", "hj", "aqui", "ai", "esse", "essa", "este",
    "esta", "meu", "minha", "seu", "sua", "the", "of", "and", "is", "it",
    "this", "that", "you", "for", "are", "was", "were", "with", "watched",
    "streams", "streak", "sparked", "consecutive", "subscribed", "months",
    "month", "prime", "tier", "they", "currently", "they've", "their",
}


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def gql_post(query: str, variables: dict | None = None) -> dict:
    body = json.dumps({"query": query, "variables": variables or {}}).encode("utf-8")
    req = urllib.request.Request(
        TWITCH_GQL_URL,
        data=body,
        headers={"Client-Id": TWITCH_CLIENT_ID, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        return {"_error": str(exc)}




def _fetch_usd_brl() -> float:
    """Busca a cotação USD -> BRL. Fallback: R$ 5,00 por dólar.

    Usa open.er-api.com (gratuita, sem chave) porque a API Ninjas retorna
    "premium subscribers only" para USD/BRL.
    """
    try:
        url = "https://open.er-api.com/v6/latest/USD"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        rate = data.get("rates", {}).get("BRL")
        if isinstance(rate, (int, float)) and rate > 0:
            return round(float(rate), 4)
    except Exception:  # noqa: BLE001
        pass
    return 5.0


def fmt_ts(seconds: float) -> str:
    seconds = int(seconds)
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


# --------------------------------------------------------------------------- #
# Links de apoio ao Baka Gaijin (com fallback fixo + tentativa de scrape)
# --------------------------------------------------------------------------- #

SUPPORT_LINKS = [
    {
        "id": "lolja",
        "emoji": "👕",
        "titulo": "Loja Oficial — Lolja",
        "url": "https://www.lolja.com.br/baka-gaijin",
        "desc": "Camisetas, moletons, oversized e blusões oficiais do Baka Gaijin.",
        "img": "https://cdn.vnda.com.br/991x/lolja/2026/09/22/modelo-categoria-novo-12091400.jpg?v=1790103039",
        "cta": "Comprar merch",
    },
    {
        "id": "amazon",
        "emoji": "📖",
        "titulo": 'Livro "Mihail" — Amazon',
        "url": "https://a.co/d/4AxF7mK",
        "desc": "Romance cyberpunk de Eduardo Baka: o repórter Vincent cobre a guerra entre Reatech e Gexin. 209 páginas · 4,8★ (926 avaliações).",
        "img": "https://m.media-amazon.com/images/I/81El1jOYaOL._SY342_.jpg",
        "cta": "Comprar na Amazon",
    },
    {
        "id": "livepix",
        "emoji": "💸",
        "titulo": "Pix / Doação — LivePix",
        "url": "https://livepix.gg/bakagaijin",
        "desc": "Apoie diretamente o Baka Gaijin com Pix e mande mensagens durante as lives.",
        "img": "https://static.livepix.gg/images/logo-white.svg",
        "cta": "Fazer um Pix",
    },
]


def _scrape_support() -> list[dict]:
    """Tenta extrair og:image/og:description de cada link; mantém fallback fixo."""
    links = [dict(x) for x in SUPPORT_LINKS]
    for link in links:
        try:
            req = urllib.request.Request(
                link["url"],
                headers={"User-Agent": "Mozilla/5.0 (compatible; BakaFanPage/1.0)"},
            )
            with urllib.request.urlopen(req, timeout=8) as resp:
                raw = resp.read().decode("utf-8", "ignore")

            def _meta(prop: str) -> str | None:
                for m in re.finditer(
                    r'<meta[^>]+(?:property|name)=["\']' + prop + r'["\'][^>]+content=["\']([^"\']+)["\']',
                    raw,
                    re.I,
                ):
                    return m.group(1)
                for m in re.finditer(
                    r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']' + prop + r'["\']',
                    raw,
                    re.I,
                ):
                    return m.group(1)
                return None

            img = _meta("og:image")
            if img and img.startswith(("http://", "https://")):
                link["img"] = img

            # Preferências específicas: banner da loja na Lolja (evita logo genérico)
            if link["id"] == "lolja":
                m = re.search(r'https://cdn\.vnda\.com\.br/[^"\'\s]+\.(?:jpg|jpeg|png|webp)', raw)
                if m:
                    link["img"] = m.group(0)
            elif "logo" in link["img"].lower() and not link["img"].endswith(".svg"):
                # descarta logos genéricos, mantém fallback curado
                pass

            desc = _meta("og:description")
            if desc:
                link["desc"] = re.sub(r"\s+", " ", desc).strip()[:300]
        except Exception:  # noqa: BLE001
            pass
    return links


def fmt_dur(seconds: float) -> str:
    seconds = int(seconds)
    h = seconds // 3600
    m = (seconds % 3600) // 60
    return f"{h}h{m:02d}min" if h else f"{m}min"


def fmt_num(n: float) -> str:
    if n >= 1_000_000:
        return f"{n/1_000_000:.2f}M"
    if n >= 1_000:
        return f"{n/1_000:.1f}k"
    return f"{n:,.0f}"


def _fmt_data_br(iso: str) -> str:
    """Converte data ISO (YYYY-MM-DD) para o padrão brasileiro (DD/MM/AAAA)."""
    if not iso:
        return "—"
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", str(iso))
    if not m:
        return str(iso)[:10]
    return f"{m.group(3)}/{m.group(2)}/{m.group(1)}"


def pct_change(value: float, baseline: float) -> float | None:
    if baseline in (0, None):
        return None
    return round((value - baseline) / baseline * 100, 1)


def parse_srt_to_blocks(text: str) -> list[dict]:
    """Converte .srt em [{start, end, text}]."""
    blocks: list[dict] = []
    raw = re.split(r"\n\s*\n", text.strip())
    for block in raw:
        lines = [ln for ln in block.splitlines() if ln.strip()]
        if not lines:
            continue
        m = None
        for ln in lines:
            m = re.search(r"(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})", ln)
            if m:
                break
        if not m:
            continue
        h1, m1, s1, _, h2, m2, s2 = (int(x) for x in m.groups())
        start = h1 * 3600 + m1 * 60 + s1
        end = h2 * 3600 + m2 * 60 + s2
        content = " ".join(ln for ln in lines if "-->" not in ln and not ln.strip().isdigit()).strip()
        if content:
            blocks.append({"start": start, "end": end, "text": content})
    return blocks


# --------------------------------------------------------------------------- #
# 1) Métricas de performance
# --------------------------------------------------------------------------- #

def fetch_video_metrics(video_id: str) -> dict | None:
    q = (
        'query { video(id: "%s") { id title viewCount lengthSeconds createdAt'
        " thumbnailURLs(width: 640, height: 360) game { displayName } owner { login displayName } } }"
        % video_id
    )
    out = gql_post(q)
    v = (out.get("data") or {}).get("video")
    if not v:
        return None
    thumbnails = v.get("thumbnailURLs") or []
    return {
        "id": v.get("id"),
        "title": v.get("title"),
        "views": v.get("viewCount"),
        "duration_seconds": v.get("lengthSeconds"),
        "created_at": v.get("createdAt"),
        "thumbnail": thumbnails[0] if thumbnails else None,
        "category": (v.get("game") or {}).get("displayName"),
        "owner": (v.get("owner") or {}).get("displayName"),
        "channel_login": (v.get("owner") or {}).get("login"),
    }


def _video_owner_login(video_id: str) -> str:
    q = 'query { video(id: "%s") { owner { login } } }' % video_id
    out = gql_post(q)
    owner = ((out.get("data") or {}).get("video") or {}).get("owner") or {}
    return owner.get("login") or ""


def fetch_channel_videos(login: str) -> list[dict]:
    q = (
        'query { user(login: "%s") { id displayName followers { totalCount }'
        " videos(first: 50, sort: TIME) { edges { node { id title viewCount"
        " lengthSeconds createdAt } } } } }"
        % login
    )
    out = gql_post(q)
    user = (out.get("data") or {}).get("user") or {}
    vids = []
    for e in (user.get("videos") or {}).get("edges", []):
        n = e.get("node") or {}
        vids.append(
            {
                "id": n.get("id"),
                "title": n.get("title"),
                "views": n.get("viewCount"),
                "duration_seconds": n.get("lengthSeconds"),
                "created_at": n.get("createdAt"),
            }
        )
    return vids, (user.get("followers") or {}).get("totalCount")


def fetch_channel_profile(login: str) -> dict:
    """Busca banner, descrição e redes sociais do canal na Twitch."""
    profile: dict = {"login": login, "banner": "", "description": "", "socials": []}
    try:
        q = (
            'query { user(login: "%s") { id login displayName description'
            " profileImageURL(width: 300) bannerImageURL"
            ' channel { socialMedias { name url } } } }'
            % login
        )
        out = gql_post(q)
        u = (out.get("data") or {}).get("user") or {}
        if not u:
            return profile
        banner = u.get("bannerImageURL")
        profile["banner"] = banner or ""
        profile["description"] = u.get("description") or ""
        profile["avatar"] = u.get("profileImageURL") or ""
        for s in ((u.get("channel") or {}).get("socialMedias") or []):
            if s.get("name") and s.get("url"):
                profile["socials"].append({"name": s["name"], "url": s["url"]})
    except Exception:  # noqa: BLE001
        pass
    return profile


def compute_metrics(video_id: str) -> dict:
    meta = fetch_video_metrics(video_id)
    views = (meta or {}).get("views") or 0
    duration = (meta or {}).get("duration_seconds") or 0

    # comentários
    comments = load_comments()
    n_comments = len(comments)

    # likes não são expostos pela GraphQL da Twitch -> estimativa
    # (média histórica ~ 0.5%–2% de likes por view; usa 1.2% como proxy)
    likes = int(views * 0.012)

    like_rate = (likes / views * 100) if views else 0.0
    engagement = ((likes + n_comments) / views * 100) if views else 0.0

    # benchmark do canal
    channel = {"videos": [], "followers": None}
    channel_login = (meta or {}).get("channel_login") or _video_owner_login(video_id)
    if meta and channel_login:
        vids, followers = fetch_channel_videos(channel_login)
        channel["videos"] = vids
        channel["followers"] = followers

    others = [v for v in channel["videos"] if v.get("id") != video_id and v.get("views")]
    chan_views = [v["views"] for v in channel["videos"] if v.get("views")]

    def _med(xs):
        return statistics.median(xs) if xs else 0

    def _avg(xs):
        return sum(xs) / len(xs) if xs else 0

    channel_median_views = _med(chan_views)
    channel_avg_views = _avg(chan_views)
    peers_median_views = _med([v["views"] for v in others])

    metrics = {
        "video_id": video_id,
        "title": (meta or {}).get("title") or "",
        "channel": (meta or {}).get("owner") or "",
        "category": (meta or {}).get("category") or "",
        "created_at": (meta or {}).get("created_at") or "",
        "thumbnail": (meta or {}).get("thumbnail") or "",
        "duration_seconds": duration,
        "duration_label": fmt_dur(duration),
        "views": views,
        "views_label": fmt_num(views),
        "likes_estimado": likes,
        "likes_label": fmt_num(likes),
        "comentarios": n_comments,
        "taxa_likes": round(like_rate, 3),
        "taxa_engajamento": round(engagement, 3),
        "followers_canal": channel["followers"],
        "comparacao_canal": {
            "mediana_views": channel_median_views,
            "media_views": round(channel_avg_views, 1),
            "mediana_pares": peers_median_views,
            "views_vs_mediana_pct": pct_change(views, channel_median_views),
            "views_vs_media_pct": pct_change(views, channel_avg_views),
            "views_vs_pares_pct": pct_change(views, peers_median_views),
            "n_videos_canal": len(channel["videos"]),
        },
    }
    return metrics


# --------------------------------------------------------------------------- #
# Comentários: carregar, classificar e popular
# --------------------------------------------------------------------------- #

def load_comments() -> list[dict]:
    comments_file = FOLDER / "comentarios.json"
    if not comments_file.exists():
        print(f"  [!] comentarios.json não encontrado em {FOLDER}", file=sys.stderr)
        return []
    try:
        data = json.loads(comments_file.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        print("  [!] comentarios.json inválido", file=sys.stderr)
        return []
    comments = data.get("comments") or []
    # se veio de outra estrutura, tenta pegar lista pura
    if not comments and isinstance(data, list):
        comments = data
    return comments


def classify_sentiment(text: str) -> tuple[str, float]:
    """Classifica o comentário em uma das 8 categorias (heurística lexica)."""
    t = text.lower()
    scores: dict[str, int] = {c: 0 for c in SENTIMENT_CATEGORIES}

    for word in LEXICON["positivo"]:
        if word in t:
            scores["positivo"] += 2
    for word in LEXICON["engraçado"]:
        if word in t:
            scores["engraçado"] += 2
    for word in LEXICON["frustrado"]:
        if word in t:
            scores["frustrado"] += 2
    for word in LEXICON["negativo"]:
        if word in t:
            scores["negativo"] += 2
    for word in LEXICON["inspirado"]:
        if word in t:
            scores["inspirado"] += 2
    for word in LEXICON["confuso"]:
        if word in t:
            scores["confuso"] += 2

    # pergunta => neutro/pergunta (a menos que já tenha sentimento forte)
    is_question = t.rstrip().endswith("?") or any(w in t for w in ("?", "? ", " ?"))
    if is_question and sum(scores.values()) == 0:
        scores["neutro/pergunta"] += 3

    # emojis
    if any(e in text for e in ("❤", "♥", "👍", "🙏", "fa-solid fa-fire", "😍")):
        scores["positivo"] += 1
    if any(e in text for e in ("fa-solid fa-face-laugh-squint", "🤣", "😆", "💀")):
        scores["engraçado"] += 2
    if any(e in text for e in ("😡", "🤬", "😤")):
        scores["frustrado"] += 2
    if any(e in text for e in ("🤔", "🧐", "😕", "❓")):
        scores["confuso"] += 2

    best = max(scores, key=lambda c: scores[c])
    total = sum(scores.values())
    confidence = round(scores[best] / total, 3) if total else 0.0
    if total == 0:
        best = "neutro"
        confidence = 1.0
    return best, confidence


def clean_text(text: str) -> str:
    t = text.lower()
    t = re.sub(r"https?://\S+", " ", t)
    t = re.sub(r"@\w+", " ", t)
    t = re.sub(r"[^a-z0-9áéíóúâêôãõçà\s]", " ", t)
    return t


def extract_themes(comments: list[dict]) -> list[dict]:
    """Agrupamento temático simples (substituto leve de BERTopic).

    Extrai palavras e bigramas mais frequentes (fora stopwords), junta
    termos correlacionados (que co-ocorrem) em um mesmo tema e rotula
    cada tema com % de comentários que o mencionam.
    """
    freq: Counter = Counter()
    bigram_freq: Counter = Counter()
    doc_keywords: list[set[str]] = []
    doc_terms: list[list[str]] = []
    for c in comments:
        words = [w for w in clean_text(c.get("text", "")).split() if len(w) >= 3 and w not in STOPWORDS]
        doc_keywords.append(set(words))
        doc_terms.append(words)
        freq.update(words)
        for a, b in zip(words, words[1:]):
            bigram_freq[f"{a} {b}"] += 1

    # termos candidatos: palavras frequentes + bigramas relevantes
    candidates: list[tuple[str, int]] = []
    for w, n in freq.most_common(60):
        if n >= 5:
            candidates.append((w, n))
    for bg, n in bigram_freq.most_common(30):
        if n >= 5:
            candidates.append((bg, n))

    total_comments = len(comments) or 1

    # agrupa candidatos em temas (clusters por co-ocorrência)
    themes: list[dict] = []
    used_terms: set[str] = set()
    for term, count in candidates:
        if term in used_terms:
            continue
        term_words = set(term.split())
        cluster = {term}
        related = []
        # encontra termos que co-ocorrem com este
        for other, _ in candidates:
            if other == term or other in used_terms:
                continue
            other_words = set(other.split())
            if term_words & other_words:
                related.append(other)
            else:
                co = sum(
                    1
                    for doc in doc_keywords
                    if term_words.issubset(doc) and other_words.issubset(doc)
                )
                if co >= max(1, count * 0.1):
                    related.append(other)
        for other in related:
            cluster.add(other)
            used_terms.add(other)
        used_terms.update(cluster)

        # conta comentários que mencionam qualquer termo do cluster
        cluster_words = {w for t in cluster for w in t.split()}
        n_docs = sum(1 for doc in doc_keywords if cluster_words & doc)
        if n_docs == 0:
            continue
        keywords = sorted(cluster, key=lambda t: candidates_weight(t, freq, bigram_freq), reverse=True)[:6]

        # título do tema: prioriza bigrama; senão junta as 2 palavras principais
        titulo = keywords[0]
        if " " not in keywords[0]:
            # procura um bigrama no cluster
            bigrama = next((k for k in keywords if " " in k), None)
            if bigrama:
                titulo = bigrama
            elif len(keywords) >= 2 and " " not in keywords[1]:
                titulo = f"{keywords[0]} {keywords[1]}"

        themes.append(
            {
                "tema": titulo,
                "palavras_chave": keywords,
                "n_comentarios": n_docs,
                "pct": round(n_docs / total_comments * 100, 1),
            }
        )
    themes.sort(key=lambda t: t["pct"], reverse=True)
    # remove temas sobrepostos demais (mantém os mais fortes)
    return themes[:12]


def candidates_weight(term: str, freq: Counter, bigram_freq: Counter) -> int:
    return bigram_freq.get(term) if " " in term else freq.get(term, 0)


def find_popular_comment(comments: list[dict]) -> dict | None:
    """Comentário 'mais popular': melhor combinação de tamanho + menções + engajamento implícito."""
    if not comments:
        return None
    best = None
    best_score = -1.0
    for c in comments:
        text = c.get("text", "")
        score = (
            min(len(text), 500) / 50.0  # tamanho
            + 2.0 * text.count("@")  # responde alguém
            + 2.0 * (1 if "?" in text else 0)
            + 3.0 * (1 if " subscribed" in text.lower() else 0)
        )
        if score > best_score:
            best_score = score
            best = c
    return best


def build_comments_analysis(comments: list[dict]) -> dict:
    enriched: list[dict] = []
    sent_counter: Counter = Counter()
    for c in comments:
        sentiment, confidence = classify_sentiment(c.get("text", ""))
        sent_counter[sentiment] += 1
        enriched.append(
            {
                "id": c.get("id"),
                "offset": c.get("offset", 0),
                "timestamp": fmt_ts(c.get("offset", 0)),
                "usuario": c.get("login") or c.get("displayName") or "",
                "nome": c.get("displayName") or "",
                "texto": c.get("text", ""),
                "sentimento": sentiment,
                "confianca": confidence,
            }
        )

    total = len(enriched) or 1
    sentiment_dist = [
        {
            "categoria": cat,
            "n": sent_counter.get(cat, 0),
            "pct": round(sent_counter.get(cat, 0) / total * 100, 1),
        }
        for cat in SENTIMENT_CATEGORIES
    ]

    themes = extract_themes(comments)
    popular = find_popular_comment(comments)

    return {
        "total_comentarios": len(enriched),
        "sentimentos": sentiment_dist,
        "temas": themes,
        "comentario_mais_popular": (
            {
                "usuario": popular.get("login") or popular.get("displayName"),
                "texto": popular.get("text"),
                "timestamp": fmt_ts(popular.get("offset", 0)),
            }
            if popular
            else None
        ),
        "comentarios": enriched,
    }


# --------------------------------------------------------------------------- #
# Resumo, estrutura e cortes virais
# --------------------------------------------------------------------------- #

def build_content_analysis(blocks: list[dict], comments_analysis: dict, metrics: dict) -> dict:
    full_text = "\n".join(f"[{fmt_ts(b['start'])}] {b['text']}" for b in blocks)

    # temas do conteúdo = blocos de ~10 min
    blocos_10 = []
    window = 600
    current = []
    bucket_start = None
    for b in blocks:
        if bucket_start is None:
            bucket_start = b["start"]
        if b["start"] - bucket_start >= window:
            if current:
                blocos_10.append(
                    {
                        "inicio": fmt_ts(bucket_start),
                        "fim": fmt_ts(b["start"]),
                        "texto": " ".join(current),
                    }
                )
            bucket_start = b["start"]
            current = []
        current.append(b["text"])
    if current:
        blocos_10.append(
            {
                "inicio": fmt_ts(bucket_start),
                "fim": fmt_ts(blocks[-1]["end"]),
                "texto": " ".join(current),
            }
        )

    # palavras-chave do conteúdo
    freq = Counter()
    for b in blocks:
        freq.update(w for w in clean_text(b["text"]).split() if len(w) >= 4 and w not in STOPWORDS)
    keywords = [w for w, _ in freq.most_common(15)]

    # momentos-chave: blocos com mais palavras-chave e mais densos
    scored = []
    for b in blocks:
        kws = sum(1 for w in clean_text(b["text"]).split() if w in set(keywords[:10]))
        scored.append((b, kws))
    scored.sort(key=lambda x: (x[1], len(x[0]["text"])), reverse=True)
    momentos = [
        {"timestamp": fmt_ts(b["start"]), "texto": b["text"]} for b, _ in scored[:12]
    ]

    # cortes virais: janelas de 60–180s com maior densidade de palavras-chave + engajamento no chat
    # pontua cada segundo de conteúdo; depois pega as janelas de maior pontuação
    second_score = Counter()
    for b in blocks:
        weight = sum(1 for w in clean_text(b["text"]).split() if w in set(keywords[:10]))
        weight += 1
        for s in range(b["start"], min(b["end"], b["start"] + 60)):
            second_score[s] += weight

    # comentários por janela
    comments_by_second = Counter()
    for c in comments_analysis["comentarios"]:
        comments_by_second[c["offset"]] += 1

    # varre todas as janelas possíveis (1–3 min) e pontua
    all_windows = []
    duration = metrics.get("duration_seconds", 0)
    if duration > 0:
        for win in (180, 150, 120, 90, 60):
            for start in range(0, duration - win, 10):
                score = sum(second_score[s] for s in range(start, start + win, 5))
                chat = sum(comments_by_second[s] for s in range(start, start + win, 5))
                all_windows.append(
                    {
                        "start": start,
                        "end": start + win,
                        "dur": win,
                        "score": score + chat * 3,
                        "chat": chat,
                    }
                )

    all_windows.sort(key=lambda w: w["score"], reverse=True)

    # seleciona janelas não sobrepostas (ganancioso)
    chosen: list[dict] = []
    occupied: list[tuple[int, int]] = []
    for w in all_windows:
        if any(not (w["end"] <= a or w["start"] >= b) for a, b in occupied):
            continue
        chosen.append(w)
        occupied.append((w["start"], w["end"]))
        if len(chosen) >= 6:
            break
    chosen.sort(key=lambda w: w["start"])

    cortes = []
    for w in chosen:
        snippet = next(
            (b["text"] for b in blocks if b["start"] <= w["start"] < b["end"]),
            "",
        )
        cortes.append(
            {
                "inicio": fmt_ts(w["start"]),
                "fim": fmt_ts(w["end"]),
                "inicio_sec": w["start"],
                "fim_sec": w["end"],
                "duracao_min": round(w["dur"] / 60, 1),
                "justificativa": (
                    f"Janela {fmt_ts(w['start'])}–{fmt_ts(w['end'])} concentra {w['chat']} mensagens de chat "
                    f"e alto uso das palavras-chave do vídeo."
                ),
                "trecho": snippet,
            }
        )

    return {
        "palavras_chave": keywords,
        "blocos_10min": blocos_10,
        "momentos_chave": momentos,
        "cortes_virais": cortes,
        "capitulos": build_chapters(blocos_10, keywords),
        "transcricao_resumida": full_text[:8000],
    }


def build_chapters(blocos_10: list[dict], keywords: list[str]) -> list[dict]:
    """Gera capítulos automáticos a partir dos blocos de ~10 min.

    Rótulo = palavra-chave mais relevante e distintiva do bloco.
    Evita palavras de preenchimento ("gente", "olha", "vamos", etc.).
    """
    # palavras de preenchimento que não fazem sentido como título de capítulo
    FILLER = {
        "gente", "olha", "vamos", "acho", "verdade", "nossa", "cara", "como",
        "tudo", "pode", "calma", "legal", "entao", "então", "coisa", "nada",
        "depois", "ainda", "muito", "muita", "tambem", "também", "porque",
        "sabe", "sabe", "fazer", "fala", "falar", "vai", "vou", "está", "esta",
        "tava", "tá", "ta", "né", "ne", "tipo", "assim", "certo", "isso",
        "isso", "aqui", "ali", "sempre", "nunca", "agora", "hoje", "só", "so",
        "bom", "boa", "bem", "lá", "la", "aí", "ai", "tem", "tinha", "deixa",
        "deixar", "ficar", "fique", "chega", "chegou", "tá", "vem", "veio",
    }
    chapters: list[dict] = []
    for b in blocos_10:
        text = b["texto"]
        low = text.lower()
        words = [w for w in clean_text(text).split() if len(w) >= 4 and w not in STOPWORDS and w not in FILLER]

        # 1) tenta bigramas temáticos (frases de 2 palavras relevantes)
        best = None
        best_score = 0
        toks = [w for w in clean_text(text).split() if len(w) >= 3 and w not in STOPWORDS and w not in FILLER]
        bigram_freq = Counter()
        for a, bgram in zip(toks, toks[1:]):
            bigram_freq[f"{a} {bgram}"] += 1
        for phrase, n in bigram_freq.most_common(10):
            if n >= 2 and len(phrase) >= 8:
                best = phrase
                best_score = n
                break

        # 2) senão, palavra-chave do vídeo que mais aparece no bloco (e não é filler)
        if not best:
            for kw in keywords[:15]:
                if kw in FILLER or kw in STOPWORDS:
                    continue
                c = low.count(kw)
                if c > best_score:
                    best_score = c
                    best = kw

        # 3) senão, palavra mais frequente do bloco (não filler)
        if not best and words:
            freq = Counter(words)
            best = freq.most_common(1)[0][0]

        title = (best or "Trecho").title()
        chapters.append(
            {
                "inicio": b["inicio"],
                "fim": b["fim"],
                "inicio_sec": _ts_to_sec(b["inicio"]),
                "titulo": title,
                "resumo": " ".join(words[:12]),
            }
        )
    return chapters


def _ts_to_sec(ts: str) -> int:
    parts = [int(x) for x in ts.split(":")]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    return parts[0] * 60 + parts[1]


# --------------------------------------------------------------------------- #
# Engajamento: fala vs chat, correlação, picos, bordões, alertas
# --------------------------------------------------------------------------- #

# Palavras sensíveis para alertas de moderação
RISK_WORDS = [
    "maconha", "prostitu", "crime", "pau", "droga", "buceta", "cu", "pinto",
    "sexo", "mijo", "mijou", "punheta", "viado", "puta", "caralho", "foder",
    "foda", "merda", "bosta", "pênis", "penis",
]

# Marcadores de risada / humor
LAUGH_MARKERS = ["kkk", "haha", "rsrs", "lol", "lul", "racho", "ri ", "risada", "kapp"]

# Bordões frequentes (frases que se repetem)
CATCHPHRASE_STOP = {"eai", "e ai", "né", "ne", "tá", "ta", "legal", "verdade", "calma"}


def build_engagement_analysis(blocks: list[dict], comments_analysis: dict, metrics: dict) -> dict:
    """Calcula KPIs de engajamento por minuto, correlacionando fala e chat."""
    duration = metrics.get("duration_seconds", 0) or 0
    if not duration:
        return {}

    # --- fala por minuto (palavras) ---
    words_per_min = Counter()
    speech_seconds = Counter()
    for b in blocks:
        minute = b["start"] // 60
        words_per_min[minute] += len(b["text"].split())
        speech_seconds[minute] += max(1, min(b["end"], b["start"] + 60) - b["start"])

    # --- chat por minuto (mensagens, usuários, risadas, perguntas, sentimento) ---
    chat_per_min = Counter()
    users_per_min: dict[int, set] = {}
    laughs_per_min = Counter()
    questions_per_min = Counter()
    sent_per_min: dict[int, list] = {}
    for c in comments_analysis["comentarios"]:
        minute = (c["offset"] or 0) // 60
        chat_per_min[minute] += 1
        users_per_min.setdefault(minute, set()).add(c["usuario"])
        text = c["texto"].lower()
        if any(m in text for m in LAUGH_MARKERS):
            laughs_per_min[minute] += 1
        if "?" in c["texto"]:
            questions_per_min[minute] += 1
        sent_per_min.setdefault(minute, []).append(c["sentimento"])

    total_minutes = int(duration // 60) + 1

    # --- buckets por minuto (para timeline/heatmap) ---
    minute_buckets = []
    fala_series = []
    chat_series = []
    for m in range(total_minutes):
        words = words_per_min.get(m, 0)
        chat = chat_per_min.get(m, 0)
        users = len(users_per_min.get(m, set()))
        laughs = laughs_per_min.get(m, 0)
        questions = questions_per_min.get(m, 0)
        sents = sent_per_min.get(m, [])
        top_sent = Counter(sents).most_common(1)
        dom_sent = top_sent[0][0] if top_sent else "neutro"
        fala_series.append(words)
        chat_series.append(chat)
        minute_buckets.append(
            {
                "minuto": m,
                "inicio": fmt_ts(m * 60),
                "palavras": words,
                "mensagens": chat,
                "usuarios": users,
                "risadas": laughs,
                "perguntas": questions,
                "sentimento": dom_sent,
            }
        )

    # --- palavras por minuto (fala) vs mensagens por minuto (chat) ---
    speech_duration_min = duration / 60
    palavras_por_minuto = round(sum(words_per_min.values()) / speech_duration_min, 1) if speech_duration_min else 0
    mensagens_por_minuto = round(sum(chat_per_min.values()) / speech_duration_min, 1) if speech_duration_min else 0

    # --- correlação fala ↔ chat (Pearson sobre as séries por minuto) ---
    correlacao = _pearson(fala_series, chat_series)

    # --- picos de retenção: fala + chat explodem juntos (top janelas de 1 min) ---
    picos = []
    for m in range(total_minutes):
        score = fala_series[m] + chat_series[m] * 3 + laughs_per_min.get(m, 0) * 5
        picos.append({"minuto": m, "inicio": fmt_ts(m * 60), "score": score,
                      "palavras": fala_series[m], "mensagens": chat_series[m],
                      "risadas": laughs_per_min.get(m, 0)})
    picos.sort(key=lambda x: x["score"], reverse=True)

    # --- tópicos falados vs comentados (palavras) ---
    fala_freq = Counter()
    for b in blocks:
        fala_freq.update(w for w in clean_text(b["text"]).split() if len(w) >= 4 and w not in STOPWORDS)
    chat_freq = Counter()
    for c in comments_analysis["comentarios"]:
        chat_freq.update(w for w in clean_text(c["texto"]).split() if len(w) >= 4 and w not in STOPWORDS)
    topicos_falados = [{"palavra": w, "n": n} for w, n in fala_freq.most_common(15)]
    topicos_comentados = [{"palavra": w, "n": n} for w, n in chat_freq.most_common(15)]

    # --- frases completas (bigramas/trigramas) faladas vs comentadas ---
    def _ngrams(tokens: list[str], n: int) -> list[str]:
        return [" ".join(tokens[i:i + n]) for i in range(len(tokens) - n + 1)]

    fala_phrases = Counter()
    for b in blocks:
        toks = [w for w in clean_text(b["text"]).split() if len(w) >= 3 and w not in STOPWORDS]
        for n in (2, 3):
            for phrase in _ngrams(toks, n):
                if len(phrase) >= 8:
                    fala_phrases[phrase] += 1
    chat_phrases = Counter()
    for c in comments_analysis["comentarios"]:
        toks = [w for w in clean_text(c["texto"]).split() if len(w) >= 3 and w not in STOPWORDS]
        for n in (2, 3):
            for phrase in _ngrams(toks, n):
                if len(phrase) >= 8:
                    chat_phrases[phrase] += 1

    # remove frases que são substrings de outra mais frequente (dedup)
    def _dedup(counter: Counter, top=15) -> list[dict]:
        items = sorted(counter.items(), key=lambda x: -x[1])
        result = []
        for phrase, n in items:
            if any(phrase in p for p, _ in result):
                continue
            result.append((phrase, n))
            if len(result) >= top:
                break
        return [{"frase": p, "n": n} for p, n in result]

    frases_faladas = _dedup(fala_phrases)
    frases_comentadas = _dedup(chat_phrases)

    # --- ganchos de conteúdo: piadas/risadas, perguntas, histórias, revelações ---
    ganchos = []
    for m in range(total_minutes):
        words = " ".join(b["text"] for b in blocks if b["start"] // 60 == m)
        low = words.lower()
        tag = None
        if laughs_per_min.get(m, 0) >= 3 or any(x in low for x in LAUGH_MARKERS):
            tag = "piada"
        elif questions_per_min.get(m, 0) >= 2 or low.count("?") >= 2:
            tag = "pergunta"
        elif any(x in low for x in ("história", "historia", "aconteceu", "lembro", "antigamente", "uma vez")):
            tag = "história"
        elif any(x in low for x in ("revelação", "revelacao", "segredo", "na verdade", "vou falar", "descobri")):
            tag = "revelação"
        if tag:
            snippet = next((b["text"] for b in blocks if b["start"] // 60 == m and b["text"].strip()), "")
            ganchos.append({"inicio": fmt_ts(m * 60), "tipo": tag, "trecho": snippet[:140]})
        if len(ganchos) >= 10:
            break

    # --- alertas de risco: menções sensíveis + aumento de mensagens ---
    alertas = []
    avg_chat = mensagens_por_minuto
    for m in range(total_minutes):
        words = " ".join(b["text"] for b in blocks if b["start"] // 60 == m).lower()
        hits = [w for w in RISK_WORDS if w in words]
        if hits and chat_per_min.get(m, 0) >= avg_chat * 1.3:
            alertas.append(
                {
                    "inicio": fmt_ts(m * 60),
                    "termos": hits[:4],
                    "mensagens": chat_per_min.get(m, 0),
                }
            )
        if len(alertas) >= 10:
            break

    # --- ranking de bordões: frases de 2-4 palavras que se repetem na fala ---
    phrase_freq = Counter()
    for b in blocks:
        words = [w for w in clean_text(b["text"]).split() if w]
        for n in (3, 4):
            for i in range(len(words) - n + 1):
                phrase = " ".join(words[i:i + n])
                if phrase and phrase not in CATCHPHRASE_STOP and len(phrase) >= 8:
                    phrase_freq[phrase] += 1
    bordoes = [
        {"frase": p, "n": n}
        for p, n in phrase_freq.most_common(12)
        if n > 10 and not p.isdigit()
    ]

    # --- resumo em 1 minuto: 1 fala por trecho espaçado ---
    resumo_1min = []
    step = max(1, total_minutes // 12)
    for m in range(0, total_minutes, step):
        snippet = next((b["text"] for b in blocks if b["start"] // 60 == m and b["text"].strip()), "")
        if snippet:
            resumo_1min.append({"inicio": fmt_ts(m * 60), "texto": snippet[:120]})

    # --- perguntas frequentes do chat ---
    perguntas_freq = Counter()
    for c in comments_analysis["comentarios"]:
        if "?" in c["texto"]:
            q = c["texto"].strip()
            if len(q) >= 8:
                perguntas_freq[q[:80]] += 1
    perguntas_frequentes = [{"pergunta": q, "n": n} for q, n in perguntas_freq.most_common(10) if n >= 2]

    # --- séries de sentimento por minuto (para gráfico de área empilhada) ---
    sent_series: dict[str, list[int]] = {cat: [0] * total_minutes for cat in SENTIMENT_CATEGORIES}
    sent_count_per_min: dict[int, Counter] = {}
    for c in comments_analysis["comentarios"]:
        minute = (c["offset"] or 0) // 60
        sent_count_per_min.setdefault(minute, Counter())[c["sentimento"]] += 1
    risadas_series = [0] * total_minutes
    perguntas_series = [0] * total_minutes
    for m in range(total_minutes):
        cc = sent_count_per_min.get(m, Counter())
        for cat in SENTIMENT_CATEGORIES:
            sent_series[cat][m] = cc.get(cat, 0)
        risadas_series[m] = laughs_per_min.get(m, 0)
        perguntas_series[m] = questions_per_min.get(m, 0)

    # --- nuvem de palavras (fala + chat) ---
    word_weights: dict[str, int] = {}
    for b in blocks:
        for w in clean_text(b["text"]).split():
            if len(w) >= 4 and w not in STOPWORDS:
                word_weights[w] = word_weights.get(w, 0) + 1
    for c in comments_analysis["comentarios"]:
        for w in clean_text(c["texto"]).split():
            if len(w) >= 4 and w not in STOPWORDS:
                word_weights[w] = word_weights.get(w, 0) + 1
    wordcloud = [
        {"texto": w, "peso": n}
        for w, n in sorted(word_weights.items(), key=lambda x: -x[1])[:80]
    ]

    # --- heatmap minuto x sentimento (matriz por minuto) ---
    heatmap = [
        {
            "minuto": m,
            "inicio": fmt_ts(m * 60),
            **{cat: sent_series[cat][m] for cat in SENTIMENT_CATEGORIES},
        }
        for m in range(total_minutes)
    ]

    # --- top comentaristas ---
    user_count = Counter()
    for c in comments_analysis["comentarios"]:
        name = c["nome"] or c["usuario"]
        if name:
            user_count[name] += 1
    top_usuarios = [
        {"usuario": u, "n": n}
        for u, n in user_count.most_common(15)
    ]

    # --- todos os participantes do chat (com contagem e sentimento dominante) ---
    user_sent: dict[str, Counter] = {}
    for c in comments_analysis["comentarios"]:
        name = c["nome"] or c["usuario"]
        if name:
            user_sent.setdefault(name, Counter())[c["sentimento"]] += 1
    todos_participantes = []
    for u, n in sorted(user_count.items(), key=lambda x: (-x[1], x[0].lower())):
        sents = user_sent.get(u, Counter())
        dom = sents.most_common(1)
        todos_participantes.append(
            {
                "usuario": u,
                "n": n,
                "sentimento": dom[0][0] if dom else "neutro",
            }
        )

    # --- usuários únicos por minuto ---
    usuarios_series = [len(users_per_min.get(m, set())) for m in range(total_minutes)]

    # --- sentimento por tema (cruzamento temas × sentimentos) ---
    # para cada tema (top 8), conta o sentimento dos comentários que o mencionam
    temas = comments_analysis.get("temas", [])
    sentimento_por_tema = []
    for t in temas[:8]:
        tema_words = set((t.get("palavras_chave") or [])[:4])
        sents = Counter()
        for c in comments_analysis["comentarios"]:
            text = clean_text(c["texto"])
            if any(w in text for w in tema_words):
                sents[c["sentimento"]] += 1
        total = sum(sents.values()) or 1
        sentimento_por_tema.append(
            {
                "tema": t["tema"],
                "total": sum(sents.values()),
                "dist": [{"sentimento": cat, "n": sents.get(cat, 0), "pct": round(sents.get(cat, 0) / total * 100, 1)} for cat in SENTIMENT_CATEGORIES],
            }
        )

    # --- segmentos da live (4 quartos) ---
    segmentos = []
    quarto = max(1, total_minutes // 4)
    for q in range(4):
        ini = q * quarto
        fim = min(total_minutes, (q + 1) * quarto)
        seg_fala = sum(words_per_min.get(m, 0) for m in range(ini, fim))
        seg_chat = sum(chat_per_min.get(m, 0) for m in range(ini, fim))
        seg_users = len(set().union(*[users_per_min.get(m, set()) for m in range(ini, fim)])) if fim > ini else 0
        seg_laughs = sum(laughs_per_min.get(m, 0) for m in range(ini, fim))
        seg_questions = sum(questions_per_min.get(m, 0) for m in range(ini, fim))
        seg_sents = Counter()
        for m in range(ini, fim):
            seg_sents.update(sent_per_min.get(m, []))
        seg_top = seg_sents.most_common(1)
        segmentos.append(
            {
                "quarto": q + 1,
                "inicio": fmt_ts(ini * 60),
                "fim": fmt_ts((fim - 1) * 60),
                "palavras": seg_fala,
                "mensagens": seg_chat,
                "usuarios": seg_users,
                "risadas": seg_laughs,
                "perguntas": seg_questions,
                "sentimento_dominante": seg_top[0][0] if seg_top else "neutro",
            }
        )

    # --- retenção estimada de audiência ---
    # % dos usuários do 1º quarto que ainda comentam em cada minuto
    retention = []
    first_users: set = set()
    for m in range(total_minutes):
        if m <= max(1, total_minutes // 4):
            first_users |= users_per_min.get(m, set())
    baseline = len(first_users) or 1
    for m in range(0, total_minutes, max(1, total_minutes // 60)):
        cur = users_per_min.get(m, set())
        overlap = len(cur & first_users)
        retention.append(
            {
                "minuto": m,
                "inicio": fmt_ts(m * 60),
                "pct": round(overlap / baseline * 100, 1),
                "usuarios": overlap,
            }
        )

    # --- comandos do chat (!time, !clima, !setup, etc.) ---
    command_freq = Counter()
    command_re = re.compile(r"!([a-zA-Z0-9_]+)")
    # associa cada comando a exemplos e à resposta do bot (comentário seguinte)
    command_exemplos: dict[str, list[str]] = {}
    command_respostas: dict[str, str] = {}
    BOT_NAMES = {"nightbot", "streamelements", "streamlabs", "moobot", "fossabot", "wizebot"}
    for i, c in enumerate(comments_analysis["comentarios"]):
        for m in command_re.findall(c["texto"]):
            cmd = m.lower()
            command_freq[cmd] += 1
            # exemplo: o texto original do usuário que digitou o comando
            if cmd not in command_exemplos:
                command_exemplos[cmd] = []
            if len(command_exemplos[cmd]) < 3 and c["texto"].strip():
                command_exemplos[cmd].append(c["texto"].strip()[:80])
            # resposta: próximo comentário de um bot logo após o comando
            if cmd not in command_respostas:
                for nxt in comments_analysis["comentarios"][i + 1:i + 3]:
                    nome = (nxt.get("usuario") or "").lower()
                    if any(b in nome for b in BOT_NAMES):
                        command_respostas[cmd] = nxt["texto"].strip()[:160]
                        break

    comandos = []
    for k, n in command_freq.most_common(12):
        comandos.append(
            {
                "comando": f"!{k}",
                "n": n,
                "exemplo": (command_exemplos.get(k) or [""])[0],
                "resposta": command_respostas.get(k, ""),
            }
        )

    # --- monetização: subs, gifts, donates por minuto + tiers + receita ---
    subs_per_min = Counter()
    gifts_per_min = Counter()
    bits_per_min = Counter()
    sub_tiers = Counter()
    donates = []  # {"usuario": ..., "quantia": ...}
    for c in comments_analysis["comentarios"]:
        text = c["texto"].lower()
        minute = (c["offset"] or 0) // 60
        if "subscribed" in text or "sub" in text.split():
            subs_per_min[minute] += 1
            if "tier 1" in text:
                sub_tiers["tier1"] += 1
            elif "tier 2" in text:
                sub_tiers["tier2"] += 1
            elif "tier 3" in text:
                sub_tiers["tier3"] += 1
            else:
                sub_tiers["prime/outros"] += 1
        if "gift" in text or " gifted" in text:
            gifts_per_min[minute] += 1
        # bits/cheers: "Cheer100", "Cheer1000"
        for m in re.finditer(r"cheer(\d+)", text):
            bits_per_min[minute] += int(m.group(1))

    subs_series = [subs_per_min.get(m, 0) for m in range(total_minutes)]
    gifts_series = [gifts_per_min.get(m, 0) for m in range(total_minutes)]
    bits_series = [bits_per_min.get(m, 0) for m in range(total_minutes)]

    # valores estimados (USD) — média Twitch
    TIER_VALOR = {"tier1": 4.99, "tier2": 9.99, "tier3": 24.99, "prime/outros": 4.99}
    total_subs = sum(sub_tiers.values())
    receita_subs = round(sum(TIER_VALOR.get(t, 4.99) * n for t, n in sub_tiers.items()), 2)
    total_bits = sum(bits_per_min.values())
    receita_bits = round(total_bits / 100 * 0.7, 2)  # streamer recebe ~US$ 0.007 por bit
    # estimativa: US$ 2.50 por sub em média (após cut da Twitch ~50%)
    receita_liquida = round(receita_subs * 0.5 + receita_bits, 2)

    # sub tiers para gráfico de pizza
    tiers_pie = [{"tier": t, "n": n} for t, n in sub_tiers.most_common()]

    # cruzamento: subs vs sentimento do chat no mesmo minuto
    subs_sent = Counter()
    for c in comments_analysis["comentarios"]:
        text = c["texto"].lower()
        minute = (c["offset"] or 0) // 60
        if "subscribed" in text or "sub" in text.split():
            sents_do_minuto = sent_per_min.get(minute, [])
            for s in sents_do_minuto:
                subs_sent[s] += 1
    subs_sent_pie = [{"sentimento": cat, "n": subs_sent.get(cat, 0)} for cat in SENTIMENT_CATEGORIES if subs_sent.get(cat, 0)]

    # previsão de receita futura: média por minuto × duração típica (3h) vs. desta live
    receita_por_minuto = round(receita_liquida / speech_duration_min, 3) if speech_duration_min else 0

    # cotação USD -> BRL (open.er-api.com; fallback R$ 5,00 por dólar)
    usd_brl = _fetch_usd_brl()

    previsao = {
        "receita_liquida": receita_liquida,
        "receita_subs": receita_subs,
        "receita_bits": receita_bits,
        "total_subs": total_subs,
        "total_bits": total_bits,
        "receita_por_minuto": receita_por_minuto,
        "projecao_3h": round(receita_por_minuto * 180, 2),
        "projecao_2h": round(receita_por_minuto * 120, 2),
        "usd_brl": usd_brl,
        "receita_liquida_brl": round(receita_liquida * usd_brl, 2),
        "receita_subs_brl": round(receita_subs * usd_brl, 2),
        "receita_bits_brl": round(receita_bits * usd_brl, 2),
        "projecao_3h_brl": round(receita_por_minuto * 180 * usd_brl, 2),
        "projecao_2h_brl": round(receita_por_minuto * 120 * usd_brl, 2),
    }

    # --- correlação defasada (lag): fala agora influencia o chat 1 min depois? ---
    lag_corrs = []
    for lag in range(0, 6):
        xs = fala_series[:-lag] if lag else fala_series
        ys = chat_series[lag:]
        n = min(len(xs), len(ys))
        c = _pearson(xs[:n], ys[:n])
        lag_corrs.append({"lag_min": lag, "corr": round(c, 3) if c is not None else None})
    best_lag = max((x for x in lag_corrs if x["corr"] is not None), key=lambda x: abs(x["corr"]), default=None)

    # --- distribuição de interação por usuário (quantos comentam 1x, 2-5x, 6-10x, 11+ ) ---
    interaction_buckets = Counter()
    for u, n in user_count.items():
        if n == 1:
            interaction_buckets["1 comentário"] += 1
        elif n <= 5:
            interaction_buckets["2–5"] += 1
        elif n <= 10:
            interaction_buckets["6–10"] += 1
        elif n <= 20:
            interaction_buckets["11–20"] += 1
        else:
            interaction_buckets["21+"] += 1
    interaction_dist = [
        {"faixa": k, "usuarios": v}
        for k, v in interaction_buckets.most_common()
    ]

    # --- velocidade do chat (média móvel de 5 min) ---
    window = 5
    chat_ma = []
    for m in range(total_minutes):
        inicio = max(0, m - window + 1)
        vals = chat_series[inicio:m + 1]
        chat_ma.append(round(sum(vals) / len(vals), 1) if vals else 0)

    # --- emojis / reações mais usadas ---
    emoji_freq = Counter()
    emoji_re = re.compile(
        r"[\U0001F300-\U0001FAFF\U0001F600-\U0001F64F\U00002600-\U000026FF\U00002700-\U000027BF\U0001F900-\U0001F9FF]"
    )
    for c in comments_analysis["comentarios"]:
        for e in emoji_re.findall(c["texto"]):
            emoji_freq[e] += 1
    top_emojis = [{"emoji": e, "n": n} for e, n in emoji_freq.most_common(15)]

    # --- radar do streamer: perfil normalizado 0-100 ---
    # dimensões: humor, interatividade, monetização, engajamento, retenção, risco
    def _norm(v, ref):
        return round(min(100, v / ref * 100), 1) if ref else 0

    total_laughs = sum(laughs_per_min.values()) or 1
    total_questions = sum(questions_per_min.values()) or 1
    total_comments = len(comments_analysis["comentarios"]) or 1
    radar = {
        "humor": _norm(total_laughs, total_comments * 0.15),
        "interatividade": _norm(total_questions, total_comments * 0.05),
        "monetizacao": _norm(total_subs, max(1, total_comments * 0.01)),
        "engajamento": _norm(metrics.get("taxa_engajamento", 0), 10),
        "audiencia": _norm(len(user_count), total_comments * 0.4),
        "risco": _norm(len(alertas), 5),
    }

    return {
        "palavras_por_minuto": palavras_por_minuto,
        "mensagens_por_minuto": mensagens_por_minuto,
        "correlacao": round(correlacao, 3) if correlacao is not None else None,
        "minuto_buckets": minute_buckets,
        "fala_series": fala_series,
        "chat_series": chat_series,
        "risadas_series": risadas_series,
        "perguntas_series": perguntas_series,
        "usuarios_series": usuarios_series,
        "subs_series": subs_series,
        "gifts_series": gifts_series,
        "bits_series": bits_series,
        "tiers_pie": tiers_pie,
        "subs_sent_pie": subs_sent_pie,
        "previsao": previsao,
        "sent_series": sent_series,
        "heatmap": heatmap,
        "wordcloud": wordcloud,
        "picos": picos[:8],
        "topicos_falados": topicos_falados,
        "topicos_comentados": topicos_comentados,
        "frases_faladas": frases_faladas,
        "frases_comentadas": frases_comentadas,
        "top_usuarios": top_usuarios,
        "todos_participantes": todos_participantes,
        "sentimento_por_tema": sentimento_por_tema,
        "segmentos": segmentos,
        "retencao": retention,
        "comandos": comandos,
        "lag_corrs": lag_corrs,
        "best_lag": best_lag,
        "interaction_dist": interaction_dist,
        "chat_ma": chat_ma,
        "top_emojis": top_emojis,
        "radar": radar,
        "ganchos": ganchos,
        "alertas": alertas,
        "bordoes": bordoes,
        "resumo_1min": resumo_1min,
        "perguntas_frequentes": perguntas_frequentes,
        "busca_transcricao": [{"inicio": fmt_ts(b["start"]), "texto": b["text"]} for b in blocks],
    }


def _pearson(xs: list[float], ys: list[float]) -> float | None:
    n = len(xs)
    if n < 3:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    dy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if dx == 0 or dy == 0:
        return None
    return num / (dx * dy)


# --------------------------------------------------------------------------- #
# Insights estratégicos
# --------------------------------------------------------------------------- #

def build_insights(metrics: dict, comments_analysis: dict, content: dict) -> list[dict]:
    insights: list[dict] = []

    # 1. performance vs canal
    vs_med = metrics["comparacao_canal"]["views_vs_mediana_pct"]
    if vs_med is not None:
        insights.append(
            {
                "titulo": "Desempenho de views vs. canal",
                "acao": (
                    f"VOD com {fmt_num(metrics['views'])} views está "
                    f"{'acima' if vs_med >= 0 else 'abaixo'} da mediana do canal em {abs(vs_med)}% "
                    f"(mediana {fmt_num(metrics['comparacao_canal']['mediana_views'])})."
                ),
            }
        )

    # 2. sentimento dominante
    if comments_analysis["sentimentos"]:
        top_sent = max(comments_analysis["sentimentos"], key=lambda s: s["n"])
        insights.append(
            {
                "titulo": "Clima do chat",
                "acao": (
                    f"Sentimento dominante: {top_sent['categoria']} ({top_sent['pct']}% dos comentários). "
                    "Use esse tom para orientar thumbs e a narrativa dos cortes."
                ),
            }
        )

    # 3. melhor corte viral
    if content["cortes_virais"]:
        best = content["cortes_virais"][0]
        insights.append(
            {
                "titulo": "Corte viral nº 1",
                "acao": (
                    f"Publicar primeiro o trecho {best['inicio']}–{best['fim']} "
                    f"({best['duracao_min']}min) como Short/Reels/TikTok."
                ),
            }
        )

    # 4. engajamento
    insights.append(
        {
            "titulo": "Taxa de engajamento",
            "acao": (
                f"Engajamento de {metrics['taxa_engajamento']}% (likes+comentários/views). "
                "Publicações com call-to-action explícito tendem a subir essa taxa."
            ),
        }
    )

    # 5. tema mais comentado
    if comments_analysis["temas"]:
        t = comments_analysis["temas"][0]
        insights.append(
            {
                "titulo": "Tema que mais engaja",
                "acao": (
                    f"O tema '{t['tema']}' concentra {t['pct']}% dos comentários "
                    f"(palavras: {', '.join(t['palavras_chave'][:3])}). Explore mais esse assunto."
                ),
            }
        )

    # 6. pergunta do público
    perguntas = [c for c in comments_analysis["comentarios"] if c["sentimento"] == "neutro/pergunta"]
    if perguntas:
        q = perguntas[0]
        insights.append(
            {
                "titulo": "Dúvida recorrente do público",
                "acao": f"Responder em um próximo vídeo: \"{q['texto'][:120]}\"",
            }
        )

    # 7. horário / duração
    insights.append(
        {
            "titulo": "Formato e duração",
            "acao": (
                f"Vídeo de {metrics['duration_label']}. Cortes de 1–3min são o formato "
                "ideal para ampliar alcance além do VOD."
            ),
        }
    )

    return insights


# --------------------------------------------------------------------------- #
# Exportações
# --------------------------------------------------------------------------- #

def write_markdown(report: dict, path: Path) -> None:
    m = report["metricas"]
    cmp = m["comparacao_canal"]
    ca = report["comentarios"]
    ct = report["conteudo"]

    lines: list[str] = []
    add = lines.append

    add(f"# Relatório de Análise — {m['title']}")
    add("")
    add(f"- **Canal:** {m['channel']} ({fmt_num(m['followers_canal'] or 0)} seguidores)")
    add(f"- **Categoria:** {m['category']}")
    add(f"- **Publicado em:** {_fmt_data_br(m['created_at'])}")
    add(f"- **Duração:** {m['duration_label']}")
    add("")

    add("## 1. Métricas de Performance")
    add("")
    add("| Métrica | Valor |")
    add("| --- | --- |")
    add(f"| Views | {m['views_label']} |")
    add(f"| Likes (estimado) | {m['likes_label']} |")
    add(f"| Comentários | {m['comentarios']} |")
    add(f"| Taxa de likes | {m['taxa_likes']}% |")
    add(f"| Taxa de engajamento | {m['taxa_engajamento']}% |")
    add(f"| Duração | {m['duration_label']} |")
    add("")

    add("## 2. Comparação com o Canal")
    add("")
    add("| Indicador | Valor | Variação |")
    add("| --- | --- | --- |")
    add(f"| Mediana de views do canal | {fmt_num(cmp['mediana_views'])} | — |")
    add(f"| Média de views do canal | {fmt_num(cmp['media_views'])} | — |")
    add(f"| Mediana dos pares (outros VODs) | {fmt_num(cmp['mediana_pares'])} | — |")
    add(
        f"| Este VOD vs. mediana | {m['views_label']} | "
        f"{cmp['views_vs_mediana_pct']}% |"
    )
    add(
        f"| Este VOD vs. média | {m['views_label']} | "
        f"{cmp['views_vs_media_pct']}% |"
    )
    add("")

    add("## 3. Sentimento dos Comentários")
    add("")
    add("| Categoria | N | % |")
    add("| --- | --- | --- |")
    for s in ca["sentimentos"]:
        add(f"| {s['categoria']} | {s['n']} | {s['pct']}% |")
    add("")

    add("## 4. Temas dos Comentários")
    add("")
    add("| Tema | % | Palavras-chave |")
    add("| --- | --- | --- |")
    for t in ca["temas"]:
        add(f"| {t['tema']} | {t['pct']}% | {', '.join(t['palavras_chave'][:4])} |")
    add("")

    add("## 5. Resumo do Conteúdo")
    add("")
    add(f"**Palavras-chave:** {', '.join(ct['palavras_chave'])}")
    add("")

    add("### Capítulos automáticos")
    add("")
    for ch in ct.get("capitulos", []):
        add(f"- **{ch['inicio']}–{ch['fim']}** — {ch['titulo']}")
    add("")

    add("### Blocos de 10 minutos")
    add("")
    for b in ct["blocos_10min"]:
        add(f"- **{b['inicio']}–{b['fim']}:** {b['texto'][:160]}")
    add("")

    add("### Momentos-chave")
    add("")
    for mo in ct["momentos_chave"]:
        add(f"- `{mo['timestamp']}` — {mo['texto'][:120]}")
    add("")

    add("## 6. Cortes Virais Sugeridos (1–3 min)")
    add("")
    for i, c in enumerate(ct["cortes_virais"], 1):
        add(f"**Corte {i}: {c['inicio']}–{c['fim']} ({c['duracao_min']}min)**")
        add(f"> {c['justificativa']}")
        add(f"> Trecho: _{c['trecho'][:140]}_")
        add("")

    add("## 7. Comentário Mais Popular")
    add("")
    if ca["comentario_mais_popular"]:
        p = ca["comentario_mais_popular"]
        add(f"> [{p['timestamp']}] **{p['usuario']}:** {p['texto']}")
    add("")

    add("### Comentários Relevantes por Sentimento")
    add("")
    for cat in SENTIMENT_CATEGORIES:
        sel = [c for c in ca["comentarios"] if c["sentimento"] == cat][:3]
        if sel:
            add(f"**{cat.title()}**")
            for c in sel:
                add(f"- [{c['timestamp']}] {c['nome'] or c['usuario']}: {c['texto'][:100]}")
            add("")

    add("## 8. O que a legenda adiciona")
    add("")
    add("Com a transcrição (`audio.srt`) você consegue:")
    add("")
    add("- Gerar **capítulos automáticos** da live.")
    add("- Criar **títulos de clipes** com base no que foi falado.")
    add("- Medir **fala vs. reação do chat**.")
    add("- Detectar **momentos de ouro** (piadas, histórias, tretas, revelações).")
    add("- Fazer **busca semântica** na live: \"onde ele falou do licor de cavalo?\"")
    add("- Alimentar um **resumo pós-live**.")
    add("- Melhorar acessibilidade e SEO do VOD/YouTube.")
    add("")

    add("### Novos KPIs para o streamer")
    add("")
    add("- **Palavras por minuto (fala)** vs. **mensagens por minuto (chat)**.")
    add("- **Correlação fala ↔ chat**: quando você fala mais, o chat reage mais?")
    add("- **Picos de retenção**: momentos em que chat e fala explodem juntos.")
    add("- **Tópicos falados vs. comentados**: você falou de \"beco\", o chat comentou de quê?")
    add("- **Ganchos de conteúdo**: perguntas, histórias, piadas, revelações.")
    add("- **Alertas de risco**: menções sensíveis + aumento de mensagens.")
    add("- **Capítulos automáticos** e **clipes sugeridos** por pico de risada.")
    add("")

    add("### Novos KPIs para o viewer/ouvinte")
    add("")
    add("- **Transcrição pesquisável ao vivo**: \"onde falou de Pikachu?\"")
    add("- **Mapa da live**: becos, Kabukicho, Shibuya, estação, Yamanote.")
    add("- **Melhores momentos**: trechos com mais risada + chat explodindo.")
    add("- **Resumo em 1 minuto** e **ranking de bordões**.")
    add("- **Chat replay com legenda**: ver a reação do chat no momento exato.")
    add("")

    add("### Cuidados com a transcrição ASR")
    add("")
    add("- Normalize nomes: Baka, Julynha, Pikachu, Kabukicho, Shibuya, Yamanote.")
    add("- Use diarização (pyannote) para separar locutores.")
    add("- Corrija com Whisper large-v3 + word timestamps.")
    add("- Crie um dicionário de gírias: `kkk`, `LUL`, `baka`, `flop`, `arigathanks`.")
    add("")

    add("---")
    add("_Relatório gerado por preparar.py_")

    path.write_text("\n".join(lines), encoding="utf-8")


def write_csv(comments: list[dict], path: Path) -> None:
    import csv

    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["timestamp", "offset_segundos", "usuario", "nome", "sentimento", "confianca", "comentario"])
        for c in comments:
            writer.writerow(
                [
                    c["timestamp"],
                    c["offset"],
                    c["usuario"],
                    c["nome"],
                    c["sentimento"],
                    c["confianca"],
                    c["texto"],
                ]
            )


# --------------------------------------------------------------------------- #
# Mapa da live (marcos a cada 10 min) — extração de frames + geolocalização
# --------------------------------------------------------------------------- #

MAP_STOP_INTERVAL = 600  # 10 minutos

# Fallback determinístico: base em Shinjuku/Kabukichō (usado sem DEEPSEEK_API_KEY
# ou se a API falhar). Os marcos são interpolados numa rota plausível pela região.
MAP_FALLBACK_BASE = {"lat": 35.6932, "lng": 139.7030}
MAP_FALLBACK_NAMED = [
    (792, "Torrezão do Kabukichō", 35.6955, 139.7010),
    (1199, "Beco do pó", 35.6940, 139.7025),
    (2043, "Beco das lanternas", 35.6930, 139.7045),
    (6062, "Jardim vertical", 35.6910, 139.7018),
    (6521, "Estação (área iluminada)", 35.6900, 139.7006),
    (7539, "Plataforma do trem", 35.6897, 139.7005),
]

MAP_COLORS = [
    "#ec4899", "#f97316", "#f59e0b", "#84cc16", "#22c55e",
    "#2dd4bf", "#3b82f6", "#6366f1", "#a855f7", "#d946ef",
    "#f43f5e", "#eab308", "#14b8a6",
]


def _quote_at(blocks: list[dict], seconds: int, window: int = 90) -> str:
    """Frase falada mais próxima de `seconds` (dentro de ±window segundos)."""
    best: dict | None = None
    for b in blocks:
        if abs(b["start"] - seconds) <= window:
            if best is None or abs(b["start"] - seconds) < abs(best["start"] - seconds):
                best = b
    return best["text"] if best else ""


def _extract_map_frames(folder: Path, video_file: str | None, stops: list[dict]) -> None:
    """Extrai 1 frame por marco via ffmpeg (se houver vídeo).

    O vídeo não muda entre execuções: se a pasta mapa/ já tem os frames,
    não roda ffmpeg de novo.
    """
    if not video_file:
        return
    out_dir = folder / "mapa"
    existing = [p for p in out_dir.glob("marco_*.jpg")] if out_dir.is_dir() else []
    if len(existing) >= len(stops):
        print(f"  ✓ Mapa: {len(existing)} frames já extraídos — pulando ffmpeg")
        return
    out_dir.mkdir(exist_ok=True)
    src = folder / video_file
    for s in stops:
        fname = f"marco_{int(s['sec']):04d}.jpg"
        dest = out_dir / fname
        if dest.exists():
            continue
        try:
            subprocess.run(
                [
                    "ffmpeg", "-hide_banner", "-loglevel", "error",
                    "-ss", str(max(0, s["sec"])),
                    "-i", str(src),
                    "-frames:v", "1",
                    "-vf", "scale=640:-1",
                    "-q:v", "3",
                    str(dest),
                    "-y",
                ],
                check=False,
                timeout=60,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"  [!] ffmpeg falhou em {s['sec']}s: {exc}", file=sys.stderr)


def _geolocate_stops(folder: Path, stops: list[dict]) -> list[dict]:
    """Usa a API DeepSeek para nomear/posicionar os marcos; fallback local se falhar.

    O vídeo não muda, então o resultado é cacheado em mapa/geoloc.json.
    O retorno é uma lista de {sec, nome, lat, lng, cor} na MESMA ordem.
    """
    # âncoras nomeadas do fallback para casar com marcos próximos
    anchors = MAP_FALLBACK_NAMED
    cache_file = folder / "mapa" / "geoloc.json"

    def apply(by_sec: dict) -> None:
        for s in stops:
            hit = by_sec.get(str(int(s["sec"])))
            if hit and isinstance(hit, dict):
                s["nome"] = hit.get("nome", s["nome"])
                s["lat"] = hit.get("lat", s["lat"])
                s["lng"] = hit.get("lng", s["lng"])

    # 1) cache: se já geolocalizou antes, reusa (o vídeo não muda)
    if cache_file.exists():
        try:
            cached = json.loads(cache_file.read_text(encoding="utf-8"))
            keys = {int(k) for k in cached if str(k).isdigit()}
            if isinstance(cached, dict) and {int(s["sec"]) for s in stops} <= keys:
                apply(cached)
                print(f"  ✓ Mapa: geoloc em cache ({len(stops)} marcos) — pulando DeepSeek")
                return stops
        except Exception:  # noqa: BLE001
            pass

    if DEEPSEEK_API_KEY:
        prompt_lines = [
            "Você recebe a transcrição de uma live (passeio) do Baka Gaijin em Tóquio (Shinjuku/Kabukichō).",
            "Para CADA instante abaixo, responda com UMA linha JSON com:",
            '{"sec": <segundos>, "nome": "<lugar curto>", "lat": <float>, "lng": <float>, "confianca": "alta|media|baixa"}',
            "Regras:",
            "- lat/lng devem ser plausíveis para Shinjuku (35.68–35.71, 139.69–139.71).",
            "- Se a fala cita um lugar claro (estação, torre, beco, loja, gato 3D, Godzilla...), ancore nele.",
            "- Se não houver lugar claro, interpole ao longo de uma rota de passeio por Shinjuku.",
            "- Responda APENAS o JSON array, sem comentários.",
            "",
        ]
        for s in stops:
            q = s.get("frase") or "(sem fala)"
            prompt_lines.append(f"{s['sec']}s ({fmt_ts(s['sec'])}): {q}")
        prompt = "\n".join(prompt_lines)

        try:
            resp = _deepseek_chat(
                [
                    {"role": "system", "content": "Você é um geolocalizador de lives de Tóquio. Responda apenas JSON válido."},
                    {"role": "user", "content": prompt},
                ],
                max_tokens=2500,
            )
            if resp:
                m = re.search(r"\[[\s\S]*\]", resp)
                if m:
                    arr = json.loads(m.group(0))
                    by_sec = {}
                    for item in arr:
                        try:
                            sec = int(item["sec"])
                            lat = float(item.get("lat") or 0)
                            lng = float(item.get("lng") or 0)
                            if 35.65 <= lat <= 35.73 and 139.68 <= lng <= 139.73:
                                by_sec[str(sec)] = {
                                    "nome": str(item.get("nome") or f"{fmt_ts(sec)}"),
                                    "lat": lat,
                                    "lng": lng,
                                }
                        except Exception:  # noqa: BLE001
                            continue
                    if by_sec:
                        apply(by_sec)
                        cache_file.parent.mkdir(exist_ok=True)
                        cache_file.write_text(
                            json.dumps(by_sec, ensure_ascii=False, indent=2), encoding="utf-8"
                        )
                        print(f"  ✓ DeepSeek geolocalizou {len(by_sec)}/{len(stops)} marcos (cache salvo)")
                        return stops
        except Exception as exc:  # noqa: BLE001
            print(f"  [!] DeepSeek (geoloc) falhou: {exc}", file=sys.stderr)

    # fallback: âncoras nomeadas + interpolação
    for s in stops:
        sec = int(s["sec"])
        anchor = min(anchors, key=lambda a: abs(a[0] - sec))
        if abs(anchor[0] - sec) <= 180:
            s["nome"] = anchor[1]
            s["lat"], s["lng"] = anchor[2], anchor[3]
        else:
            # interpola entre base e âncora mais próxima
            s["nome"] = fmt_ts(sec)
            t = min(1.0, sec / 7744)
            s["lat"] = MAP_FALLBACK_BASE["lat"] - t * 0.004
            s["lng"] = MAP_FALLBACK_BASE["lng"] + (0.002 if (sec // 600) % 2 == 0 else -0.001)
    return stops


def build_map_stops(blocks: list[dict], duration_seconds: int) -> list[dict]:
    """Gera os marcos (1 a cada 10 min) com posição fallback. Barato e determinístico."""
    if duration_seconds <= 0:
        duration_seconds = 7744
    secs = list(range(5, duration_seconds, MAP_STOP_INTERVAL))
    if secs and secs[-1] < duration_seconds - 300:
        secs.append(min(duration_seconds - 60, duration_seconds - 1))
    stops: list[dict] = []
    for i, sec in enumerate(secs):
        stops.append(
            {
                "sec": sec,
                "nome": fmt_ts(sec),
                "frase": _quote_at(blocks, sec),
                "lat": MAP_FALLBACK_BASE["lat"],
                "lng": MAP_FALLBACK_BASE["lng"],
                "cor": MAP_COLORS[i % len(MAP_COLORS)],
                "img": f"mapa/marco_{int(sec):04d}.jpg",
            }
        )
    return stops


def ensure_map_assets(folder: Path, video_file: str | None, stops: list[dict]) -> list[dict]:
    """Etapas pesadas do mapa, executadas 1x (o vídeo não muda).

    - frames ffmpeg: pulados se a pasta mapa/ já estiver populada;
    - geoloc DeepSeek: carregada do cache mapa/geoloc.json quando existir.
    """
    _extract_map_frames(folder, video_file, stops)
    return _geolocate_stops(folder, stops)


def write_dashboard(report: dict, path: Path, srt_blocks: list[dict] | None = None) -> None:
    """Página HTML auto-contida (dados embutidos) com players + análise."""
    import json as _json

    input_files = sorted(
        p.name for p in FOLDER.iterdir()
        if p.is_file() and p.name not in {"relatorio.json", "relatorio.md", "relatorio.csv", "dashboard.html"}
    )

    video_file = next(
        (f for f in input_files if f.lower().endswith((".mp4", ".webm", ".mov", ".m4v"))),
        None,
    )
    audio_file = next(
        (f for f in input_files if f.lower().endswith((".wav", ".mp3", ".m4a", ".aac", ".ogg"))),
        None,
    )
    srt_file = next((f for f in input_files if f.lower().endswith(".srt")), None)

    # cortes físicos (gerados por scripts/cortar.py em <pasta>/cortes/)
    cortes_dir = FOLDER / "cortes"
    corte_files: list[str] = []
    if cortes_dir.is_dir():
        corte_files = sorted(p.name for p in cortes_dir.iterdir() if p.suffix.lower() == ".mp4")

    files_json = _json.dumps(
        {"video": video_file, "audio": audio_file, "srt": srt_file, "cortes": corte_files}
    )
    cues_json = _json.dumps(
        [{"s": b["start"], "e": b["end"], "t": b["text"]} for b in (srt_blocks or [])],
        ensure_ascii=False,
    )
    data_inline = _json.dumps(report, ensure_ascii=False).replace("</", "<\\/")

    # marcos do mapa (1 a cada 10 min) — frames + geoloc só rodam 1x (cache)
    duration = int((report.get("metricas") or {}).get("duration_seconds") or 0)
    map_stops = build_map_stops(srt_blocks or [], duration)
    map_stops = ensure_map_assets(FOLDER, video_file, map_stops)
    map_stops_json = _json.dumps(map_stops, ensure_ascii=False)

    html = r"""<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Dashboard — Análise de VOD</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css" />
<script>
  tailwind.config = { corePlugins: { preflight: false } };
</script>
<style>
  :root {
    --bg: #0f172a; --panel: #1e293b; --border: #334155;
    --text: #e2e8f0; --muted: #94a3b8; --accent: #a855f7; --accent2: #22c55e;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
    background: var(--bg); color: var(--text); padding: 24px; line-height: 1.5;
  }
  h1 { font-size: 1.5rem; margin-bottom: 4px; }
  h2 { font-size: 1.1rem; margin: 24px 0 12px; color: #cbd5e1;
       border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  .sub { color: var(--muted); font-size: .85rem; margin-bottom: 20px; }
  .back-link {
    display: inline-block; margin-bottom: 14px; color: #a5b4fc;
    font-size: .82rem; text-decoration: none; font-weight: 600;
  }
  .back-link:hover { color: #c7d2fe; text-decoration: underline; }
  .grid { display: grid; gap: 14px; }
  .cards { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
  .card {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 12px; padding: 14px;
  }
  .card .label { font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .card .value { font-size: 1.35rem; font-weight: 700; margin-top: 4px; }
  .card .delta { font-size: .8rem; margin-top: 2px; }
  .up { color: #4ade80; } .down { color: #f87171; }
  .two { grid-template-columns: 1fr 1fr; }
  @media (max-width: 900px) { .two { grid-template-columns: 1fr; } }
  table { width: 100%; border-collapse: collapse; font-size: .82rem; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 600; font-size: .72rem; text-transform: uppercase; }
  canvas { max-height: 320px; }
  .tag {
    display: inline-block; padding: 2px 8px; border-radius: 999px;
    font-size: .72rem; margin-right: 4px; background: #334155; color: #e2e8f0;
  }
  .tag.positivo { background:#14532d; } .tag.negativo { background:#7f1d1d; }
  .tag.engraçado { background:#7c2d12; } .tag.frustrado { background:#713f12; }
  .tag.inspirado { background:#1e3a8a; } .tag.confuso { background:#3b0764; }
  .tag.neutro { background:#334155; } .tag.neutro\/pergunta { background:#134e4a; }
    .quote { border-left: 3px solid var(--accent); padding: 8px 12px; background: var(--panel);
           border-radius: 0 8px 8px 0; margin: 8px 0; font-size: .85rem; }
  .filters { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
  .filters button {
    background: var(--panel); color: var(--text); border: 1px solid var(--border);
    border-radius: 999px; padding: 5px 12px; font-size: .75rem; cursor: pointer;
    transition: all .15s ease;
  }
  .filters button:hover { background: #263449; transform: translateY(-1px); }
  .filters button.active { background: var(--accent); border-color: var(--accent); color: white; box-shadow: 0 4px 14px rgba(168,85,247,.4); }
  .muted { color: var(--muted); font-size: .78rem; }
  ul { list-style: none; }
  li { padding: 6px 0; border-bottom: 1px solid #1e293b; font-size: .85rem; }
  .file {
    display: inline-block; margin: 3px 6px 3px 0; padding: 4px 10px;
    background: #0f172a; border: 1px solid var(--border); border-radius: 8px; font-size: .78rem;
  }
  .player-wrap { position: sticky; top: 12px; z-index: 50; width: 100%; margin: 0; }
  .player-area { display: grid; grid-template-columns: 1fr; gap: 14px; }
  .player-video-shell { width: 100%; max-width: 960px; margin: 0 auto; }
  @media (min-width: 961px) {
    .player-video-shell { width: 960px; }
  }
  .player {
    background: #000; border: 1px solid var(--border); border-radius: 12px;
    overflow: hidden; position: relative; box-shadow: 0 10px 30px rgba(0,0,0,.5);
    width: 100%; margin: 0 auto;
  }
  video, audio { width: 100%; height: auto; display: block; margin: 0 auto; background: #000; }
  video { aspect-ratio: 16/9; object-fit: contain; }
  .player video { object-fit: contain; }
  .media-error {
    background: #1e293b; color: #fbbf24; padding: 18px; text-align: center;
    font-size: .82rem; display: none;
  }
  .media-error a { color: #a5b4fc; text-decoration: underline; }
  .media-error code { background: #0f172a; padding: 2px 6px; border-radius: 4px; }
  .subtitle-overlay {
    position: absolute; left: 50%; transform: translateX(-50%);
    bottom: 56px; width: 92%; max-width: 900px; text-align: center;
    background: rgba(0,0,0,.72); color: #fff; font-size: 1.15rem; line-height: 1.35;
    padding: 8px 14px; border-radius: 8px; pointer-events: none;
    white-space: pre-wrap; text-shadow: 0 1px 2px #000;
    backdrop-filter: blur(2px);
  }
  .player.timeline { display: grid; grid-template-columns: 1fr; gap: 8px; padding: 10px 12px; background: #0b1120; }
  .timebar {
    -webkit-appearance: none; appearance: none; width: 100%; height: 6px;
    border-radius: 3px; background: #334155; outline: none; cursor: pointer;
  }
  .timebar::-webkit-slider-thumb {
    -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%;
    background: var(--accent); border: 2px solid #fff; cursor: pointer;
    box-shadow: 0 0 0 3px rgba(168,85,247,.3);
  }
  .btn {
    background: var(--panel); color: var(--text); border: 1px solid var(--border);
    border-radius: 8px; padding: 6px 12px; font-size: .78rem; cursor: pointer;
    transition: all .15s ease;
  }
  .btn:hover { background: #263449; transform: translateY(-1px); }
  .btn.active { background: var(--accent); border-color: var(--accent); color: #fff; box-shadow: 0 4px 14px rgba(168,85,247,.4); }
  .segment { display: inline-flex; align-items: center; gap: 6px; }
  .comment-feed {
    background: #0b1120; border: 1px solid var(--border); border-radius: 12px;
    padding: 12px; max-height: 480px; overflow-y: auto;
  }
  .comment-feed li { display: flex; gap: 8px; align-items: flex-start; }
  .comment-feed .ts { color: var(--accent); font-variant-numeric: tabular-nums; white-space: nowrap; font-size: .75rem; }
  .comment-feed .cbody { flex: 1; font-size: .82rem; }
  .comment-feed .cuser { color: #cbd5e1; font-weight: 600; }
  .comment-feed li.new { animation: fadein .25s ease; }
  @keyframes fadein { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  .corte-player { display:flex; flex-direction:column; align-items:center; width:100%; }
  .corte-player video, .corte-player audio { width:100%; display:block; border-radius:8px; background:#000; }
  .corte-player video { aspect-ratio:16/9; object-fit:contain; }
  .corte-player audio { height:40px; }
  .chapters-bar { display:flex; gap:6px; overflow-x:auto; padding:4px 0; flex-wrap:nowrap; }
  .chapter-chip {
    flex:0 0 auto; display:inline-block; cursor:pointer; white-space:nowrap;
    background:var(--panel); border:1px solid var(--border); border-radius:999px;
    padding:4px 12px; font-size:.72rem; color:#cbd5e1; transition:all .15s ease;
  }
  .chapter-chip:hover { background:#263449; transform:translateY(-1px); }
  .chapter-chip.active { background:var(--accent); border-color:var(--accent); color:#fff; }
  .participantes { display:grid; grid-template-columns:repeat(auto-fill,minmax(190px,1fr)); gap:6px; max-height:480px; overflow-y:auto; }
  .participante {
    display:flex; align-items:center; gap:8px; padding:7px 10px; border-radius:10px;
    background:var(--panel2); border:1px solid var(--border);
  }
  .p-name { flex:1; font-size:.8rem; color:#e2e8f0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .p-count { font-size:.72rem; color:var(--muted); font-weight:700; }
  .comando-item { margin-top:8px; padding:8px 10px; border-radius:10px; background:#0f172a; border:1px solid var(--border); }
  .comando-head { display:flex; justify-content:space-between; align-items:center; font-size:.8rem; }
  .comando-ex { font-size:.72rem; font-style:italic; margin-top:3px; }
  .comando-resp { font-size:.74rem; color:#a7f3d0; margin-top:4px; background:rgba(16,185,129,.08); padding:5px 8px; border-radius:8px; border-left:2px solid #10b981; }
  ::-webkit-scrollbar { width: 8px; }
  ::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }

  /* ---- mapa da live ---- */
  #liveMap { height: 420px; width: 100%; background: #0f172a; border-radius: 12px; z-index: 0; }
  .map-shell { position: relative; }
  .map-legend {
    position:absolute; bottom:12px; left:12px; z-index:1000; max-width:250px;
    background:rgba(15,23,42,.92); border:1px solid var(--border); border-radius:10px;
    padding:8px 10px; font-size:.7rem; color:var(--muted); pointer-events:none;
  }
  .map-legend b { color:#e2e8f0; }
  .map-stops { display:flex; flex-wrap:wrap; gap:8px; }
  .map-stop {
    display:inline-flex; align-items:center; gap:6px; cursor:pointer;
    background:var(--panel2); border:1px solid var(--border); border-radius:999px;
    padding:5px 12px; font-size:.75rem; color:#cbd5e1; transition:all .15s ease;
  }
  .map-stop:hover { background:#263449; transform:translateY(-1px); border-color:var(--accent); }
  .map-stop.active { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent); }
  .map-stop .dot { width:9px; height:9px; border-radius:50%; flex:none; }
  .leaflet-popup-content-wrapper {
    background:#1e293b; color:#e2e8f0; border:1px solid var(--border); border-radius:12px;
  }
  .leaflet-popup-tip { background:#1e293b; }
  .leaflet-popup-content { margin:12px 14px; }
  .pop { min-width:210px; }
  .pop img { width:100%; height:100px; object-fit:cover; border-radius:8px; margin-bottom:8px; display:block; }
  .pop .pt { font-size:.84rem; font-weight:800; margin-bottom:2px; }
  .pop .pts { font-size:.7rem; color:var(--accent); margin-bottom:5px; }
  .pop .pq { font-size:.75rem; color:var(--muted); font-style:italic; margin-bottom:6px; }
  .pop .pgm {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: .74rem; color: #93c5fd; text-decoration: none; margin-top: 2px;
  }
  .pop .pgm:hover { color: #bfdbfe; text-decoration: underline; }
  .gmaps-btn { display: inline-flex; align-items: center; gap: 6px; text-decoration: none; }
  .streetview-shell { margin-top: 14px; }
  .streetview-shell .sv-title {
    font-size: .78rem; color: var(--muted); margin-bottom: 8px;
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  }
  .streetview-shell .sv-title i { color: var(--accent); }
  .streetview-shell iframe {
    width: 100%; height: 340px; border: 0; border-radius: 12px; background: #0f172a;
  }
  .leaflet-control-zoom a { background:#1e293b; color:#e2e8f0; border-color:var(--border); }
  .leaflet-control-zoom a:hover { background:#263449; }

  /* ---- player com a mesma altura do mapa ---- */
  .player-video { height: 420px; }
  .player-video video { height: 100%; width: 100%; object-fit: contain; }

  /* ---- índice da página (TOC) — menu horizontal fixo no topo ---- */
  .toc {
    position: sticky; top: 0; z-index: 60;
    display: flex; align-items: center; gap: 10px;
    background: rgba(15,23,42,.96); border: 1px solid var(--border);
    border-bottom: 1px solid #334155;
    border-radius: 0; padding: 8px 24px; margin: 0 0 20px;
    backdrop-filter: blur(8px);
  }
  .toc-label {
    flex: none; display: flex; align-items: center; gap: 6px;
    font-size: .72rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
    color: var(--accent); white-space: nowrap;
  }
  .toc-nav {
    display: flex; align-items: center; gap: 4px; overflow-x: auto;
    scrollbar-width: thin; padding: 4px 2px;
  }
  .toc-nav::-webkit-scrollbar { height: 6px; }
  .toc a {
    flex: 0 0 auto; display: flex; align-items: center; gap: 6px;
    font-size: .72rem; color: #cbd5e1; text-decoration: none;
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 999px; padding: 5px 11px; transition: all .15s ease;
  }
  .toc a i { font-size: .8rem; flex: none; color: var(--accent); width: 14px; text-align: center; }
  .toc a:hover { background:#263449; border-color: var(--accent); transform: translateY(-1px); color:#fff; }

  /* ---- seções colapsáveis ---- */
  h2.topic-heading { cursor: pointer; user-select: none; display: flex; align-items: center; gap: 8px; }
  h2.topic-heading .chev { transition: transform .2s ease; font-size: .7rem; color: var(--muted); flex: none; width: 14px; }
  h2.topic-heading.collapsed .chev { transform: rotate(-90deg); }
  .section-body { overflow: hidden; }
  .section-body.hidden { display: none; }
</style>
</head>
<body class="min-h-screen bg-slate-950 text-slate-100 antialiased">
  <nav class="toc" id="toc"></nav>

  <div class="max-w-7xl mx-auto px-4 sm:px-6">
  <a href="../index.html" class="back-link">← Voltar ao índice</a>
  <h1 id="title" class="text-2xl font-bold tracking-tight bg-gradient-to-r from-purple-300 via-slate-100 to-indigo-300 bg-clip-text text-transparent">Análise de VOD</h1>
  <div class="sub" id="subtitle">Carregando…</div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="player">Player de Vídeo &amp; Áudio</h2>
  <div style="display:flex;gap:8px;margin-bottom:12px">
    <button class="btn active" id="modeVideo" onclick="setPlayerMode('video')">🎬 Vídeo</button>
    <button class="btn" id="modeAudio" onclick="setPlayerMode('audio')">🎧 Somente Áudio</button>
  </div>
  <div class="player-area">
    <div class="player-wrap" id="videoWrap">
      <div class="player-video-shell">
        <div class="player player-video">
          <video id="videoPlayer" controls playsinline></video>
          <div class="media-error" id="videoError"></div>
          <div class="subtitle-overlay" id="videoSubs"></div>
        </div>
      </div>
      <div class="player timeline">
        <input type="range" class="timebar" id="videoSeek" min="0" max="100" step="0.1" value="0" />
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span class="muted" id="videoTime">0:00 / 0:00</span>
          <button class="btn" onclick="setPlaybackRate(-0.5)">-0.5×</button>
          <button class="btn" onclick="setPlaybackRate(0.5)">+0.5×</button>
          <button class="btn active" id="btnCc" onclick="toggleCaptions()">Legendas: ON</button>
          <span class="segment"><span class="tag neutro" id="videoNowLabel">—</span><span class="muted">agora</span></span>
        </div>
        <div class="chapters-bar" id="chaptersBar"></div>
      </div>
    </div>
    <div class="player-wrap" id="audioWrap">
      <div class="player-video-shell">
        <div class="player player-video" style="display:flex;align-items:center;justify-content:center;padding:12px">
          <audio id="audioPlayer" controls style="border-radius:8px;width:100%"></audio>
          <div class="media-error" id="audioError"></div>
          <div class="subtitle-overlay" style="position:static;transform:none;width:100%;max-width:none;margin-top:10px" id="audioSubs"></div>
        </div>
      </div>
      <div class="player timeline">
        <input type="range" class="timebar" id="audioSeek" min="0" max="100" step="0.1" value="0" />
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span class="muted" id="audioTime">0:00 / 0:00</span>
          <button class="btn" onclick="setPlaybackRate(-0.5)">-0.5×</button>
          <button class="btn" onclick="setPlaybackRate(0.5)">+0.5×</button>
          <span class="segment"><span class="tag neutro" id="audioNowLabel">—</span><span class="muted">agora</span></span>
        </div>
      </div>
    </div>
  </div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="mapa"><i class="fa-solid fa-map-location-dot"></i> Mapa da Live — onde o Baka passou</h2>
  <div class="card" style="margin-bottom:14px">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
      <span class="muted" id="mapInfo">Trajeto reconstruído (posições aproximadas). Clique num marco para pular o player.</span>
      <button class="btn" onclick="mapFitAll()">Fit em tudo</button>
    </div>
    <div class="grid two">
      <div class="map-shell"><div id="liveMap"></div>
        <div class="map-legend"><b>Legenda</b><br/>🟣 rota (aprox.) · ⭐ marcos a cada 10 min</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px">
        <div class="map-stops" id="mapStops"></div>
        <div class="muted" id="mapNow">Escolha um marco para assistir o trecho.</div>
        <a class="btn gmaps-btn" id="mapGmapsLink" href="#" target="_blank" rel="noopener" style="display:none">
          <i class="fa-solid fa-location-dot"></i> Abrir no Google Maps
        </a>
      </div>
    </div>
    <div class="streetview-shell" id="streetviewShell" style="display:none">
      <div class="sv-title"><i class="fa-solid fa-street-view"></i> Street View: <span id="streetviewTitle"></span></div>
      <iframe id="streetviewFrame" title="Google Street View" loading="lazy" allowfullscreen></iframe>
    </div>
  </div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="replay">Replay dos Comentários (ao vivo)</h2>
  <div class="card">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
      <button class="btn active" id="btnFeed" onclick="toggleFeed()">Feed: ON</button>
      <button class="btn" onclick="resetFeed()">Reiniciar replay</button>
      <label class="muted" style="display:flex;gap:6px;align-items:center">
        <input type="checkbox" id="feedFilter" checked onchange="buildFeed()" /> só mostrados na timeline
      </label>
      <span class="muted" id="feedInfo"></span>
    </div>
    <ul class="comment-feed" id="feed"></ul>
  </div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="kpis">Métricas de Performance</h2>
  <div class="grid cards" id="kpisBody"></div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="bench">Comparação com o Canal</h2>
  <div class="grid cards" id="benchBody"></div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="sent">Sentimento dos Comentários</h2>
  <div class="grid two">
    <div class="card"><canvas id="chartSent"></canvas></div>
    <div class="card" id="sentTable"></div>
  </div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="temas">Temas dos Comentários</h2>
  <div class="grid two">
    <div class="card"><canvas id="chartThemes"></canvas></div>
    <div class="card" id="themesList"></div>
  </div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="resumo">Resumo do Conteúdo</h2>
  <div id="resumoBody"></div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="capitulos">Capítulos Automáticos</h2>
  <div id="capitulosBody"></div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="fala-chat">Fala vs. Chat (por minuto)</h2>
  <div id="engKpis" style="margin-bottom:14px"></div>
  <div class="grid two">
    <div class="card"><canvas id="chartFalaChat"></canvas></div>
    <div class="card" id="engPicos"></div>
  </div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="sent-tempo">Sentimento ao Longo do Tempo</h2>
  <div class="card" style="margin-bottom:14px"><canvas id="chartSentimento"></canvas></div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="risadas">Risadas &amp; Perguntas por Minuto</h2>
  <div class="card" style="margin-bottom:14px"><canvas id="chartRisadas"></canvas></div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="wordcloud">Nuvem de Palavras (fala + chat)</h2>
  <div class="card" id="wordcloudBody" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;min-height:120px"></div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="heatmap">Heatmap: Minuto × Sentimento</h2>
  <div class="card" id="heatmapBody" style="overflow-x:auto"></div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="segmentos">Segmentos da Live (quartos)</h2>
  <div class="card"><canvas id="chartSegmentos"></canvas></div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="usuarios">Usuários Únicos &amp; Top Comentaristas</h2>
  <div class="grid two">
    <div class="card"><canvas id="chartUsuarios"></canvas></div>
    <div class="card" id="topUsuarios"></div>
  </div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="sent-tema">Sentimento por Tema (cruzamento)</h2>
  <div class="card"><canvas id="chartSentTema"></canvas></div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="retencao">Retenção de Audiência (estimada)</h2>
  <div class="card"><canvas id="chartRetencao"></canvas></div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="monetizacao">Monetização &amp; Comandos</h2>
  <div class="grid two">
    <div class="card"><canvas id="chartMonetizacao"></canvas></div>
    <div class="card" id="comandosList"></div>
  </div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="receita">Previsão de Receita</h2>
  <div id="previsaoReceita" style="margin-bottom:14px"></div>
  <div class="card"><canvas id="chartTiers"></canvas></div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="lag">Correlação Defasada (fala → chat com lag)</h2>
  <div class="card"><canvas id="chartLag"></canvas></div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="radar">Radar do Streamer</h2>
  <div class="card"><canvas id="chartRadar"></canvas></div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="velocidade">Velocidade do Chat (média móvel 5min)</h2>
  <div class="card"><canvas id="chartVelocidade"></canvas></div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="interacao">Distribuição de Interação &amp; Emojis</h2>
  <div class="grid two">
    <div class="card"><canvas id="chartInteracao"></canvas></div>
    <div class="card" id="emojisList"></div>
  </div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="topicos">Tópicos Falados vs. Comentados</h2>
  <div class="grid two" id="topicosGrid"></div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="frases">Frases Completas Faladas vs. Comentadas</h2>
  <div class="grid two" id="frasesGrid"></div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="ganchos">Ganchos de Conteúdo</h2>
  <div id="ganchosBody"></div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="alertas">Top Palavrões</h2>
  <div id="alertasBody"></div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="bordoes">Ranking de Bordões</h2>
  <div id="bordoesBody"></div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="resumo1min">Resumo em 1 minuto</h2>
  <div id="resumo1minBody"></div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="perguntas">Perguntas Frequentes</h2>
  <div id="perguntasFreq"></div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="cortes">Cortes Virais Sugeridos</h2>
  <div id="cortesBody"></div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="popular">Comentário Mais Popular</h2>
  <div id="popularBody"></div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="comentarios">Comentários Relevantes por Sentimento</h2>
  <div class="filters" id="sentFilters"></div>
  <div id="comments"></div>

  <h2 class="text-lg font-semibold text-slate-200 border-b border-slate-800 pb-2 mt-8 mb-4" id="participantes">Todos os Participantes do Chat</h2>
  <div class="card" style="margin-bottom:14px">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
      <input id="participanteBusca" class="btn" style="flex:1;text-align:left" placeholder="Filtrar participante..." oninput="renderParticipantes()" />
      <span class="muted" id="participanteCount"></span>
    </div>
    <div class="participantes" id="participantesBody"></div>
  </div>
  </div>

<script>
const DATA = __DATA_INLINE__;
const FILES = __FILES_JSON__;
const CUES = __CUES_JSON__;
const MAP_STOPS = __MAP_STOPS_JSON__;
const SENT = ["positivo","neutro","neutro/pergunta","negativo","engraçado","frustrado","inspirado","confuso"];
const COLORS = {
  positivo:"#22c55e", neutro:"#94a3b8", "neutro/pergunta":"#2dd4bf",
  negativo:"#ef4444", engraçado:"#f97316", frustrado:"#eab308",
  inspirado:"#3b82f6", confuso:"#a855f7"
};
let R = DATA;
let currentSent = "todos";

/* ---- players / legendas / replay ---- */
const V = { el: null, start: 0, rate: 1 };
const A = { el: null, start: 0, rate: 1 };
let captionsOn = true;
let feedOn = true;
let feedTimer = null;
let feedIndex = 0;
let lastLabel = "";

function esc(s){return (s||"").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
function fmt(n){ if(n>=1e6) return (n/1e6).toFixed(2)+"M"; if(n>=1e3) return (n/1e3).toFixed(1)+"k"; return n.toLocaleString("pt-BR"); }
function fmtClock(sec){
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
  return (h>0 ? h+":"+String(m).padStart(2,"0") : m) + ":" + String(s).padStart(2,"0");
}
function delta(v){ if(v==null) return ""; const cls = v>=0?"up":"down"; const s = v>=0?"+":""; return `<span class="delta ${cls}">${s}${v}% vs. canal</span>`; }

function currentCue(media){
  const t = media.el ? (media.el.currentTime - media.start) : 0;
  for (let i = CUES.length - 1; i >= 0; i--) {
    if (t >= CUES[i].s && t <= CUES[i].e) return CUES[i];
  }
  return null;
}

function fmtCue(sec){
  const m = Math.floor(sec/60), s = Math.floor(sec%60);
  return m + ":" + String(s).padStart(2,"0");
}

function updateSubs(media, overlayId, labelId){
  const cue = currentCue(media);
  const ov = document.getElementById(overlayId);
  const lb = document.getElementById(labelId);
  if (!ov) return;
  // usa visibility (não display) para não alterar o layout e evitar o "pulo" da página
  if (captionsOn && cue) {
    if (ov.textContent !== cue.t) ov.textContent = cue.t;
    ov.style.visibility = "visible";
  } else {
    if (ov.textContent !== "") ov.textContent = "";
    ov.style.visibility = "hidden";
  }
  if (lb) lb.textContent = cue ? fmtCue(cue.s) + "–" + fmtCue(cue.e) : "—";
}

function updateSeek(media, barId, timeId){
  const bar = document.getElementById(barId);
  const time = document.getElementById(timeId);
  if (!media.el || !bar || !time) return;
  if (media.el.duration) bar.max = String(media.el.duration);
  if (!bar.matches(":active")) bar.value = String(media.el.currentTime);
  time.textContent = fmtClock(media.el.currentTime) + " / " + fmtClock(media.el.duration || 0);
}

function syncSeekBar(barId, seconds){
  const bar = document.getElementById(barId);
  if (bar && !bar.matches(":active")) bar.value = String(seconds);
}

function setPlaybackRate(delta){
  const media = (V.el && !V.el.paused) ? V : A;
  if (!media.el) return;
  media.rate = Math.min(3, Math.max(0.5, media.rate + delta));
  media.el.playbackRate = media.rate;
  showFlash("Velocidade " + media.rate.toFixed(1) + "×");
}

function showFlash(msg){
  let f = document.getElementById("flash");
  if (!f) {
    f = document.createElement("div");
    f.id = "flash";
    f.style.cssText = "position:fixed;bottom:20px;right:20px;background:#a855f7;color:#fff;padding:8px 14px;border-radius:8px;z-index:99;font-size:.85rem";
    document.body.appendChild(f);
  }
  f.textContent = msg;
  clearTimeout(f._t);
  f._t = setTimeout(() => (f.style.display = "none"), 1200);
  f.style.display = "";
}

function toggleCaptions(){
  captionsOn = !captionsOn;
  document.getElementById("btnCc").classList.toggle("active", captionsOn);
  document.getElementById("btnCc").textContent = "Legendas: " + (captionsOn ? "ON" : "OFF");
  updateSubs(V, "videoSubs", "videoNowLabel");
  updateSubs(A, "audioSubs", "audioNowLabel");
}

function toggleFeed(){
  feedOn = !feedOn;
  document.getElementById("btnFeed").classList.toggle("active", feedOn);
  if (!feedOn) {
    clearInterval(feedTimer);
    document.getElementById("feedInfo").textContent = "pausado";
  }
}

function resetFeed(){
  feedIndex = 0;
  const ul = document.getElementById("feed");
  ul.innerHTML = "";
  ul._renderedCount = 0;
  document.getElementById("feedInfo").textContent = "replay reiniciado";
  const media = (V.el && !V.el.paused) ? V : ((A.el && !A.el.paused) ? A : null);
  if (media && media.el && media.el.currentTime > 0) {
    media.el.currentTime = 0;
  }
}

function buildFeed(){
  const filter = document.getElementById("feedFilter").checked;
  const all = R.comentarios.comentarios;
  let list = all;
  if (filter) {
    const starts = V.el ? V.start : 0;
    const ends = V.el && V.el.duration ? V.start + V.el.duration : starts + (R.metricas.duration_seconds || 0);
    list = all.filter(c => c.offset >= starts && c.offset <= ends);
  }
  const ul = document.getElementById("feed");
  const slice = list.slice(-300).reverse();  // mais recentes primeiro
  ul.innerHTML = slice.map(c =>
    `<li><span class="ts">${c.timestamp}</span>
      <span class="cbody"><span class="cuser">${esc(c.nome || c.usuario)}</span> <span class="tag ${c.sentimento}">${c.sentimento}</span><br>${esc(c.texto)}</span></li>`
  ).join("") || "<li class='muted'>Nenhum comentário no intervalo.</li>";
  ul._renderedCount = list.length;
  document.getElementById("feedInfo").textContent = list.length + " comentário(s)";
}

function pumpFeed(){
  const all = R.comentarios.comentarios;
  const media = (V.el && !V.el.paused) ? V : ((A.el && !A.el.paused) ? A : null);
  if (!media || !media.el) return;
  const t = media.el.currentTime;
  const ul = document.getElementById("feed");
  if (!feedOn || !ul) return;

  // avança o ponteiro até o tempo atual
  while (feedIndex < all.length && all[feedIndex].offset <= t) {
    feedIndex++;
  }

  // se o ponteiro retrocedeu (seek para trás), reinicia o feed
  if (feedIndex < ul._renderedCount) {
    ul.innerHTML = "";
    ul._renderedCount = 0;
  }

  const alreadyRendered = ul._renderedCount || 0;
  const newItems = all.slice(alreadyRendered, feedIndex);
  if (newItems.length === 0) {
    document.getElementById("feedInfo").textContent = feedIndex + " / " + all.length + " exibidos";
    return;
  }

  // insere os novos no topo, um a um (mais recente primeiro)
  for (let i = newItems.length - 1; i >= 0; i--) {
    const c = newItems[i];
    const li = document.createElement("li");
    li.className = "new";
    li.innerHTML = `<span class="ts">${c.timestamp}</span>
      <span class="cbody"><span class="cuser">${esc(c.nome || c.usuario)}</span> <span class="tag ${c.sentimento}">${c.sentimento}</span><br>${esc(c.texto)}</span>`;
    ul.prepend(li);
  }

  // mantém no máx. 30 itens visíveis
  while (ul.children.length > 30) {
    ul.removeChild(ul.lastChild);
  }
  ul._renderedCount = feedIndex;
  ul.scrollTop = 0;
  document.getElementById("feedInfo").textContent = feedIndex + " / " + all.length + " exibidos";
}

function wireMedia(media, id, barId, timeId, overlayId, labelId){
  const el = document.getElementById(id);
  if (!el) return;
  media.el = el;
  const errBox = document.getElementById(id === "videoPlayer" ? "videoError" : "audioError");
  const kind = id === "videoPlayer" ? "vídeo" : "áudio";
  el.addEventListener("error", () => {
    if (!errBox) return;
    errBox.style.display = "block";
    errBox.innerHTML =
      "Não foi possível reproduzir o " + kind + " neste navegador. " +
      "Abra o arquivo diretamente: <a href='" + esc(el.src) + "'>" + esc(decodeURIComponent(el.src.split('/').pop() || '')) + "</a>. " +
      "Dica: para o MP4, sirva a pasta via <code>python3 -m http.server</code> ou abra em Safari/Chrome.";
  });
  el.addEventListener("loadedmetadata", () => {
    if (!V.start) V.start = 0;
    updateSeek(media, barId, timeId);
    buildFeed();
  });
  el.addEventListener("timeupdate", () => {
    updateSubs(media, overlayId, labelId);
    updateSeek(media, barId, timeId);
    pumpFeed();
  });
  el.addEventListener("seeked", () => {
    updateSubs(media, overlayId, labelId);
    updateSeek(media, barId, timeId);
    if (media.el) {
      const t = media.el.currentTime;
      const before = allUpTo(t);
      if (t < (media._lastT || 0)) {
        // voltou no tempo -> reinicia o feed a partir desse ponto
        feedIndex = before;
        const ul = document.getElementById("feed");
        ul.innerHTML = "";
        ul._renderedCount = 0;
      } else {
        feedIndex = Math.max(feedIndex, before);
      }
      media._lastT = t;
    }
  });
  const bar = document.getElementById(barId);
  bar.addEventListener("input", () => {
    if (media.el) media.el.currentTime = Number(bar.value);
  });
  bar.addEventListener("change", () => {
    if (media.el) media.el.currentTime = Number(bar.value);
  });
}

function allUpTo(t){
  const all = R.comentarios.comentarios;
  let i = 0;
  while (i < all.length && all[i].offset <= t) i++;
  return i;
}

function initPlayers(){
  if (FILES.video) document.getElementById("videoPlayer").src = FILES.video;
  if (FILES.audio) document.getElementById("audioPlayer").src = FILES.audio;
  wireMedia(V, "videoPlayer", "videoSeek", "videoTime", "videoSubs", "videoNowLabel");
  wireMedia(A, "audioPlayer", "audioSeek", "audioTime", "audioSubs", "audioNowLabel");
  if (!FILES.video && !FILES.audio) {
    document.getElementById("videoPlayer").style.display = "none";
  }

  // sincroniza: quando um player começa, pausa o outro
  [["videoPlayer", "audioPlayer"], ["audioPlayer", "videoPlayer"]].forEach(([a, b]) => {
    const ea = document.getElementById(a);
    const eb = document.getElementById(b);
    if (ea && eb) {
      ea.addEventListener("play", () => { if (!eb.paused) eb.pause(); });
    }
  });

  // modo inicial: vídeo se disponível, senão áudio
  if (FILES.video) setPlayerMode("video");
  else if (FILES.audio) setPlayerMode("audio");
  else setPlayerMode("none");

  feedIndex = 0;
  buildFeed();
  renderChaptersBar();
  setInterval(() => pumpFeed(), 250);
}

function renderChaptersBar() {
  const bar = document.getElementById("chaptersBar");
  if (!bar) return;
  const caps = (R.conteudo && R.conteudo.capitulos) || [];
  if (!caps.length) { bar.innerHTML = ""; return; }
  bar.innerHTML = caps.map((ch, i) =>
    `<button class="chapter-chip" data-i="${i}" onclick="seekChapter(${i})">${esc(ch.inicio)} · ${esc(ch.titulo)}</button>`
  ).join("");
}

function seekChapter(i) {
  const caps = (R.conteudo && R.conteudo.capitulos) || [];
  const ch = caps[i];
  if (!ch) return;
  const media = (V.el && !V.el.paused) ? V : ((A.el && !A.el.paused) ? A : (FILES.video ? V : A));
  if (media.el && ch.inicio_sec != null) {
    media.el.currentTime = ch.inicio_sec;
  }
  highlightChapter(i);
}

function highlightChapter(i) {
  document.querySelectorAll(".chapter-chip").forEach((b, j) => {
    b.classList.toggle("active", j === i);
  });
}

function setPlayerMode(mode) {
  const videoWrap = document.getElementById("videoWrap");
  const audioWrap = document.getElementById("audioWrap");
  const btnV = document.getElementById("modeVideo");
  const btnA = document.getElementById("modeAudio");

  if (mode === "video") {
    videoWrap.style.display = "";
    audioWrap.style.display = "none";
    btnV.classList.add("active");
    btnA.classList.remove("active");
    if (A.el) A.el.pause();
  } else if (mode === "audio") {
    videoWrap.style.display = "none";
    audioWrap.style.display = "";
    btnV.classList.remove("active");
    btnA.classList.add("active");
    if (V.el) V.el.pause();
  } else {
    // nenhum disponível
    videoWrap.style.display = FILES.video ? "" : "none";
    audioWrap.style.display = FILES.audio ? "" : "none";
  }
}

// ---------------------------------------------------------------------------
// MAPA DA LIVE (Leaflet + OpenStreetMap) — marcos a cada 10 min
// ---------------------------------------------------------------------------
let liveMap = null;
let mapMarkers = {};

function initLiveMap() {
  const el = document.getElementById("liveMap");
  if (!el || typeof L === "undefined" || !MAP_STOPS || !MAP_STOPS.length) return;
  liveMap = L.map(el, { zoomControl: true }).setView(
    [MAP_STOPS[0].lat, MAP_STOPS[0].lng], 16
  );
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap"
  }).addTo(liveMap);

  const route = MAP_STOPS.map(s => [s.lat, s.lng]);
  L.polyline(route, { color:"#a855f7", weight:4, opacity:.75, dashArray:"6,8" }).addTo(liveMap);

  function iconFor(color) {
    return L.divIcon({
      className: "",
      html: `<div style="width:22px;height:22px;border-radius:50% 50% 50% 0;background:${color};
        border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.6);transform:rotate(-45deg);
        display:flex;align-items:center;justify-content:center">
        <div style="transform:rotate(45deg);font-size:10px">⭐</div></div>`,
      iconSize: [22, 22], iconAnchor: [11, 22], popupAnchor: [0, -20]
    });
  }

  MAP_STOPS.forEach((s, i) => {
    const m = L.marker([s.lat, s.lng], { icon: iconFor(s.cor) }).addTo(liveMap);
    m.bindPopup(`<div class="pop">
      <img src="${s.img}" alt="${esc(s.nome)}" onerror="this.style.display='none'" />
      <div class="pt">${esc(s.nome)}</div>
      <div class="pts">⏱ ${fmtClock(s.sec)} · na live</div>
      <div class="pq">${esc(s.frase || "")}</div>
      <a class="pgm" href="https://www.google.com/maps?q=${s.lat},${s.lng}" target="_blank" rel="noopener"><i class="fa-solid fa-location-dot"></i> Abrir no Google Maps</a>
    </div>`);
    m.on("click", () => jumpToStop(s));
    mapMarkers[i] = m;
  });

  renderMapStops();
  mapFitAll();
}

function renderMapStops() {
  const wrap = document.getElementById("mapStops");
  if (!wrap) return;
  wrap.innerHTML = MAP_STOPS.map((s, i) =>
    `<button class="map-stop" id="mapstop-${i}" onclick="jumpToStop(MAP_STOPS[${i}])">
      <span class="dot" style="background:${s.cor}"></span>
      <span>${i + 1}. ${esc(s.nome)}</span>
      <span class="muted">${fmtClock(s.sec)}</span>
    </button>`
  ).join("");
}

function jumpToStop(s) {
  const media = (V.el && FILES.video) ? V : ((A.el && FILES.audio) ? A : null);
  if (media && media.el) {
    setPlayerMode(FILES.video ? "video" : "audio");
    media.el.currentTime = s.sec;
    media.el.play && media.el.play().catch(() => {});
  }
  if (liveMap) {
    liveMap.flyTo([s.lat, s.lng], Math.max(liveMap.getZoom(), 17), { duration: .5 });
  }
  document.querySelectorAll(".map-stop").forEach(x => x.classList.remove("active"));
  const chip = document.querySelector(`.map-stop[onclick*="MAP_STOPS[${MAP_STOPS.indexOf(s)}]"]`);
  if (chip) chip.classList.add("active");
  document.getElementById("mapNow").textContent = `▶ ${s.nome} — ${fmtClock(s.sec)}`;
  showStreetView(s);
}

function showStreetView(s) {
  const link = document.getElementById("mapGmapsLink");
  const shell = document.getElementById("streetviewShell");
  const frame = document.getElementById("streetviewFrame");
  const title = document.getElementById("streetviewTitle");
  if (link) {
    link.href = `https://www.google.com/maps?q=${s.lat},${s.lng}`;
    link.style.display = "";
  }
  if (shell && frame) {
    frame.src = `https://maps.google.com/maps?q=${s.lat},${s.lng}&layer=c&cbll=${s.lat},${s.lng}&output=svembed`;
    shell.style.display = "";
    if (title) title.textContent = `${s.nome} · ${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}`;
  }
}

function mapFitAll() {
  if (!liveMap || !MAP_STOPS.length) return;
  liveMap.fitBounds(L.latLngBounds(MAP_STOPS.map(s => [s.lat, s.lng])), { padding: [30, 30] });
}

function fmtDataBR(iso) {
  if (!iso) return "—";
  const m = String(iso).slice(0,10).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso).slice(0,10);
  return `${m[3]}/${m[2]}/${m[1]}`;
}

// ---------------------------------------------------------------------------
// TOC (índice da página) + seções colapsáveis
// ---------------------------------------------------------------------------
const SECTION_TITLES = [
  ["player", "fa-solid fa-clapperboard", "Player de Vídeo & Áudio"],
  ["mapa", "fa-solid fa-map-location-dot", "Mapa da Live"],
  ["replay", "fa-solid fa-comments", "Replay dos Comentários"],
  ["kpis", "fa-solid fa-chart-column", "Métricas de Performance"],
  ["bench", "fa-solid fa-chart-line", "Comparação com o Canal"],
  ["sent", "fa-solid fa-face-smile", "Sentimento dos Comentários"],
  ["temas", "fa-solid fa-tags", "Temas dos Comentários"],
  ["resumo", "fa-solid fa-file-lines", "Resumo do Conteúdo"],
  ["capitulos", "fa-solid fa-layer-group", "Capítulos Automáticos"],
  ["fala-chat", "fa-solid fa-volume-high", "Fala vs. Chat"],
  ["sent-tempo", "fa-solid fa-arrow-trend-down", "Sentimento ao Longo do Tempo"],
  ["risadas", "fa-solid fa-face-laugh-squint", "Risadas & Perguntas"],
  ["wordcloud", "fa-solid fa-cloud", "Nuvem de Palavras"],
  ["heatmap", "fa-solid fa-fire", "Heatmap Minuto × Sentimento"],
  ["segmentos", "fa-solid fa-puzzle-piece", "Segmentos da Live"],
  ["usuarios", "fa-solid fa-users", "Usuários & Top Comentaristas"],
  ["sent-tema", "fa-solid fa-bullseye", "Sentimento por Tema"],
  ["retencao", "fa-solid fa-signal", "Retenção de Audiência"],
  ["monetizacao", "fa-solid fa-sack-dollar", "Monetização & Comandos"],
  ["receita", "fa-solid fa-money-bill-trend-up", "Previsão de Receita"],
  ["lag", "fa-solid fa-stopwatch", "Correlação Defasada"],
  ["radar", "fa-solid fa-satellite-dish", "Radar do Streamer"],
  ["velocidade", "fa-solid fa-bolt", "Velocidade do Chat"],
  ["interacao", "fa-solid fa-shuffle", "Distribuição de Interação & Emojis"],
  ["topicos", "fa-solid fa-brain", "Tópicos Falados vs. Comentados"],
  ["frases", "fa-solid fa-comments", "Frases Faladas vs. Comentadas"],
  ["ganchos", "fa-solid fa-wand-magic-sparkles", "Ganchos de Conteúdo"],
  ["alertas", "fa-solid fa-triangle-exclamation", "Top Palavrões"],
  ["bordoes", "fa-solid fa-bullhorn", "Ranking de Bordões"],
  ["resumo1min", "fa-solid fa-stopwatch", "Resumo em 1 minuto"],
  ["perguntas", "fa-solid fa-circle-question", "Perguntas Frequentes"],
  ["cortes", "fa-solid fa-scissors", "Cortes Virais Sugeridos"],
  ["popular", "fa-solid fa-star", "Comentário Mais Popular"],
  ["comentarios", "fa-solid fa-scroll", "Comentários Relevantes"],
  ["participantes", "fa-solid fa-user-group", "Participantes do Chat"],
];

function buildToc() {
  const toc = document.getElementById("toc");
  if (!toc) return;
  const links = SECTION_TITLES.map(([id, ico, label]) =>
    `<a href="#${id}"><i class="${ico}"></i><span>${label}</span></a>`
  ).join("");
  toc.innerHTML = `<span class="toc-label"><i class="fa-solid fa-bars"></i> Índice</span><nav class="toc-nav">${links}</nav>`;
}

function wrapSections() {
  // Agrupa cada <h2> (e o conteúdo até o próximo h2) numa section colapsável,
  // exceto os h2 do cabeçalho/player que já estão marcados como seções.
  const container = document.querySelector(".max-w-7xl");
  if (!container) return;
  const h2s = Array.from(container.querySelectorAll(":scope > h2, :scope > section > h2"));
  // se já houver sections colapsadas de edição anterior, recomeça do zero
  h2s.forEach(h => {
    if (h.id && h.id !== "title") {
      h.classList.add("topic-heading");
      if (!h.querySelector(".chev")) {
        h.insertAdjacentHTML("afterbegin", '<i class="fa-solid fa-chevron-down chev"></i>');
      }
    }
  });
  // aplica collapse apenas nos h2 com id já existentes no mapa de títulos
  SECTION_TITLES.forEach(([id]) => {
    const h = document.getElementById(id);
    if (!h) return;
    h.classList.add("topic-heading");
    if (!h.querySelector(".chev")) {
      h.insertAdjacentHTML("afterbegin", '<i class="fa-solid fa-chevron-down chev"></i>');
    }
    // reúne todos os irmãos seguintes até o próximo h2
    const group = document.createElement("div");
    group.className = "section-body";
    let node = h.nextElementSibling;
    while (node && node.tagName !== "H2") {
      const next = node.nextElementSibling;
      group.appendChild(node);
      node = next;
    }
    h.after(group);
    h.addEventListener("click", () => toggleSection(id));
  });
}

function toggleSection(id) {
  const h = document.getElementById(id);
  const body = h ? h.nextElementSibling : null;
  if (!h || !body || !body.classList.contains("section-body")) return;
  const collapsed = h.classList.toggle("collapsed");
  body.classList.toggle("hidden", collapsed);
}

function render() {
  const m = R.metricas, ca = R.comentarios, ct = R.conteudo;
  document.getElementById("title").textContent = "Análise — " + m.title;
  document.getElementById("subtitle").textContent =
    m.channel + " · " + m.category + " · " + m.duration_label + " · publicado " + fmtDataBR(m.created_at);

  buildToc();
  wrapSections();

  initPlayers();

  const kpis = [
    {label:"Views", value:fmt(m.views)},
    {label:"Likes (est.)", value:fmt(m.likes_estimado)},
    {label:"Comentários", value:fmt(m.comentarios)},
    {label:"Taxa de likes", value:m.taxa_likes+"%"},
    {label:"Engajamento", value:m.taxa_engajamento+"%"},
    {label:"Duração", value:m.duration_label},
  ];
  document.getElementById("kpisBody").innerHTML = kpis.map(k =>
    `<div class="card"><div class="label">${k.label}</div><div class="value">${k.value}</div></div>`
  ).join("");

  const b = m.comparacao_canal;
  document.getElementById("benchBody").innerHTML = [
    {label:"Mediana do canal", value:fmt(b.mediana_views), d:""},
    {label:"Média do canal", value:fmt(b.media_views), d:""},
    {label:"Mediana dos pares", value:fmt(b.mediana_pares), d:""},
    {label:"Este VOD vs. mediana", value:fmt(m.views), d:delta(b.views_vs_mediana_pct)},
    {label:"Este VOD vs. média", value:fmt(m.views), d:delta(b.views_vs_media_pct)},
    {label:"VODs no canal", value:b.n_videos_canal, d:""},
  ].map(k => `<div class="card"><div class="label">${k.label}</div><div class="value">${k.value}</div>${k.d}</div>`).join("");

  renderSent(ca);
  renderThemes(ca);
  renderResumo(ct);
  renderCapitulos(ct);
  renderEngajamento();
  renderCortes(ct);
  renderPopular(ca);
  buildSentFilters();
  renderComments();
  renderParticipantes();
}

function renderParticipantes() {
  const el = document.getElementById("participantesBody");
  const countEl = document.getElementById("participanteCount");
  if (!el) return;
  const all = (R.engajamento && R.engajamento.todos_participantes) || [];
  const q = (document.getElementById("participanteBusca")?.value || "").toLowerCase().trim();
  const list = q ? all.filter(p => p.usuario.toLowerCase().includes(q)) : all;
  if (countEl) countEl.textContent = `${list.length} de ${all.length} participantes`;
  el.innerHTML = list.map(p =>
    `<div class="participante">
      <span class="p-name" title="${esc(p.usuario)}">${esc(p.usuario)}</span>
      <span class="tag ${p.sentimento}">${esc(p.sentimento)}</span>
      <span class="p-count">${p.n}</span>
    </div>`
  ).join("") || "<div class='muted'>Nenhum participante.</div>";
}

function renderEngajamento() {
  const eng = R.engajamento;
  if (!eng || !eng.minuto_buckets || eng.minuto_buckets.length === 0) {
    document.getElementById("engKpis").innerHTML = "<div class='muted'>Sem dados de engajamento.</div>";
    return;
  }

  // KPIs
  const corr = eng.correlacao != null ? eng.correlacao.toFixed(2) : "—";
  const corrDesc = eng.correlacao != null
    ? (Math.abs(eng.correlacao) >= 0.5 ? (eng.correlacao > 0 ? "chat reage junto com a fala" : "chat reage quando a fala cai") : "correlação fraca")
    : "";
  document.getElementById("engKpis").innerHTML =
    `<div class="grid cards">
      <div class="card"><div class="label">Palavras/min (fala)</div><div class="value">${eng.palavras_por_minuto}</div></div>
      <div class="card"><div class="label">Mensagens/min (chat)</div><div class="value">${eng.mensagens_por_minuto}</div></div>
      <div class="card"><div class="label">Correlação fala↔chat</div><div class="value">${corr}</div><div class="muted">${esc(corrDesc)}</div></div>
    </div>`;

  // Gráfico fala vs chat
  const labels = eng.minuto_buckets.map(b => fmtClock(b.minuto * 60));
  new Chart(document.getElementById("chartFalaChat"), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Palavras (fala)", data: eng.fala_series, borderColor: "#a855f7", backgroundColor: "transparent", pointRadius: 0, tension: 0.3 },
        { label: "Mensagens (chat)", data: eng.chat_series, borderColor: "#22c55e", backgroundColor: "transparent", pointRadius: 0, tension: 0.3 },
      ],
    },
    options: {
      plugins: { legend: { labels: { color: "#e2e8f0", boxWidth: 12, font: { size: 10 } } } },
      scales: { x: { ticks: { color: "#94a3b8", maxTicksLimit: 12, font: { size: 9 } } }, y: { ticks: { color: "#94a3b8", font: { size: 9 } } } },
    },
  });

  // Picos de retenção
  document.getElementById("engPicos").innerHTML =
    "<div class='label' style='margin-bottom:8px'>Picos de retenção (fala + chat + risadas)</div>" +
    (eng.picos || []).map((p, i) =>
      `<div class="quote" style="border-left-color:#f97316">
        <strong>#${i+1} · ${esc(p.inicio)}</strong>
        <div class="muted">${p.palavras} palavras · ${p.mensagens} msgs · ${p.risadas} risadas</div>
      </div>`
    ).join("") || "<div class='muted'>Sem picos.</div>";

  // Tópicos
  const topF = (eng.topicos_falados || []).slice(0, 10);
  const topC = (eng.topicos_comentados || []).slice(0, 10);
  const maxF = topF.length ? topF[0].n : 1;
  const maxC = topC.length ? topC[0].n : 1;
  document.getElementById("topicosGrid").innerHTML =
    `<div class="card"><div class="label">Falados</div>` +
      topF.map(t => `<div style="margin-top:6px"><span style="font-size:.78rem">${esc(t.palavra)}</span><div class="bar" style="margin-top:3px"><span style="width:${(t.n/maxF*100).toFixed(0)}%"></span></div></div>`).join("") +
    `</div>
    <div class="card"><div class="label">Comentados</div>` +
      topC.map(t => `<div style="margin-top:6px"><span style="font-size:.78rem">${esc(t.palavra)}</span><div class="bar" style="margin-top:3px"><span style="width:${(t.n/maxC*100).toFixed(0)}%;background:#22c55e"></span></div></div>`).join("") +
    `</div>`;

  // Frases completas (bigramas/trigramas)
  renderFrases(eng);

  // Ganchos
  const tipos = { piada: "#f97316", pergunta: "#3b82f6", "história": "#eab308", "revelação": "#ec4899" };
  document.getElementById("ganchosBody").innerHTML =
    (eng.ganchos || []).map(g =>
      `<div class="quote" style="border-left-color:${tipos[g.tipo] || "#a855f7"}">
        <strong>${esc(g.inicio)}</strong> · <span class="tag" style="background:${tipos[g.tipo] || "#a855f7"}">${esc(g.tipo)}</span>
        <div class="muted">${esc(g.trecho)}</div>
      </div>`
    ).join("") || "<div class='muted'>Sem ganchos identificados.</div>";

  // Alertas
  document.getElementById("alertasBody").innerHTML =
    (eng.alertas || []).map(a =>
      `<div class="quote" style="border-left-color:#ef4444">
        <strong>${esc(a.inicio)}</strong> · termos: ${a.termos.map(t => esc(t)).join(", ")}
        <div class="muted">${a.mensagens} mensagens no minuto</div>
      </div>`
    ).join("") || "<div class='muted'>Nenhum alerta de risco detectado.</div>";

  // Bordões
  document.getElementById("bordoesBody").innerHTML =
    (eng.bordoes || []).map((b, i) =>
      `<div class="quote" style="border-left-color:#2dd4bf">
        <strong>#${i+1}</strong> "${esc(b.frase)}" <span class="muted">× ${b.n}</span>
      </div>`
    ).join("") || "<div class='muted'>Sem bordões recorrentes.</div>";

  // Resumo em 1 minuto
  document.getElementById("resumo1minBody").innerHTML =
    (eng.resumo_1min || []).map(r =>
      `<div class="quote"><strong>${esc(r.inicio)}</strong> — ${esc(r.texto)}</div>`
    ).join("") || "<div class='muted'>Sem resumo.</div>";

  // Perguntas frequentes
  document.getElementById("perguntasFreq").innerHTML =
    (eng.perguntas_frequentes || []).map((q, i) =>
      `<li><strong>${esc(q.pergunta)}</strong> <span class="muted">× ${q.n}</span></li>`
    ).join("") || "<div class='muted'>Sem perguntas recorrentes.</div>";

  // --- novos gráficos ---
  renderSentTempo(eng);
  renderRisadas(eng);
  renderWordcloud(eng);
  renderHeatmap(eng);
  renderSegmentos(eng);
  renderUsuarios(eng);
  renderSentTema(eng);
  renderRetencao(eng);
  renderMonetizacao(eng);
  renderLag(eng);
  renderRadar(eng);
  renderVelocidade(eng);
  renderInteracao(eng);
}
function renderSentTempo(eng) {
  const el = document.getElementById("chartSentimento");
  if (!el || !eng.sent_series) return;
  const labels = (eng.minuto_buckets || []).map(b => fmtClock(b.minuto * 60));
  const datasets = SENT.map(cat => ({
    label: cat,
    data: eng.sent_series[cat] || [],
    backgroundColor: COLORS[cat] || "#94a3b8",
    pointRadius: 0,
    fill: true,
  }));
  new Chart(el, {
    type: "line",
    data: { labels, datasets },
    options: {
      plugins: { legend: { labels: { color: "#e2e8f0", boxWidth: 12, font: { size: 9 } } } },
      scales: {
        x: { ticks: { color: "#94a3b8", maxTicksLimit: 12, font: { size: 9 } }, stacked: false },
        y: { ticks: { color: "#94a3b8", font: { size: 9 } } },
      },
    },
  });
}

function renderRisadas(eng) {
  const el = document.getElementById("chartRisadas");
  if (!el) return;
  const labels = (eng.minuto_buckets || []).map(b => fmtClock(b.minuto * 60));
  new Chart(el, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Risadas", data: eng.risadas_series || [], backgroundColor: "#f97316" },
        { label: "Perguntas", data: eng.perguntas_series || [], backgroundColor: "#3b82f6" },
      ],
    },
    options: {
      plugins: { legend: { labels: { color: "#e2e8f0", boxWidth: 12, font: { size: 9 } } } },
      scales: {
        x: { ticks: { color: "#94a3b8", maxTicksLimit: 12, font: { size: 9 } }, stacked: false },
        y: { ticks: { color: "#94a3b8", font: { size: 9 } } },
      },
    },
  });
}

function renderWordcloud(eng) {
  const el = document.getElementById("wordcloudBody");
  if (!el) return;
  const words = eng.wordcloud || [];
  if (!words.length) { el.innerHTML = "<span class='muted'>Sem palavras.</span>"; return; }
  const max = words[0].peso || 1;
  const colors = ["#a855f7", "#22c55e", "#3b82f6", "#f97316", "#eab308", "#ec4899", "#2dd4bf"];
  el.innerHTML = words.map((w, i) => {
    const size = 0.75 + (w.peso / max) * 1.75;
    return `<span style="font-size:${size.toFixed(2)}rem;color:${colors[i % colors.length]};padding:2px 6px;white-space:nowrap">${esc(w.texto)}</span>`;
  }).join("");
}

function renderHeatmap(eng) {
  const el = document.getElementById("heatmapBody");
  if (!el) return;
  const hm = eng.heatmap || [];
  if (!hm.length) { el.innerHTML = "<span class='muted'>Sem dados.</span>"; return; }
  // amostra até 60 linhas (1 por minuto, agregado em blocos de ~2 min)
  const sampled = [];
  const step = Math.max(1, Math.floor(hm.length / 60));
  for (let i = 0; i < hm.length; i += step) sampled.push(hm[i]);

  const cats = ["positivo", "engraçado", "confuso", "negativo", "frustrado"];
  let html = "<table style='font-size:.68rem'><tr><th>min</th>";
  for (const c of cats) html += `<th>${c}</th>`;
  html += "</tr>";
  for (const row of sampled) {
    const total = cats.reduce((s, c) => s + (row[c] || 0), 0) || 1;
    html += `<tr><td style="color:#a855f7">${row.inicio}</td>`;
    for (const c of cats) {
      const v = row[c] || 0;
      const intensity = Math.min(1, v / (total * 0.35));
      const bg = v > 0 ? `rgba(168,85,247,${(0.15 + intensity * 0.85).toFixed(2)})` : "transparent";
      html += `<td style="background:${bg};text-align:center">${v}</td>`;
    }
    html += "</tr>";
  }
  html += "</table>";
  el.innerHTML = html;
}

function searchTranscricao() {
  const q = (document.getElementById("buscaInput").value || "").toLowerCase().trim();
  const ul = document.getElementById("buscaResultados");
  if (!q) { ul.innerHTML = "<li class='muted'>Digite um termo para buscar.</li>"; return; }
  const terms = q.split(/\s+/).filter(Boolean);
  const blocks = (R.engajamento && R.engajamento.busca_transcricao) || [];
  const hits = blocks.filter(b => terms.every(t => b.texto.toLowerCase().includes(t)));
  ul.innerHTML = hits.slice(0, 50).map(b =>
    `<li><span class="ts">${esc(b.inicio)}</span> <span class="cbody">${esc(b.texto)}</span></li>`
  ).join("") || "<li class='muted'>Nenhum resultado.</li>";
}

function renderFrases(eng) {
  const el = document.getElementById("frasesGrid");
  if (!el) return;
  const fF = (eng.frases_faladas || []).slice(0, 12);
  const fC = (eng.frases_comentadas || []).slice(0, 12);
  const maxF = fF.length ? fF[0].n : 1;
  const maxC = fC.length ? fC[0].n : 1;
  el.innerHTML =
    `<div class="card"><div class="label">Faladas</div>` +
      fF.map(t => `<div style="margin-top:6px"><span style="font-size:.78rem">"${esc(t.frase)}"</span><div class="bar" style="margin-top:3px"><span style="width:${(t.n/maxF*100).toFixed(0)}%"></span></div></div>`).join("") +
    `</div>
    <div class="card"><div class="label">Comentadas</div>` +
      fC.map(t => `<div style="margin-top:6px"><span style="font-size:.78rem">"${esc(t.frase)}"</span><div class="bar" style="margin-top:3px"><span style="width:${(t.n/maxC*100).toFixed(0)}%;background:#22c55e"></span></div></div>`).join("") +
    `</div>`;
}

function renderSegmentos(eng) {
  const el = document.getElementById("chartSegmentos");
  if (!el) return;
  const segs = eng.segmentos || [];
  if (!segs.length) { return; }
  new Chart(el, {
    type: "bar",
    data: {
      labels: segs.map(s => `Q${s.quarto} (${s.inicio})`),
      datasets: [
        { label: "Fala (palavras)", data: segs.map(s => s.palavras), backgroundColor: "#a855f7" },
        { label: "Chat (mensagens)", data: segs.map(s => s.mensagens), backgroundColor: "#22c55e" },
        { label: "Risadas", data: segs.map(s => s.risadas), backgroundColor: "#f97316" },
      ],
    },
    options: {
      plugins: {
        legend: { labels: { color: "#e2e8f0", boxWidth: 12, font: { size: 9 } } },
        tooltip: {
          callbacks: {
            afterLabel: function (ctx) {
              const s = segs[ctx.dataIndex];
              return `Sentimento dominante: ${s.sentimento_dominante}\nUsuários: ${s.usuarios}\nPerguntas: ${s.perguntas}`;
            },
          },
        },
      },
      scales: { x: { ticks: { color: "#94a3b8", font: { size: 9 } } }, y: { ticks: { color: "#94a3b8", font: { size: 9 } } } },
    },
  });
}

function renderUsuarios(eng) {
  const el = document.getElementById("chartUsuarios");
  if (!el) return;
  const labels = (eng.minuto_buckets || []).map(b => fmtClock(b.minuto * 60));
  new Chart(el, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Usuários únicos/min", data: eng.usuarios_series || [], borderColor: "#2dd4bf", backgroundColor: "rgba(45,212,191,0.15)", pointRadius: 0, fill: true, tension: 0.3 },
      ],
    },
    options: {
      plugins: { legend: { labels: { color: "#e2e8f0", boxWidth: 12, font: { size: 9 } } } },
      scales: { x: { ticks: { color: "#94a3b8", maxTicksLimit: 12, font: { size: 9 } } }, y: { ticks: { color: "#94a3b8", font: { size: 9 } } } },
    },
  });

  const top = eng.top_usuarios || [];
  const max = top.length ? top[0].n : 1;
  document.getElementById("topUsuarios").innerHTML =
    "<div class='label' style='margin-bottom:8px'>Top comentaristas</div>" +
    top.map((u, i) =>
      `<div style="margin-top:6px">
        <div style="display:flex;justify-content:space-between;font-size:.78rem">
          <span>${i+1}. ${esc(u.usuario)}</span><span class="muted">${u.n}</span>
        </div>
        <div class="bar" style="margin-top:3px"><span style="width:${(u.n/max*100).toFixed(0)}%"></span></div>
      </div>`
    ).join("") || "<div class='muted'>Sem dados.</div>";
}

function renderSentTema(eng) {
  const el = document.getElementById("chartSentTema");
  if (!el) return;
  const data = eng.sentimento_por_tema || [];
  if (!data.length) { return; }
  const cats = ["positivo", "engraçado", "confuso", "neutro", "negativo", "frustrado", "inspirado", "neutro/pergunta"];
  const datasets = cats.map(cat => ({
    label: cat,
    data: data.map(t => (t.dist.find(d => d.sentimento === cat) || {}).pct || 0),
    backgroundColor: COLORS[cat] || "#94a3b8",
  }));
  new Chart(el, {
    type: "bar",
    data: { labels: data.map(t => t.tema), datasets },
    options: {
      plugins: { legend: { labels: { color: "#e2e8f0", boxWidth: 12, font: { size: 9 } } } },
      scales: {
        x: { stacked: true, ticks: { color: "#94a3b8", font: { size: 9 } } },
        y: { stacked: true, ticks: { color: "#94a3b8", font: { size: 9 }, callback: v => v + "%" } },
      },
    },
  });
}

function renderRetencao(eng) {
  const el = document.getElementById("chartRetencao");
  if (!el || !eng.retencao) return;
  new Chart(el, {
    type: "line",
    data: {
      labels: eng.retencao.map(r => r.inicio),
      datasets: [
        { label: "Audiência retida (%)", data: eng.retencao.map(r => r.pct), borderColor: "#22c55e", backgroundColor: "rgba(34,197,94,0.15)", pointRadius: 0, fill: true, tension: 0.3 },
      ],
    },
    options: {
      plugins: { legend: { labels: { color: "#e2e8f0", boxWidth: 12, font: { size: 9 } } } },
      scales: {
        x: { ticks: { color: "#94a3b8", maxTicksLimit: 12, font: { size: 9 } } },
        y: { min: 0, max: 100, ticks: { color: "#94a3b8", font: { size: 9 }, callback: v => v + "%" } },
      },
    },
  });
}

function renderMonetizacao(eng) {
  const el = document.getElementById("chartMonetizacao");
  if (!el) return;
  const labels = (eng.minuto_buckets || []).map(b => fmtClock(b.minuto * 60));
  new Chart(el, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Subs", data: eng.subs_series || [], backgroundColor: "#eab308" },
        { label: "Gifts", data: eng.gifts_series || [], backgroundColor: "#ec4899" },
        { label: "Bits", data: eng.bits_series || [], backgroundColor: "#3b82f6" },
      ],
    },
    options: {
      plugins: { legend: { labels: { color: "#e2e8f0", boxWidth: 12, font: { size: 9 } } } },
      scales: {
        x: { ticks: { color: "#94a3b8", maxTicksLimit: 12, font: { size: 9 } } },
        y: { ticks: { color: "#94a3b8", font: { size: 9 } } },
      },
    },
  });

  const cmds = eng.comandos || [];
  const max = cmds.length ? cmds[0].n : 1;
  document.getElementById("comandosList").innerHTML =
    "<div class='label' style='margin-bottom:8px'>Comandos mais usados no chat</div>" +
    cmds.map((c, i) =>
      `<div class="comando-item">
        <div class="comando-head">
          <code style="color:#e9d5ff;font-weight:700">${esc(c.comando)}</code>
          <span class="muted">${c.n}×</span>
        </div>
        <div class="bar" style="margin:4px 0"><span style="width:${(c.n/max*100).toFixed(0)}%"></span></div>
        ${c.exemplo ? `<div class="muted comando-ex">↳ "${esc(c.exemplo)}"</div>` : ''}
        ${c.resposta ? `<div class="comando-resp">🤖 ${esc(c.resposta)}</div>` : ''}
      </div>`
    ).join("") || "<div class='muted'>Nenhum comando detectado.</div>";

  renderPrevisaoReceita(eng);
  renderTiers(eng);
}

function renderPrevisaoReceita(eng) {
  const p = eng.previsao;
  if (!p) return;
  const rate = p.usd_brl || 5;
  document.getElementById("previsaoReceita").innerHTML =
    `<div class="grid cards">
      <div class="card"><div class="label">💵 Receita líquida</div><div class="value">$${p.receita_liquida.toFixed(2)}</div><div class="muted">R$ ${p.receita_liquida_brl.toFixed(2)}</div></div>
      <div class="card"><div class="label">Receita de subs</div><div class="value">$${p.receita_subs.toFixed(2)}</div><div class="muted">R$ ${p.receita_subs_brl.toFixed(2)}</div></div>
      <div class="card"><div class="label">Receita de bits</div><div class="value">$${p.receita_bits.toFixed(2)}</div><div class="muted">R$ ${p.receita_bits_brl.toFixed(2)}</div></div>
      <div class="card"><div class="label">Subs totais</div><div class="value">${p.total_subs}</div></div>
      <div class="card"><div class="label">Bits totais</div><div class="value">${p.total_bits}</div></div>
      <div class="card"><div class="label">Projeção (2h)</div><div class="value">$${p.projecao_2h.toFixed(2)}</div><div class="muted">R$ ${p.projecao_2h_brl.toFixed(2)}</div></div>
      <div class="card"><div class="label">Projeção (3h)</div><div class="value">$${p.projecao_3h.toFixed(2)}</div><div class="muted">R$ ${p.projecao_3h_brl.toFixed(2)}</div></div>
      <div class="card"><div class="label">Câmbio USD→BRL</div><div class="value">R$ ${rate.toFixed(2)}</div></div>
    </div>`;
}

function renderTiers(eng) {
  const el = document.getElementById("chartTiers");
  if (!el) return;
  const tiers = eng.tiers_pie || [];
  if (!tiers.length) { el.parentElement.innerHTML = "<div class='muted'>Sem subs.</div>"; return; }
  const cores = { tier1: "#eab308", tier2: "#22c55e", tier3: "#a855f7", "prime/outros": "#3b82f6" };
  new Chart(el, {
    type: "doughnut",
    data: {
      labels: tiers.map(t => t.tier),
      datasets: [{ data: tiers.map(t => t.n), backgroundColor: tiers.map(t => cores[t.tier] || "#94a3b8") }],
    },
    options: { plugins: { legend: { position: "bottom", labels: { color: "#e2e8f0", boxWidth: 12, font: { size: 10 } } } } },
  });
}

function renderSubsSent(eng) {
  const el = document.getElementById("chartSubsSent");
  if (!el) return;
  const pie = eng.subs_sent_pie || [];
  if (!pie.length) { el.parentElement.innerHTML = "<div class='muted'>Sem cruzamento subs × sentimento.</div>"; return; }
  new Chart(el, {
    type: "doughnut",
    data: {
      labels: pie.map(s => s.sentimento),
      datasets: [{ data: pie.map(s => s.n), backgroundColor: pie.map(s => COLORS[s.sentimento] || "#94a3b8") }],
    },
    options: { plugins: { legend: { position: "bottom", labels: { color: "#e2e8f0", boxWidth: 12, font: { size: 10 } } } } },
  });
}
function renderLag(eng) {
  const el = document.getElementById("chartLag");
  if (!el || !eng.lag_corrs) return;
  const lagCorrs = eng.lag_corrs;
  new Chart(el, {
    type: "bar",
    data: {
      labels: lagCorrs.map(l => l.lag_min === 0 ? "0 (simultâneo)" : l.lag_min + " min depois"),
      datasets: [
        { label: "Correlação", data: lagCorrs.map(l => l.corr ?? 0), backgroundColor: lagCorrs.map(l => (l.corr != null && l.corr > 0) ? "#22c55e" : "#ef4444") },
      ],
    },
    options: {
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function (ctx) {
              const l = lagCorrs[ctx.dataIndex];
              const desc = l.corr == null ? "n/d" : (Math.abs(l.corr) >= 0.5 ? (l.corr > 0 ? "forte positiva" : "forte negativa") : "fraca");
              return `r = ${l.corr} (${desc})`;
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: "#94a3b8", font: { size: 9 } } },
        y: { min: -1, max: 1, ticks: { color: "#94a3b8", font: { size: 9 } } },
      },
    },
  });

  if (eng.best_lag && eng.best_lag.corr != null) {
    const desc = Math.abs(eng.best_lag.corr) >= 0.5
      ? (eng.best_lag.corr > 0 ? "o chat reage à fala" : "o chat reage em direção oposta")
      : "sem relação temporal clara";
    el.parentElement.insertAdjacentHTML("beforeend",
      `<div class="muted" style="margin-top:8px">Melhor lag: ${eng.best_lag.lag_min} min · r = ${eng.best_lag.corr} → ${desc}</div>`
    );
  }
}

function renderRadar(eng) {
  const el = document.getElementById("chartRadar");
  if (!el || !eng.radar) return;
  const labels = ["Humor", "Interatividade", "Monetização", "Engajamento", "Audiência", "Risco"];
  const data = [eng.radar.humor, eng.radar.interatividade, eng.radar.monetizacao, eng.radar.engajamento, eng.radar.audiencia, eng.radar.risco];
  new Chart(el, {
    type: "radar",
    data: {
      labels,
      datasets: [{
        label: "Perfil",
        data,
        backgroundColor: "rgba(168,85,247,0.25)",
        borderColor: "#a855f7",
        pointBackgroundColor: "#a855f7",
        pointRadius: 3,
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        r: {
          min: 0, max: 100,
          ticks: { color: "#94a3b8", font: { size: 8 }, backdropColor: "transparent" },
          grid: { color: "#334155" },
          angleLines: { color: "#334155" },
          pointLabels: { color: "#e2e8f0", font: { size: 10 } },
        },
      },
    },
  });
}

function renderVelocidade(eng) {
  const el = document.getElementById("chartVelocidade");
  if (!el || !eng.chat_ma) return;
  const labels = (eng.minuto_buckets || []).map(b => fmtClock(b.minuto * 60));
  new Chart(el, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Msg/min (média móvel 5min)", data: eng.chat_ma, borderColor: "#2dd4bf", backgroundColor: "rgba(45,212,191,0.15)", pointRadius: 0, fill: true, tension: 0.3 },
      ],
    },
    options: {
      plugins: { legend: { labels: { color: "#e2e8f0", boxWidth: 12, font: { size: 9 } } } },
      scales: { x: { ticks: { color: "#94a3b8", maxTicksLimit: 12, font: { size: 9 } } }, y: { ticks: { color: "#94a3b8", font: { size: 9 } } } },
    },
  });
}

function renderInteracao(eng) {
  const el = document.getElementById("chartInteracao");
  if (!el) return;
  const dist = eng.interaction_dist || [];
  const ordem = ["1 comentário", "2–5", "6–10", "11–20", "21+"];
  const sorted = ordem.map(k => dist.find(d => d.faixa === k)).filter(Boolean);
  new Chart(el, {
    type: "bar",
    data: {
      labels: sorted.map(d => d.faixa),
      datasets: [{ label: "Usuários", data: sorted.map(d => d.usuarios), backgroundColor: "#a855f7" }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: { x: { ticks: { color: "#94a3b8", font: { size: 9 } } }, y: { ticks: { color: "#94a3b8", font: { size: 9 } } } },
    },
  });

  const emojis = eng.top_emojis || [];
  document.getElementById("emojisList").innerHTML =
    "<div class='label' style='margin-bottom:8px'>Reações mais usadas</div>" +
    emojis.map(e =>
      `<div style="display:inline-block;margin:4px;text-align:center;background:#0f172a;border:1px solid #334155;border-radius:10px;padding:8px 12px">
        <div style="font-size:1.4rem">${e.emoji}</div>
        <div class="muted" style="font-size:.7rem">× ${e.n}</div>
      </div>`
    ).join("") || "<div class='muted'>Nenhuma reação detectada.</div>";
}

function renderSent(ca) {
  const labels = ca.sentimentos.map(s=>s.categoria);
  const data = ca.sentimentos.map(s=>s.pct);
  new Chart(document.getElementById("chartSent"), {
    type:"bar", data:{labels, datasets:[{data, backgroundColor: labels.map(l=>COLORS[l]||"#94a3b8")}]},
    options:{plugins:{legend:{display:false}}, scales:{y:{ticks:{callback:v=>v+"%"}}}}
  });
  document.getElementById("sentTable").innerHTML =
    "<table><tr><th>Categoria</th><th>N</th><th>%</th></tr>" +
    ca.sentimentos.map(s => `<tr><td><span class="tag ${s.categoria}">${s.categoria}</span></td><td>${s.n}</td><td>${s.pct}%</td></tr>`).join("") +
    "</table>";
}

function renderThemes(ca) {
  const top = ca.temas.slice(0,8);
  new Chart(document.getElementById("chartThemes"), {
    type:"doughnut",
    data:{labels: top.map(t=>t.tema), datasets:[{data: top.map(t=>t.pct), backgroundColor: ["#a855f7","#22c55e","#3b82f6","#f97316","#eab308","#ef4444","#2dd4bf","#ec4899"]}]},
    options:{plugins:{legend:{position:"bottom", labels:{color:"#e2e8f0", boxWidth:12, font:{size:10}}}}}
  });
  document.getElementById("themesList").innerHTML =
    "<table><tr><th>Tema</th><th>%</th><th>Palavras-chave</th></tr>" +
    ca.temas.map(t => `<tr><td>${esc(t.tema)}</td><td>${t.pct}%</td><td class="muted">${esc((t.palavras_chave||[]).slice(0,4).join(", "))}</td></tr>`).join("") + "</table>";
}

function renderResumo(ct) {
  document.getElementById("resumoBody").innerHTML =
    `<div class="card"><div class="label">Palavras-chave</div><p style="margin-top:6px">${esc((ct.palavras_chave||[]).join(", "))}</p></div>` +
    ct.momentos_chave.slice(0,8).map(mo =>
      `<div class="quote"><strong>${esc(mo.timestamp)}</strong> — ${esc(mo.texto)}</div>`
    ).join("");
}

function renderCapitulos(ct) {
  const caps = ct.capitulos || [];
  document.getElementById("capitulosBody").innerHTML =
    caps.map(ch =>
      `<div class="quote" style="border-left-color:#22c55e">
        <strong>${esc(ch.inicio)}–${esc(ch.fim)}</strong> — ${esc(ch.titulo)}
        <div class="muted" style="margin-top:2px">${esc(ch.resumo)}</div>
      </div>`
    ).join("") || "<div class='muted'>Sem capítulos.</div>";
}

function renderCortes(ct) {
  const cortes = FILES.cortes || [];
  document.getElementById("cortesBody").innerHTML = ct.cortes_virais.map((c,i) => {
    const corteFile = cortes[i] || null;
    const videoSrc = corteFile ? "cortes/" + corteFile : (FILES.video ? `${FILES.video}#t=${c.inicio_sec},${c.fim_sec}` : null);
    const audioSrc = FILES.audio ? `${FILES.audio}#t=${c.inicio_sec},${c.fim_sec}` : null;
    return `<div class="card" style="margin-bottom:10px">
       <div class="label">Corte ${i+1} · ${c.inicio}–${c.fim} · ${c.duracao_min}min</div>
       <div class="quote">${esc(c.justificativa)}</div>
       <div class="grid two" style="margin-top:10px;gap:10px">
         ${videoSrc ? `
         <div class="corte-player">
           <div class="muted" style="margin-bottom:4px">🎬 Vídeo${corteFile ? " (arquivo cortado)" : ""}</div>
           <video class="corte-video" controls preload="none"
             src="${videoSrc}"
             onplay="pauseOthers(this,'video')"></video>
         </div>` : ''}
         ${audioSrc ? `
         <div class="corte-player">
           <div class="muted" style="margin-bottom:4px">🎧 Áudio</div>
           <audio class="corte-audio" controls preload="none"
             src="${audioSrc}"
             onplay="pauseOthers(this,'audio')"></audio>
         </div>` : ''}
       </div>
     </div>`;
  }).join("") || "<div class='muted'>Sem cortes identificados.</div>";
}

function pauseOthers(el, kind) {
  // pausa outros players do mesmo tipo ao dar play
  document.querySelectorAll(kind === "video" ? ".corte-video" : ".corte-audio").forEach(p => {
    if (p !== el && !p.paused) p.pause();
  });
  // pausa os players principais também
  if (kind === "video" && A.el && !A.el.paused) A.el.pause();
  if (kind === "audio" && V.el && !V.el.paused) V.el.pause();
}

function renderPopular(ca) {
  const p = ca.comentario_mais_popular;
  if (!p) { document.getElementById("popularBody").innerHTML = "<div class='muted'>Sem dados.</div>"; return; }
  document.getElementById("popularBody").innerHTML =
    `<div class="quote">[${p.timestamp}] <strong>${esc(p.usuario)}</strong>: ${esc(p.texto)}</div>`;
}

function buildSentFilters() {
  const el = document.getElementById("sentFilters");
  const opts = ["todos", ...SENT];
  el.innerHTML = opts.map(o =>
    `<button class="${o===currentSent?"active":""}" onclick="setSent('${o}')">${o}</button>`
  ).join("");
}

function setSent(s){ currentSent = s; buildSentFilters(); renderComments(); }

function renderComments() {
  const list = R.comentarios.comentarios.filter(c => currentSent==="todos" || c.sentimento===currentSent);
  const sel = list.slice(0, 50);
  document.getElementById("comments").innerHTML = sel.map(c =>
    `<li>[${c.timestamp}] <strong>${esc(c.nome||c.usuario)}</strong>
      <span class="tag ${c.sentimento}">${c.sentimento}</span><br>${esc(c.texto)}</li>`
  ).join("") || "<div class='muted'>Nenhum comentário.</div>";
}

render();
initLiveMap();
</script>
</body>
</html>
"""

    html = (
        html.replace("__DATA_INLINE__", data_inline)
        .replace("__FILES_JSON__", files_json)
        .replace("__CUES_JSON__", cues_json)
        .replace("__MAP_STOPS_JSON__", map_stops_json)
    )
    path.write_text(html, encoding="utf-8")


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #

FOLDER: Path


def main() -> None:
    global FOLDER
    ap = argparse.ArgumentParser(description="Análise completa de um VOD processado.")
    ap.add_argument("folder", help="Caminho da pasta em saida/")
    args = ap.parse_args()
    FOLDER = Path(args.folder)

    folder = FOLDER
    if not folder.is_dir():
        print(f"Pasta não encontrada: {folder}", file=sys.stderr)
        sys.exit(1)

    # 1) carrega comentários
    comments = load_comments()
    print(f"  Comentários: {len(comments)}")

    # 2) identifica videoId
    video_id = None
    comments_file = folder / "comentarios.json"
    if comments_file.exists():
        try:
            video_id = json.loads(comments_file.read_text(encoding="utf-8")).get("videoId")
        except Exception:  # noqa: BLE001
            pass
    if not video_id:
        # tenta inferir do nome da pasta ([v123456])
        m = re.search(r"\[v(\d+)\]", folder.name)
        video_id = m.group(1) if m else None

    print(f"  VideoId: {video_id}")

    # 3) métricas (com fallback se a rede falhar)
    metrics = None
    if video_id:
        try:
            metrics = compute_metrics(video_id)
        except Exception as exc:  # noqa: BLE001
            print(f"  [!] Falha ao buscar métricas: {exc}", file=sys.stderr)
    if metrics is None:
        metrics = {
            "video_id": video_id or "",
            "title": folder.name,
            "channel": "",
            "category": "",
            "created_at": "",
            "duration_seconds": 0,
            "duration_label": "—",
            "views": 0,
            "views_label": "0",
            "likes_estimado": 0,
            "likes_label": "0",
            "comentarios": len(comments),
            "taxa_likes": 0.0,
            "taxa_engajamento": 0.0,
            "followers_canal": None,
            "comparacao_canal": {
                "mediana_views": 0,
                "media_views": 0,
                "mediana_pares": 0,
                "views_vs_mediana_pct": None,
                "views_vs_media_pct": None,
                "views_vs_pares_pct": None,
                "n_videos_canal": 0,
            },
        }
    metrics["comentarios"] = len(comments)
    if metrics["views"]:
        metrics["taxa_engajamento"] = round(
            (metrics["likes_estimado"] + len(comments)) / metrics["views"] * 100, 3
        )
    print(f"  Views: {metrics['views_label']}")

    # 4) comentários: sentimento + temas + popular
    comments_analysis = build_comments_analysis(comments)
    print(f"  Sentimentos: {len(comments_analysis['sentimentos'])} categorias")
    print(f"  Temas: {len(comments_analysis['temas'])}")

    # 5) conteúdo: transcrição
    blocks: list[dict] = []
    srt_file = folder / "audio.srt"
    if srt_file.exists():
        blocks = parse_srt_to_blocks(srt_file.read_text(encoding="utf-8"))
        print(f"  Blocos de transcrição: {len(blocks)}")
    else:
        print("  [!] audio.srt não encontrado — análise de conteúdo limitada", file=sys.stderr)

    content = build_content_analysis(blocks, comments_analysis, metrics)

    # 6) engajamento: fala vs chat, correlação, picos, bordões, alertas
    engagement = build_engagement_analysis(blocks, comments_analysis, metrics)
    print(f"  Engajamento: {len(engagement.get('minuto_buckets', []))} minutos analisados")

    # 7) insights
    insights = build_insights(metrics, comments_analysis, content)

    # 8) monta o relatório (o "banco de dados")
    report = {
        "gerado_em": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
        "metricas": metrics,
        "comentarios": comments_analysis,
        "conteudo": content,
        "engajamento": engagement,
        "insights": insights,
    }

    # 9) exporta
    json_path = folder / "relatorio.json"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  ✓ {json_path.name}")

    md_path = folder / "relatorio.md"
    write_markdown(report, md_path)
    print(f"  ✓ {md_path.name}")

    csv_path = folder / "relatorio.csv"
    write_csv(comments_analysis["comentarios"], csv_path)
    print(f"  ✓ {csv_path.name}")

    dash_path = folder / "dashboard.html"
    write_dashboard(report, dash_path, blocks)
    print(f"  ✓ {dash_path.name}")


if __name__ == "__main__":
    main()
