#!/usr/bin/env python3
"""Atualiza saida/index.html com os VODs e métricas já preparados."""
from __future__ import annotations

import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SAIDA = ROOT / "saida"
INDEX = SAIDA / "index.html"
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".m4v"}
API_URL = os.environ.get("DEEPSEEK_API_URL", "https://api.deepseek.com/chat/completions")
MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")


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
            }
        )

    return sorted(vods, key=lambda vod: (vod["created_at"], vod["generated_at"], vod["title"]), reverse=True)


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
    if vod["video"]:
        video_name = urllib.parse.quote(vod["video"].name, safe="")
        return f'<video src="{folder}/{video_name}" muted playsinline preload="metadata"></video>'
    if vod["thumbnail"].startswith(("https://", "http://")):
        return f'<img src="{_escape(vod["thumbnail"])}" alt="{_escape(vod["title"])}" loading="lazy" onerror="this.style.display=\'none\'" />'
    return '<div class="ep-placeholder" aria-hidden="true">VOD</div>'


def render_stats(vods: list[dict]) -> str:
    views = [vod["views"] for vod in vods if vod["views"] is not None]
    comments = [vod["comments"] for vod in vods if vod["comments"] is not None]
    durations = [vod["duration"] for vod in vods if vod["duration"] is not None]
    total_views = sum(views) if views else None
    total_comments = sum(comments) if comments else None
    total_duration = sum(durations) if durations else None
    local_videos = sum(vod["video"] is not None for vod in vods)
    return "\n".join(
        [
            f'<div class="stat"><div class="v">{_display_count(total_views)}</div><div class="l">Views totais</div></div>',
            f'<div class="stat"><div class="v">{_display_count(total_comments)}</div><div class="l">Comentários</div></div>',
            f'<div class="stat"><div class="v">{_display_duration(total_duration)}</div><div class="l">Conteúdo analisado</div></div>',
            f'<div class="stat"><div class="v"><img src="https://api.iconify.design/lucide/video.svg?color=%23f59e0b" alt="" width="24" height="24" loading="lazy" /></div><div class="l">{local_videos} vídeos locais</div></div>',
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
            f'<div class="ep-stat"><span class="k"><img src="https://api.iconify.design/lucide/{icon}.svg?color=%23ffffff" alt="" width="14" height="14" loading="lazy" /> {value}</span><span class="v">{label}</span></div>'
            for icon, value, label in stats
        )
        extra_chips = sentiment
        if vod["words_per_minute"]:
            extra_chips += f'<span class="ep-chip"><img src="https://api.iconify.design/lucide/mic.svg?color=%23cbd5e1" alt="" width="12" height="12" loading="lazy" /> {vod["words_per_minute"]} pal/min</span>'
        cards.append(
            f'''<a href="{folder}/dashboard.html" class="ep-card">
          <div class="ep-thumb">{_media_markup(vod)}<span class="ep-dur">{duration}</span></div>
          <div class="ep-body">
            <div class="ep-top"><span class="ep-date">{date}</span></div>
            <div class="ep-title">{title}</div>
            <p class="ep-summary">{_escape(summary)}</p>
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
    document = INDEX.read_text(encoding="utf-8")
    try:
        document = replace_section(document, "<!-- AUTO_STATS_START -->", "<!-- AUTO_STATS_END -->", render_stats(vods))
        document = replace_section(document, "<!-- AUTO_EPISODES_START -->", "<!-- AUTO_EPISODES_END -->", render_episodes(vods, summaries))
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