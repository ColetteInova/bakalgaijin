#!/usr/bin/env python3
"""cortar.py — Corta os trechos virais de um VOD em arquivos separados.

Lê os cortes sugeridos em relatorio.json (conteudo.cortes_virais) e, para cada
um, gera um .mp4 com ffmpeg dentro da subpasta "cortes/" da pasta do episódio.

Uso:
  .venv-ia/bin/python scripts/cortar.py "saida/<pasta-do-episodio>"
  .venv-ia/bin/python scripts/cortar.py --all        # processa todos os episódios
  .venv-ia/bin/python scripts/cortar.py --force "..."  # refaz cortes já existentes
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

VIDEO_EXTS = (".mp4", ".webm", ".mov", ".m4v")


def find_video(folder: Path) -> Path | None:
    for p in sorted(folder.iterdir()):
        if p.is_file() and p.suffix.lower() in VIDEO_EXTS:
            return p
    return None


def cortar_episodio(folder: Path, force: bool = False) -> int:
    rel = folder / "relatorio.json"
    if not rel.exists():
        print(f"  [!] {folder.name}: relatorio.json não encontrado — pulando")
        return 0

    try:
        data = json.loads(rel.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(f"  [!] {folder.name}: relatorio.json inválido ({exc}) — pulando")
        return 0

    cortes = ((data.get("conteudo") or {}).get("cortes_virais")) or []
    if not cortes:
        print(f"  - {folder.name}: nenhum corte viral definido — pulando")
        return 0

    video = find_video(folder)
    if not video:
        print(f"  [!] {folder.name}: nenhum vídeo (.mp4/.webm/.mov/.m4v) encontrado — pulando")
        return 0

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        print("  [!] ffmpeg não encontrado. Instale com: brew install ffmpeg")
        return 0

    outdir = folder / "cortes"
    outdir.mkdir(exist_ok=True)

    feitos = 0
    print(f"==> {folder.name} ({len(cortes)} cortes, vídeo: {video.name})")
    for i, c in enumerate(cortes, 1):
        start = c.get("inicio_sec")
        end = c.get("fim_sec")
        if start is None or end is None:
            continue
        dur = max(1, int(end) - int(start))
        out = outdir / f"corte-{i:02d}.mp4"
        if out.exists() and not force:
            print(f"    corte-{i:02d}.mp4 já existe — pulando")
            continue

        # -ss antes do -i (seek rápido e preciso ao recodificar) + re-encode
        cmd = [
            ffmpeg, "-y",
            "-ss", str(int(start)),
            "-i", str(video),
            "-t", str(dur),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            "-loglevel", "error",
            str(out),
        ]
        print(f"    cortando corte-{i:02d}.mp4 ({c.get('inicio')}–{c.get('fim')}) ...")
        try:
            subprocess.run(cmd, check=True)
            feitos += 1
        except subprocess.CalledProcessError as exc:
            print(f"    [!] falha ao cortar corte-{i:02d}.mp4: {exc}")

    print(f"    ✓ {feitos} corte(s) em {outdir}")
    return feitos


def main() -> None:
    ap = argparse.ArgumentParser(description="Corta os trechos virais de um VOD em arquivos .mp4.")
    ap.add_argument("folders", nargs="*", help="Pastas em saida/ (ou caminhos completos).")
    ap.add_argument("--all", action="store_true", help="Processa todos os episódios em saida/.")
    ap.add_argument("--force", action="store_true", help="Refaz cortes já existentes.")
    args = ap.parse_args()

    root = Path("saida")
    if args.all:
        folders = [p for p in sorted(root.iterdir()) if p.is_dir()]
    elif args.folders:
        folders = []
        for f in args.folders:
            p = Path(f)
            if not p.is_dir() and (root / f).is_dir():
                p = root / f
            folders.append(p)
    else:
        print("Uso: scripts/cortar.py <pasta> [<pasta>...] | --all", file=sys.stderr)
        sys.exit(1)

    total = 0
    for folder in folders:
        total += cortar_episodio(folder, force=args.force)
    print(f"\nConcluído: {total} corte(s) gerado(s).")


if __name__ == "__main__":
    main()
