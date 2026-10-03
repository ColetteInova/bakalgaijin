#!/usr/bin/env python3
"""Gera o kit de mídia de episódios JÁ analisados, para divulgação nas redes.

Para cada pasta em saida/:
  - social/card-<id>.png            -> card de estatísticas (1200x675) para X/WhatsApp
  - social/clipe-<n>-1080x1920.mp4  -> cortes virais em VERTICAL (TikTok/Reels/Shorts)
                                       com legendas queimadas (audio.srt)
  - social/kit-de-midia.md          -> textos prontos (X, TikTok, WhatsApp) + links

Usa os cortes_virais do relatorio.json; sem eles, janelas fixas da live.

Uso:
    .venv-ia/bin/python scripts/kit_midia.py [pasta1 pasta2 ...] \
        [--clipes N] [--duracao-max S] [--sem-clipes] [--sem-card]
Sem argumentos, gera o kit de todas as pastas de saida/.
"""
from __future__ import annotations

import argparse
import functools
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

# stdout em arquivo (background) não buferiza: o tail do log mostra o progresso
print = functools.partial(print, flush=True)  # noqa: A001

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import preparar  # noqa: E402

SITE_URL = preparar.os.environ.get("SITE_URL", "https://www.bakalovers.com.br").rstrip("/")
VIDEO_EXTS = {".mp4", ".webm", ".mov", ".m4v"}
VIDEO_PREFER = ["video.mp4", "video_720.mp4", "video_480.mp4"]
PAD_SEC = 2.0          # folga antes/depois da janela do corte
W_V, H_V = 1080, 1920  # formato vertical
FONT_DIR = Path("/System/Library/Fonts/Supplemental")

# --------------------------------------------------------------------------- #
# Card de estatísticas
# --------------------------------------------------------------------------- #

BG_TOP = (27, 36, 64)
BG_BOTTOM = (15, 23, 42)
PANEL = (30, 41, 59)
BORDER = (51, 65, 85)
TEXT = (238, 242, 255)
MUTED = (148, 163, 184)
ACCENT = (168, 85, 247)
GREEN = (34, 197, 94)
GOLD = (245, 158, 11)
LINK_BLUE = (165, 180, 252)


def _load_font(name: str, size: int):
    try:
        from PIL import ImageFont

        path = FONT_DIR / name
        if path.is_file():
            return ImageFont.truetype(str(path), size)
        for alt in ("Arial Unicode.ttf", "Arial.ttf", "Helvetica.ttc"):
            p = FONT_DIR / alt
            if p.is_file():
                return ImageFont.truetype(str(p), size)
    except Exception:  # noqa: BLE001
        pass
    from PIL import ImageFont

    return ImageFont.load_default(size)


def _wrap(draw, text: str, font, max_w: int) -> list[str]:
    words = text.split()
    lines: list[str] = []
    cur = ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=font) <= max_w:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def _gradient_bg(size: tuple[int, int]):
    from PIL import Image

    w, h = size
    col = Image.new("RGB", (1, h))
    px = col.load()
    for y in range(h):
        t = y / max(1, h - 1)
        px[0, y] = (
            int(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t),
            int(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t),
            int(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t),
        )
    return col.resize((w, h))


def _card_png(report: dict, folder: Path, out: Path) -> bool:
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return False

    mid = report.get("metricas") or {}
    title = str(mid.get("title") or folder.name).strip().upper()
    channel = str(mid.get("channel") or "").strip()
    local = str(report.get("local_label") or "Japão")
    views = str(mid.get("views_label") or "").strip()
    likes = str(mid.get("likes_label") or "").strip()
    dur = str(mid.get("duration_label") or "").strip()
    n_comments = (report.get("comentarios") or {}).get("total_comentarios") or 0
    created = str(mid.get("created_at") or "")
    try:
        data = datetime.fromisoformat(created.replace("Z", "+00:00")).strftime("%d/%m/%Y")
    except ValueError:
        data = created[:10] if created else ""
    trechos = [
        (c.get("trecho") or "").strip()
        for c in ((report.get("conteudo") or {}).get("cortes_virais") or [])[:3]
    ]
    trechos = [t for t in trechos if t]

    W, H = 1200, 675
    img = _gradient_bg((W, H))
    d = ImageDraw.Draw(img)

    f_brand = _load_font("Arial Bold.ttf", 22)
    f_title = _load_font("Arial Bold.ttf", 54)
    f_sub = _load_font("Arial.ttf", 27)
    f_chip = _load_font("Arial Bold.ttf", 27)
    f_bullet = _load_font("Arial.ttf", 26)
    f_footer = _load_font("Arial.ttf", 23)

    # pill da marca
    brand = "bakalovers.com.br"
    bw = d.textlength(brand, font=f_brand) + 36
    d.rounded_rectangle([36, 32, 36 + bw, 70], radius=19, fill=PANEL, outline=ACCENT, width=2)
    d.text((54, 44), brand, font=f_brand, fill=LINK_BLUE)

    # título (até 2 linhas)
    title_lines = _wrap(d, title, f_title, W - 80)[:2]
    if len(_wrap(d, title, f_title, W - 80)) > 2:
        title_lines[-1] = title_lines[-1].rstrip() + "…"
    y = 100
    for line in title_lines:
        d.text((40, y), line, font=f_title, fill=TEXT)
        y += 66
    y += 4

    sub_bits = [b for b in (channel, data, local) if b]
    if sub_bits:
        d.text((40, y), " · ".join(sub_bits), font=f_sub, fill=MUTED)
        y += 46

    # chips de estatísticas
    chips = []
    if views:
        chips.append(f"{views} views")
    if likes:
        chips.append(f"{likes} curtidas")
    if dur:
        chips.append(dur)
    if n_comments:
        chips.append(f"{n_comments} comentários")
    if local:
        chips.append(local)
    x = 40
    for chip in chips[:5]:
        cw = d.textlength(chip, font=f_chip) + 40
        d.rounded_rectangle([x, y, x + cw, y + 54], radius=27, fill=PANEL, outline=BORDER, width=1)
        d.text((x + 20, y + 12), chip, font=f_chip, fill=GOLD if "coment" in chip else TEXT)
        x += cw + 14
    y += 84

    # destaques (trechos dos cortes virais)
    if trechos:
        d.text((40, y), "DESTAQUES", font=f_brand, fill=ACCENT)
        y += 38
        for t in trechos:
            t = t if len(t) <= 110 else t[:107] + "…"
            d.ellipse([40, y + 8, 48, y + 16], fill=GREEN)
            d.text((58, y), t, font=f_bullet, fill=(203, 213, 225))
            y += 42
    y = max(y, H - 70)

    # rodapé
    url = f"bakalovers.com.br/{folder.name}/dashboard.html"
    d.text((40, y + 8), url, font=f_footer, fill=LINK_BLUE)

    img.save(out, format="PNG")
    return True


def _card_svg(report: dict, folder: Path, out: Path) -> None:
    """Fallback sem Pillow: card em SVG (abre em qualquer navegador)."""
    mid = report.get("metricas") or {}
    title = str(mid.get("title") or folder.name).strip().upper()
    local = str(report.get("local_label") or "Japão")
    views = str(mid.get("views_label") or "").strip()
    dur = str(mid.get("duration_label") or "").strip()
    n_comments = (report.get("comentarios") or {}).get("total_comentarios") or 0
    trechos = [
        (c.get("trecho") or "").strip()
        for c in ((report.get("conteudo") or {}).get("cortes_virais") or [])[:3]
    ]
    trechos = [t for t in trechos if t]
    chips = "  ".join(
        f"<rect x='{40 + i * 235}' y='260' width='220' height='50' rx='25' fill='#1e293b' stroke='#334155'/>"
        + f"<text x='{150 + i * 235}' y='292' text-anchor='middle' fill='#eef2ff' font-size='24' font-family='Arial'>{c}</text>"
        for i, c in enumerate(
            [f"{views} views", dur, f"{n_comments} comentários", local][:4]
        )
    )
    bullets = "".join(
        f"<text x='60' y='{390 + i * 40}' fill='#cbd5e1' font-size='24' font-family='Arial'>• {t[:90]}</text>"
        for i, t in enumerate(trechos)
    )
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#1b2440"/><stop offset="1" stop-color="#0f172a"/>
</linearGradient></defs>
<rect width="1200" height="675" fill="url(#bg)"/>
<rect x="36" y="32" width="230" height="38" rx="19" fill="#1e293b" stroke="#a855f7" stroke-width="2"/>
<text x="151" y="57" text-anchor="middle" fill="#a5b4fc" font-size="22" font-family="Arial">bakalovers.com.br</text>
<text x="40" y="150" fill="#eef2ff" font-size="54" font-weight="bold" font-family="Arial">{title[:38]}</text>
<text x="40" y="210" fill="#94a3b8" font-size="26" font-family="Arial">{local}</text>
{chips}
<text x="40" y="360" fill="#a855f7" font-size="20" font-family="Arial">DESTAQUES</text>
{bullets}
<text x="40" y="630" fill="#a5b4fc" font-size="22" font-family="Arial">bakalovers.com.br/{folder.name}/dashboard.html</text>
</svg>"""
    out.write_text(svg, encoding="utf-8")


def gerar_card(report: dict, folder: Path, social_dir: Path) -> Path | None:
    video_id = str((report.get("metricas") or {}).get("video_id") or folder.name)
    png = social_dir / f"card-{video_id}.png"
    if not _card_png(report, folder, png):
        png = social_dir / f"card-{video_id}.svg"
        _card_svg(report, folder, png)
        print(f"  [!] Pillow indisponível — card gerado como SVG: {png.name}", file=sys.stderr)
    print(f"  ✓ card: {png.name}")
    return png


# --------------------------------------------------------------------------- #
# Clipes verticais legendados
# --------------------------------------------------------------------------- #

def _ass_time(s: float) -> str:
    s = max(0.0, s)
    h = int(s // 3600)
    m = int(s % 3600 // 60)
    sec = int(s % 60)
    cent = int(round((s - int(s)) * 100))
    if cent >= 100:
        sec += 1
        cent -= 100
    return f"{h}:{m:02d}:{sec:02d}.{cent:02d}"


def _sanitize_ass(text: str) -> str:
    t = text.replace("{", "").replace("}", "").replace("\\", " ")
    t = " ".join(t.split())
    return t


def _write_ass(events: list[tuple[float, float, str]], path: Path) -> None:
    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {W_V}",
        f"PlayResY: {H_V}",
        "WrapStyle: 2",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: Default,Arial,64,&H00FFFFFF,&H000000FF,&H00141414,&H96000000,-1,0,0,0,100,100,0,0,1,3,0,2,80,80,250,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for s, e, text in events:
        lines.append(f"Dialogue: 0,{_ass_time(s)},{_ass_time(e)},Default,,0,0,0,,{text}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _subs_in_window(blocks: list[dict], start: float, dur: float) -> list[tuple[float, float, str]]:
    events: list[tuple[float, float, str]] = []
    for b in blocks:
        s = max(0.0, b["start"] - start)
        e = min(dur, b["end"] - start)
        text = _sanitize_ass(b.get("text") or "")
        if text and e > 0.5 and e - s >= 0.4:
            events.append((s, e, text))
    return events


def _find_video(folder: Path) -> Path | None:
    for name in VIDEO_PREFER:
        p = folder / name
        if p.is_file():
            return p
    for p in sorted(folder.iterdir()):
        if p.is_file() and p.suffix.lower() in VIDEO_EXTS:
            return p
    return None


def _ffmpeg_vertical(video: Path, start: float, dur: float, ass_path: Path | None, out: Path) -> bool:
    if ass_path is not None:
        fc = (
            f"[0:v]split=2[bg][fg];"
            f"[bg]scale={W_V}:{H_V}:force_original_aspect_ratio=increase,crop={W_V}:{H_V},"
            f"gblur=sigma=24,eq=brightness=-0.15[bg];"
            f"[fg]scale={W_V}:{H_V}:force_original_aspect_ratio=decrease[fg];"
            f"[bg][fg]overlay=(W-w)/2:(H-h)/2[base];"
            f"[base]ass=filename='{ass_path}'[v]"
        )
    else:
        fc = (
            f"[0:v]split=2[bg][fg];"
            f"[bg]scale={W_V}:{H_V}:force_original_aspect_ratio=increase,crop={W_V}:{H_V},"
            f"gblur=sigma=24,eq=brightness=-0.15[bg];"
            f"[fg]scale={W_V}:{H_V}:force_original_aspect_ratio=decrease[fg];"
            f"[bg][fg]overlay=(W-w)/2:(H-h)/2[v]"
        )
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-ss", str(start), "-t", str(dur), "-i", str(video),
        "-filter_complex", fc,
        "-map", "[v]", "-map", "0:a:0?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart", "-shortest",
        str(out),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired:
        print(f"  [!] ffmpeg timeout em {out.name}", file=sys.stderr)
        return False
    if proc.returncode != 0:
        # fallback: sem legendas queimadas (ex.: libass/fonte falhou)
        if ass_path is not None:
            print(f"  [!] ass falhou para {out.name} — tentando sem legendas", file=sys.stderr)
            return _ffmpeg_vertical(video, start, dur, None, out)
        print(f"  [!] ffmpeg falhou para {out.name}: {proc.stderr[-300:]}", file=sys.stderr)
        return False
    return True


def _janelas(report: dict, n: int, dur_max: float, duration: float) -> list[tuple[float, float]]:
    cortes = (report.get("conteudo") or {}).get("cortes_virais") or []
    janelas: list[tuple[float, float]] = []
    for c in cortes[:n]:
        s = max(0.0, float(c.get("inicio_sec") or 0) - PAD_SEC)
        e = min(duration, float(c.get("fim_sec") or s + 60) + PAD_SEC)
        if e - s > 5:
            janelas.append((s, e))
    if not janelas:  # fallback: janelas fixas distribuídas pela live
        for i in range(n):
            s = duration * (0.15 + 0.30 * i) if duration else 0
            s = min(max(0.0, s), max(0.0, duration - 30))
            janelas.append((s, min(duration, s + dur_max)))
    return janelas


def gerar_clipes(report: dict, folder: Path, social_dir: Path, n: int, dur_max: float) -> list[Path]:
    video = _find_video(folder)
    if video is None:
        print(f"  [!] sem vídeo local em {folder.name} — pulando clipes", file=sys.stderr)
        return []
    duration = preparar.probe_video_duration(video)
    if not duration:
        print(f"  [!] não deu pra medir a duração de {video.name} — pulando clipes", file=sys.stderr)
        return []
    srt = folder / "audio.srt"
    blocks = []
    if srt.is_file():
        blocks = preparar.parse_srt_to_blocks(srt.read_text(encoding="utf-8"))

    saida: list[Path] = []
    for i, (s, e) in enumerate(_janelas(report, n, dur_max, duration), 1):
        s = min(s, max(0.0, duration - 1))
        dur = min(e - s, dur_max, max(1.0, duration - s))
        if dur < 5:
            continue
        events = _subs_in_window(blocks, s, dur)
        ass_path = social_dir / f"legenda-clipe-{i:02d}.ass"
        out = social_dir / f"clipe-{i:02d}-1080x1920.mp4"
        if events:
            _write_ass(events, ass_path)
        else:
            ass_path = None
            print(f"  [!] clipe {i}: sem falas na janela — sem legendas", file=sys.stderr)
        if _ffmpeg_vertical(video, s, dur, ass_path, out):
            print(f"  ✓ clipe {i}: {out.name} ({dur:.0f}s)")
            saida.append(out)
    return saida


# --------------------------------------------------------------------------- #
# Textos prontos + kit markdown
# --------------------------------------------------------------------------- #

def gerar_kit_md(report: dict, folder: Path, social_dir: Path, cards: list[Path], clips: list[Path]) -> Path:
    mid = report.get("metricas") or {}
    title = str(mid.get("title") or folder.name).strip()
    video_id = str(mid.get("video_id") or folder.name)
    local = str(report.get("local_label") or "Japão")
    views = str(mid.get("views_label") or "").strip()
    dur = str(mid.get("duration_label") or "").strip()
    n_comments = (report.get("comentarios") or {}).get("total_comentarios") or 0
    dash_url = f"{SITE_URL}/{folder.name}/dashboard.html"

    post_x = (
        f"{title} — análise completa do rolê 🇯🇵\n"
        f"📍 {local} · ⏱ {dur} · 👀 {views} views\n"
        f"Mapa da rota, momentos chave, cortes e clima do chat ↓\n"
        f"{dash_url}"
    )
    post_tiktok = (
        f"{title} — o rolê completo no Japão! 🗾🚴\n"
        f"mapa da rota + momentos chave no dashboard:\n"
        f"{SITE_URL.replace('https://', '')}/{folder.name}/dashboard.html\n"
        f"#BakaGaijin #Japão #Ciclismo #Live #Twitch #Tóquio"
    )
    post_whats = (
        f"Fiz uma análise completa dessa live: {title} 🇯🇵\n"
        f"{local} · {dur} · {views} views · {n_comments} comentários\n"
        f"Mapa interativo da rota, cortes e clima do chat: {dash_url}"
    )
    arquivos = "\n".join([f"- {p.relative_to(folder)}" for p in [*cards, *clips]])
    md = f"""# Kit de mídia — {title} ({video_id})

## Arquivos
{arquivos}

## Post para X/Twitter
```
{post_x}
```

## Post para TikTok / Reels / Shorts
(use os clipes verticais legendados)
```
{post_tiktok}
```

## Post para WhatsApp / Discord / Telegram
```
{post_whats}
```

## Links
- Dashboard: {dash_url}
- Home: {SITE_URL}/

## Dica
- Card PNG: poste junto com o link no X (ele vira o preview).
- Clipes: suba 1 por dia no TikTok/Shorts/Reels — cada um tem legendas queimadas do audio.srt.
"""
    path = social_dir / "kit-de-midia.md"
    path.write_text(md, encoding="utf-8")
    print(f"  ✓ textos prontos: {path.name}")
    return path


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #

def kit(nome: str, n_clipes: int, dur_max: float, sem_clipes: bool, sem_card: bool) -> bool:
    folder = ROOT / "saida" / nome
    rel = folder / "relatorio.json"
    if not rel.is_file():
        print(f"  [!] {nome}: sem relatorio.json — pulando", file=sys.stderr)
        return False
    report = json.loads(rel.read_text(encoding="utf-8"))
    social_dir = folder / "social"
    social_dir.mkdir(exist_ok=True)
    print(f"== {nome}: gerando kit de mídia...")
    cards = [] if sem_card else [p for p in [gerar_card(report, folder, social_dir)] if p]
    clips = [] if sem_clipes else gerar_clipes(report, folder, social_dir, n_clipes, dur_max)
    gerar_kit_md(report, folder, social_dir, cards, clips)
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description="Gera kit de mídia (card + clipes verticais + textos) de episódios analisados.")
    ap.add_argument("pastas", nargs="*", help="Pastas em saida/ (sem argumento: todas)")
    ap.add_argument("--clipes", type=int, default=3, help="Número de clipes verticais (padrão: 3)")
    ap.add_argument("--duracao-max", type=float, default=90.0, help="Duração máxima de cada clipe em segundos (padrão: 90)")
    ap.add_argument("--sem-clipes", action="store_true", help="Não gera clipes")
    ap.add_argument("--sem-card", action="store_true", help="Não gera o card")
    args = ap.parse_args()

    nomes = args.pastas or sorted(p.name for p in (ROOT / "saida").iterdir() if p.is_dir())
    ok = sum(1 for nome in nomes if kit(nome, args.clipes, args.duracao_max, args.sem_clipes, args.sem_card))
    print(f"\n{ok}/{len(nomes)} kit(s) gerado(s) em saida/<pasta>/social/")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
