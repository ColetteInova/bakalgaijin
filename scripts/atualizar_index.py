#!/usr/bin/env python3
"""Atualiza saida/index.html com os VODs e métricas já preparados."""
from __future__ import annotations

import collections
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SAIDA = ROOT / "saida"
INDEX = SAIDA / "index.html"
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".m4v"}
API_URL = os.environ.get("DEEPSEEK_API_URL", "https://api.deepseek.com/chat/completions")
MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")
HOSTING_MONTHLY_USD = 1.0
CLAUDE_MONTHLY_USD = 20.0
R2_STORAGE_GB_PER_CARD = 19
R2_FREE_STORAGE_GB = 10
R2_PRICE_PER_GB_MONTH_USD = 0.015
EPISODES_INITIAL_LIMIT = 6


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def find_video(folder: Path) -> Path | None:
    return next(
        (path for path in sorted(folder.iterdir()) if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS),
        None,
    )


def load_vods() -> list[dict]:
    vods = []
    for folder in SAIDA.iterdir():
        if not folder.is_dir():
            continue
        report = read_json(folder / "relatorio.json")
        if not report or not (folder / "dashboard.html").is_file():
            continue

        metrics = report.get("metricas") or {}
        comments_data = report.get("comentarios") or {}
        comments_file = read_json(folder / "comentarios.json")
        title = metrics.get("title") or comments_file.get("title") or folder.name
        video_id = str(metrics.get("video_id") or comments_file.get("videoId") or "")
        count = metrics.get("comentarios") or comments_data.get("total_comentarios") or comments_file.get("total")
        duration = metrics.get("duration_seconds") or metrics.get("duracao_segundos")
        map_meta = _map_meta(folder / "mapa" / "geoloc.json")
        clima = _clima(folder / "mapa" / "clima.json")

        vods.append(
            {
                "folder": folder,
                "title": str(title),
                "video_id": video_id,
                "views": _positive_int(metrics.get("views")),
                "comments": _positive_int(count),
                "likes": _positive_int(metrics.get("likes_estimado")),
                "duration": _positive_int(duration),
                "engagement": _positive_float(metrics.get("taxa_engajamento")),
                "created_at": str(metrics.get("created_at") or ""),
                "generated_at": str(report.get("gerado_em") or ""),
                "thumbnail": str(metrics.get("thumbnail") or ""),
                "video": find_video(folder),
                "themes": _top_themes(comments_data.get("temas")),
                "sentiment": _top_sentiment(comments_data.get("sentimentos")),
                "cuts": len((report.get("conteudo") or {}).get("cortes_virais") or []),
                "words_per_minute": _positive_int((report.get("engajamento") or {}).get("palavras_por_minuto")),
                "local_label": str(report.get("local_label") or ""),
                "followers": _positive_int(metrics.get("followers_canal")),
                "marcos": map_meta[0],
                "estabelecimentos": map_meta[1],
                "clima": clima,
                "top_commenter": _top_commenter(comments_file),
                "popular_comment": _popular_comment(comments_data.get("comentario_mais_popular")),
            }
        )

    return sorted(
        vods,
        key=lambda vod: (
            _launch_datetime(vod["created_at"]),
            vod["generated_at"],
            vod["title"],
        ),
        reverse=True,
    )


def _launch_datetime(value: str) -> datetime:
    try:
        date = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)
    if date.tzinfo is None:
        date = date.replace(tzinfo=timezone.utc)
    return date.astimezone(timezone.utc)


def _map_meta(geoloc_path: Path) -> tuple[int, int]:
    geoloc = read_json(geoloc_path)
    marcos = [
        value for key, value in geoloc.items()
        if key not in ("local", "bairro") and isinstance(value, dict) and "lat" in value and "lng" in value
    ]
    estabelecimentos = sum(
        len(value.get("estabelecimentos") or []) for value in marcos
        if isinstance(value.get("estabelecimentos"), list)
    )
    return len(marcos), estabelecimentos


def _clima(clima_path: Path) -> dict | None:
    clima = read_json(clima_path)
    if not clima:
        return None
    return {
        "temp_med": _positive_float(clima.get("temp_med")),
        "precip": _positive_float(clima.get("precip_total")),
    }


def _top_commenter(comments_file: dict) -> str:
    counter = collections.Counter()
    for comment in comments_file.get("comments") or []:
        if not isinstance(comment, dict):
            continue
        if _is_system_message(comment.get("text")):
            continue
        name = str(comment.get("displayName") or comment.get("login") or "").strip()
        if name:
            counter[name] += 1
    return counter.most_common(1)[0][0] if counter else ""


_SYSTEM_MSG_RE = re.compile(
    r"\b(subscribed|subscribing|gifted|gifting|raided|raiding|is hosting|hosting them|cheer[0-9]+|cheered|watch streak|consecutive streams|sparked|watch party)\b",
    re.IGNORECASE,
)


def _is_system_message(text: object) -> bool:
    return bool(isinstance(text, str) and _SYSTEM_MSG_RE.search(text))


def _popular_comment(popular: object) -> dict | None:
    if not isinstance(popular, dict):
        return None
    texto = str(popular.get("texto") or "").strip()
    if not texto or _is_system_message(texto):
        return None
    usuario = str(popular.get("usuario") or "").strip()
    return {"usuario": usuario, "texto": texto[:140]}


def _positive_int(value: object) -> int | None:
    try:
        result = int(float(value))
        return result if result > 0 else None
    except (TypeError, ValueError, OverflowError):
        return None


def _positive_float(value: object) -> float | None:
    try:
        result = float(value)
        return result if result > 0 else None
    except (TypeError, ValueError, OverflowError):
        return None


def _top_themes(themes: object) -> list[str]:
    if not isinstance(themes, list):
        return []
    ranked = sorted(
        (item for item in themes if isinstance(item, dict) and item.get("tema")),
        key=lambda item: item.get("n_comentarios") or 0,
        reverse=True,
    )
    return [str(item["tema"])[:80] for item in ranked[:4]]


def _top_sentiment(sentiments: object) -> str:
    if not isinstance(sentiments, list):
        return ""
    ranked = [item for item in sentiments if isinstance(item, dict) and item.get("categoria")]
    if not ranked:
        return ""
    return str(max(ranked, key=lambda entry: entry.get("n") or 0)["categoria"])


def deepseek_summaries(vods: list[dict]) -> dict[str, str]:
    api_key = os.environ.get("DEEPSEEK_API_KEY")
    if not api_key or not vods:
        if not api_key:
            print("  [!] DEEPSEEK_API_KEY ausente; usando descrições baseadas nos temas.", file=sys.stderr)
        return {}

    inputs = [
        {"video_id": vod["video_id"], "titulo": vod["title"], "temas_do_chat": vod["themes"]}
        for vod in vods
    ]
    prompt = (
        "Para cada VOD, escreva uma descrição factual de uma frase em português brasileiro, "
        "com no máximo 150 caracteres, usando somente título e temas fornecidos. "
        "Não invente acontecimentos. Responda exclusivamente com JSON no formato "
        '{"video_id": "descrição"}. Dados: '
        + json.dumps(inputs, ensure_ascii=False)
    )
    body = json.dumps(
        {
            "model": MODEL,
            "messages": [
                {"role": "system", "content": "Você resume metadados de vídeos sem acrescentar fatos."},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.2,
            "max_tokens": max(500, len(vods) * 100),
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        API_URL,
        data=body,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            response_data = json.loads(response.read().decode("utf-8"))
        content = response_data["choices"][0]["message"]["content"].strip()
        content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content, flags=re.IGNORECASE)
        parsed = json.loads(content)
        if not isinstance(parsed, dict):
            raise ValueError("a resposta não é um objeto JSON")
        valid_ids = {vod["video_id"] for vod in vods}
        return {
            str(video_id): str(summary).strip()[:180]
            for video_id, summary in parsed.items()
            if str(video_id) in valid_ids and isinstance(summary, str) and summary.strip()
        }
    except Exception as exc:  # noqa: BLE001
        print(f"  [!] DeepSeek indisponível ({exc}); usando descrições baseadas nos temas.", file=sys.stderr)
        return {}


def _escape(value: object) -> str:
    return html.escape(str(value), quote=True)


def _display_count(value: int | None) -> str:
    if value is None:
        return "—"
    if value >= 1_000_000:
        return f"{value / 1_000_000:.1f}".replace(".", ",") + " mi"
    if value >= 1_000:
        return f"{value / 1_000:.1f}".replace(".", ",") + " mil"
    return f"{value:,}".replace(",", ".")


def _display_duration(seconds: int | None) -> str:
    if seconds is None:
        return "—"
    hours, remainder = divmod(seconds, 3600)
    minutes = remainder // 60
    return f"{hours}h{minutes:02d}" if hours else f"{minutes}min"


def _display_date(value: str, generated_at: str) -> str:
    for candidate, prefix in ((value, ""), (generated_at, "Analisado ")):
        if not candidate:
            continue
        try:
            date = datetime.fromisoformat(candidate.replace("Z", "+00:00"))
            months = ("jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez")
            return f"{prefix}{date.day} {months[date.month - 1]} {date.year}"
        except ValueError:
            continue
    return "Data indisponível"


def _media_markup(vod: dict) -> str:
    folder = urllib.parse.quote(vod["folder"].name, safe="")
    thumb = vod["thumbnail"] if vod["thumbnail"].startswith(("https://", "http://")) else ""
    parts = []
    # vídeo local fica por baixo: serve de fallback se a thumb da Twitch falhar
    if vod["video"]:
        video_name = urllib.parse.quote(vod["video"].name, safe="")
        parts.append(f'<video src="{folder}/{video_name}" muted playsinline preload="metadata"></video>')
    # thumb da Twitch por cima: respeita a imagem oficial do VOD
    if thumb:
        parts.append(
            f'<img class="ep-thumb-poster" src="{_escape(thumb)}" alt="{_escape(vod["title"])}" '
            f"loading=\"lazy\" onerror=\"this.style.display='none'\" />"
        )
    if parts:
        return "".join(parts)
    return '<div class="ep-placeholder" aria-hidden="true">VOD</div>'


def render_stats(vods: list[dict]) -> str:
    views = [vod["views"] for vod in vods if vod["views"] is not None]
    comments = [vod["comments"] for vod in vods if vod["comments"] is not None]
    durations = [vod["duration"] for vod in vods if vod["duration"] is not None]
    total_views = sum(views) if views else None
    total_comments = sum(comments) if comments else None
    total_duration = sum(durations) if durations else None
    total_cuts = sum(vod["cuts"] for vod in vods)
    total_marcos = sum(vod["marcos"] for vod in vods)
    total_estabelecimentos = sum(vod["estabelecimentos"] for vod in vods)
    return "\n".join(
        [
            f'<div class="stat"><div class="v">{_display_count(total_views)}</div><div class="l">Views totais</div></div>',
            f'<div class="stat"><div class="v">{_display_count(total_comments)}</div><div class="l">Comentários</div></div>',
            f'<div class="stat"><div class="v">{_display_duration(total_duration)}</div><div class="l">Conteúdo analisado</div></div>',
            f'<div class="stat"><div class="v">{total_cuts}</div><div class="l">Cortes virais</div></div>',
            f'<div class="stat"><div class="v">{total_marcos}</div><div class="l">Marcos no mapa</div></div>',
            f'<div class="stat"><div class="v">{total_estabelecimentos}</div><div class="l">Lugares identificados</div></div>',
        ]
    )


def render_episodes(vods: list[dict], summaries: dict[str, str]) -> str:
    cards = []
    max_engagement = max((vod["engagement"] or 0 for vod in vods), default=0)
    for vod in vods:
        folder = urllib.parse.quote(vod["folder"].name, safe="")
        title = _escape(vod["title"])
        summary = summaries.get(vod["video_id"], "")
        if not summary and vod["themes"]:
            summary = "Destaques do chat: " + ", ".join(vod["themes"][:3]) + "."
        if not summary:
            summary = "VOD preparado com análise de comentários e transcrição."

        engagement = vod["engagement"]
        engagement_text = "—" if engagement is None else f"{engagement:.1f}%"
        fill = min(100, engagement / max_engagement * 100) if engagement and max_engagement else 0
        date = _escape(_display_date(vod["created_at"], vod["generated_at"]))
        duration = _escape(_display_duration(vod["duration"]))
        sentiment = f'<span class="ep-chip ep-chip-sent">{_escape(vod["sentiment"])}</span>' if vod["sentiment"] else ""
        stats = [
            ("eye", _display_count(vod["views"]), "views"),
            ("message-circle", _display_count(vod["comments"]), "comentários"),
            ("thumbs-up", _display_count(vod["likes"]), "likes"),
            ("scissors", str(vod["cuts"]), "cortes"),
        ]
        stat_markup = "".join(
            f'<div class="ep-stat"><span class="k"><img src="icons/lucide/{icon}__ffffff.svg" alt="" width="14" height="14" loading="lazy" /> {value}</span><span class="v">{label}</span></div>'
            for icon, value, label in stats
        )
        extra_chips = sentiment
        if vod["local_label"]:
            extra_chips += f'<span class="ep-chip"><img src="icons/lucide/map-pin__cbd5e1.svg" alt="" width="12" height="12" loading="lazy" /> {_escape(vod["local_label"])}</span>'
        if vod["marcos"]:
            extra_chips += f'<span class="ep-chip"><img src="icons/lucide/map__cbd5e1.svg" alt="" width="12" height="12" loading="lazy" /> {vod["marcos"]} marcos</span>'
        if vod["estabelecimentos"]:
            extra_chips += f'<span class="ep-chip"><img src="icons/lucide/store__cbd5e1.svg" alt="" width="12" height="12" loading="lazy" /> {vod["estabelecimentos"]} lugares</span>'
        if vod["clima"] and vod["clima"]["temp_med"]:
            clima_text = f'{vod["clima"]["temp_med"]:.0f}°C'
            if vod["clima"]["precip"]:
                clima_text += f' · {vod["clima"]["precip"]:.1f}mm'
            extra_chips += f'<span class="ep-chip"><img src="icons/lucide/thermometer__cbd5e1.svg" alt="" width="12" height="12" loading="lazy" /> {clima_text}</span>'
        if vod["top_commenter"]:
            extra_chips += f'<span class="ep-chip"><img src="icons/lucide/megaphone__cbd5e1.svg" alt="" width="12" height="12" loading="lazy" /> {_escape(vod["top_commenter"])}</span>'
        if vod["words_per_minute"]:
            extra_chips += f'<span class="ep-chip"><img src="icons/lucide/mic__cbd5e1.svg" alt="" width="12" height="12" loading="lazy" /> {vod["words_per_minute"]} pal/min</span>'
        quote_markup = ""
        if vod["popular_comment"]:
            popular = vod["popular_comment"]
            author = f'<b>@{_escape(popular["usuario"])}</b>' if popular["usuario"] else ""
            quote_markup = f'<div class="ep-quote">{author} {_escape(popular["texto"])}</div>'
        cards.append(
            f'''<a href="{folder}/dashboard.html" class="ep-card">
          <div class="ep-thumb">{_media_markup(vod)}<span class="ep-dur">{duration}</span></div>
          <div class="ep-body">
            <div class="ep-top"><span class="ep-date">{date}</span></div>
            <div class="ep-title">{title}</div>
            <p class="ep-summary">{_escape(summary)}</p>
            {quote_markup}
            <div class="ep-stats">{stat_markup}</div>
            <div class="ep-eng"><div class="ep-eng-fill" style="width:{fill:.1f}%"></div></div>
            <div class="ep-eng-label">{engagement_text} engajamento</div>
            <div class="ep-tags">{extra_chips}</div>
          </div>
        </a>'''
        )
    if not cards:
        return '<div class="empty">Nenhum VOD preparado ainda.</div>'
    return "\n".join(cards)


def render_episode_toggle(vods: list[dict]) -> str:
    if len(vods) <= EPISODES_INITIAL_LIMIT:
        return ""
    return (
        '<button class="episodes-toggle" id="episodeToggle" type="button" '
        'aria-haspopup="dialog" aria-controls="episodesModal" '
        'onclick="openEpisodesModal()">Ver mais</button>'
    )


def _all_comments(vods: list[dict]) -> list[dict]:
    comments = []
    for vod in vods:
        data = read_json(vod["folder"] / "comentarios.json")
        comments.extend(
            comment for comment in data.get("comments") or []
            if isinstance(comment, dict) and not _is_system_message(comment.get("text"))
        )
    return comments


def render_fans(comments: list[dict]) -> str:
    counter = collections.Counter()
    for comment in comments:
        name = str(comment.get("displayName") or comment.get("login") or "").strip()
        if name:
            counter[name] += 1
    rows = []
    for rank, (name, count) in enumerate(counter.most_common(12), start=1):
        rows.append(
            f'<div class="fan-row"><span class="fan-rank">#{rank}</span>'
            f'<span class="fan-name">{_escape(name)}</span><span class="fan-count">{count} msgs</span></div>'
        )
    return "\n".join(rows) if rows else '<div class="empty">Sem comentários ainda.</div>'


_WORD_RE = re.compile(r"[a-zà-ú0-9]+")

_STOPWORDS = {
    "o", "a", "os", "as", "de", "do", "da", "dos", "das", "e", "é", "que",
    "no", "na", "nos", "nas", "em", "um", "uma", "uns", "umas", "se", "te",
    "me", "tu", "você", "vc", "ele", "ela", "eles", "elas", "não", "nao",
    "ai", "aí", "ta", "tá", "to", "tô", "pra", "pro", "com", "por", "mas",
    "ou", "como", "isso", "esse", "essa", "estes", "estas", "aquilo",
    "aquele", "aquela", "está", "esta", "vai", "tem", "foi", "ser", "era",
    "são", "tão", "já", "lá", "li", "aqui", "ali", "hoje", "agora", "depois",
    "antes", "muito", "mais", "menos", "sim", "vez", "vezes", "todo", "toda",
    "todos", "todas", "só", "so", "bem", "mal", "seu", "sua", "meu", "minha",
    "tbm", "tb", "pode", "vou", "né", "ne",
}


def _clean_tokens(comment: dict) -> list[str]:
    words = _WORD_RE.findall((comment.get("text") or "").lower())
    return [word for index, word in enumerate(words) if index == 0 or word != words[index - 1]]


def render_bordoes(comments: list[dict]) -> str:
    bigrams = collections.Counter()
    trigrams = collections.Counter()
    for comment in comments:
        words = _clean_tokens(comment)
        for index in range(len(words) - 1):
            bigrams[" ".join(words[index : index + 2])] += 1
        for index in range(len(words) - 2):
            trigrams[" ".join(words[index : index + 3])] += 1

    def is_stop_only(phrase: str) -> bool:
        return all(word in _STOPWORDS for word in phrase.split())

    strong_trigrams = {phrase for phrase, count in trigrams.items() if count >= 4}
    covered = {
        bigram
        for phrase in strong_trigrams
        for bigram in (" ".join(phrase.split()[:2]), " ".join(phrase.split()[1:]))
    }
    candidates = [
        (phrase, count)
        for phrase, count in bigrams.items()
        if count >= 4 and phrase not in covered and not is_stop_only(phrase)
    ] + [
        (phrase, count)
        for phrase, count in trigrams.items()
        if count >= 4 and not is_stop_only(phrase)
    ]
    ranked = sorted(candidates, key=lambda item: item[1], reverse=True)[:10]
    if not ranked:
        return '<div class="empty">Sem bordões ainda.</div>'
    return "\n".join(
        f'<span class="bordao">"{_escape(phrase)}" <em>×{count}</em></span>' for phrase, count in ranked
    )


_EMOJI_RE = re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF\u2764\u2665\u2B50]")


def render_emojis(comments: list[dict]) -> str:
    counter = collections.Counter()
    for comment in comments:
        counter.update(_EMOJI_RE.findall(comment.get("text") or ""))
    ranked = [(emoji, count) for emoji, count in counter.most_common(12) if len(emoji.strip()) == 1]
    if not ranked:
        return '<div class="empty">Sem reações ainda.</div>'
    return "\n".join(
        f'<span class="emoji-chip">{emoji} <em>×{count}</em></span>' for emoji, count in ranked
    )


def render_bakalovers() -> str:
    bakalovers_file = ROOT / ".bakalovers.json"
    try:
        data = json.loads(bakalovers_file.read_text(encoding="utf-8"))
        data = data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        data = []
    members = [member for member in data if isinstance(member, dict) and member.get("official")]
    if not members:
        return '<div class="empty" style="grid-column:1/-1">Nenhum bakalover oficial cadastrado ainda.</div>'

    cards = []
    for member in members:
        nome = _escape(str(member.get("nome") or "").strip())
        apelido = _escape(str(member.get("apelido") or "").strip())
        foto = str(member.get("foto") or member.get("avatar") or "").strip()
        twitch = str(member.get("twitch") or "").strip()
        inicial = _escape((str(member.get("nome") or member.get("apelido") or "B")[:1]).upper())
        avatar = f'<div class="bakalover-avatar-wrap"><div class="bakalover-avatar-fallback">{inicial}</div>'
        if foto:
            avatar += (
                f'<img class="bakalover-avatar" src="{_escape(foto)}" alt="{nome}" '
                f'loading="lazy" onerror="this.remove()" />'
            )
        avatar += "</div>"
        links = ""
        if twitch:
            links = (
                f'<div class="bakalover-links">'
                f'<a class="bakalover-link" href="https://twitch.tv/{_escape(twitch)}" target="_blank" rel="noopener">'
                f'<img src="https://cdn.simpleicons.org/twitch/white" alt="" width="12" height="12" loading="lazy" />{_escape(twitch)}</a>'
                f'</div>'
            )
        # tag @ só aparece quando NÃO há link da Twitch (evita duplicar o @login)
        tag = "" if twitch else f'<div class="bakalover-tag">@{apelido}</div>'
        apoios = [a for a in (member.get("apoios") or []) if isinstance(a, dict)]
        apoios_html = ""
        if apoios:
            chips = "".join(
                '<span class="bakalover-apoio" title="Apoia: '
                + _escape(str(a.get("nome") or ""))
                + '">'
                + _escape(str(a.get("emoji") or ""))
                + "</span>"
                for a in apoios
            )
            apoios_html = f'<div class="bakalover-apoios">{chips}</div>'
        cards.append(
            f'<div class="bakalover-card">{avatar}'
            f'<div class="bakalover-name">{nome}</div>'
            + tag
            + links
            + apoios_html
            + '<span class="bakalover-official">Bakalover Oficial</span></div>'
        )
    return "\n".join(cards)


def render_costs(vods: list[dict]) -> str:
    card_count = len(vods)
    storage_gb = card_count * R2_STORAGE_GB_PER_CARD
    billable_storage_gb = max(0, storage_gb - R2_FREE_STORAGE_GB)
    r2_monthly_usd = billable_storage_gb * R2_PRICE_PER_GB_MONTH_USD
    total_monthly_usd = HOSTING_MONTHLY_USD + CLAUDE_MONTHLY_USD + r2_monthly_usd
    return "\n".join(
        [
            f'<div class="cost-item"><span class="cost-label">Cards no índice</span><strong>{card_count}</strong></div>',
            f'<div class="cost-item"><span class="cost-label">Armazenamento R2 estimado</span><strong>{storage_gb} GB</strong></div>',
            f'<div class="cost-item"><span class="cost-label">Hospedagem fixa</span><strong>US$ {HOSTING_MONTHLY_USD:.2f}/mês</strong></div>',
            f'<div class="cost-item"><span class="cost-label">Claude Opus/Fable</span><strong>US$ {CLAUDE_MONTHLY_USD:.2f}/mês</strong></div>',
            f'<div class="cost-item"><span class="cost-label">Armazenamento R2</span><strong>US$ {r2_monthly_usd:.2f}/mês</strong></div>',
            f'<div class="cost-item cost-total"><span class="cost-label">Total mensal estimado</span><strong>US$ {total_monthly_usd:.2f}/mês</strong></div>',
        ]
    )


def replace_section(document: str, start: str, end: str, content: str) -> str:
    pattern = re.compile(re.escape(start) + r".*?" + re.escape(end), re.DOTALL)
    replacement = f"{start}\n{content}\n    {end}"
    updated, count = pattern.subn(lambda _: replacement, document, count=1)
    if count != 1:
        raise ValueError(f"marcadores ausentes ou duplicados: {start} / {end}")
    return updated


def main() -> int:
    if not INDEX.is_file():
        print(f"Índice não encontrado: {INDEX}", file=sys.stderr)
        return 1

    vods = load_vods()
    summaries = deepseek_summaries(vods)
    comments = _all_comments(vods)
    document = INDEX.read_text(encoding="utf-8")
    try:
        document = replace_section(document, "<!-- AUTO_STATS_START -->", "<!-- AUTO_STATS_END -->", render_stats(vods))
        document = replace_section(document, "<!-- AUTO_EPISODES_START -->", "<!-- AUTO_EPISODES_END -->", render_episodes(vods[:EPISODES_INITIAL_LIMIT], summaries))
        document = replace_section(document, "<!-- AUTO_EPISODES_TOGGLE_START -->", "<!-- AUTO_EPISODES_TOGGLE_END -->", render_episode_toggle(vods))
        document = replace_section(document, "<!-- AUTO_EPISODES_MODAL_START -->", "<!-- AUTO_EPISODES_MODAL_END -->", render_episodes(vods, summaries))
        document = replace_section(document, "<!-- AUTO_FANS_START -->", "<!-- AUTO_FANS_END -->", render_fans(comments))
        document = replace_section(document, "<!-- AUTO_BAKALOVERS_START -->", "<!-- AUTO_BAKALOVERS_END -->", render_bakalovers())
        document = replace_section(document, "<!-- AUTO_BORDOES_START -->", "<!-- AUTO_BORDOES_END -->", render_bordoes(comments))
        document = replace_section(document, "<!-- AUTO_EMOJIS_START -->", "<!-- AUTO_EMOJIS_END -->", render_emojis(comments))
        document = replace_section(document, "<!-- AUTO_COSTS_START -->", "<!-- AUTO_COSTS_END -->", render_costs(vods))

        followers = [vod["followers"] for vod in vods if vod["followers"] is not None]
        if followers:
            document = replace_section(
                document, "<!-- AUTO_FOLLOWERS_START -->", "<!-- AUTO_FOLLOWERS_END -->",
                _display_count(max(followers)),
            )
        document, count = re.subn(
            r"<!-- AUTO_LIVES_COUNT_START -->.*?<!-- AUTO_LIVES_COUNT_END -->",
            f"<!-- AUTO_LIVES_COUNT_START -->{len(vods)}<!-- AUTO_LIVES_COUNT_END -->",
            document,
            count=1,
            flags=re.DOTALL,
        )
        if count != 1:
            raise ValueError("marcadores da contagem de lives ausentes ou duplicados")
    except ValueError as exc:
        print(f"Não foi possível atualizar o índice: {exc}", file=sys.stderr)
        return 1

    temporary = INDEX.with_suffix(".html.tmp")
    temporary.write_text(document, encoding="utf-8")
    temporary.replace(INDEX)
    print(f"Índice atualizado com {len(vods)} VOD(s); descrições DeepSeek: {len(summaries)}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())