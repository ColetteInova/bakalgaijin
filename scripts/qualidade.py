#!/usr/bin/env python3
"""qualidade.py — Cria versões em qualidade mais baixa do vídeo original.

Para a pasta de um episódio em saida/, encontra o vídeo original
(video.mp4 / video.webm / video.mov / video.m4v) e gera versões menores
com ffmpeg, NUNCA ampliando (só gera se a altura original for maior):

    video_720.mp4   (altura máx 720)
    video_480.mp4   (altura máx 480)
    video_360.mp4   (altura máx 360)

Arquivos já existentes são pulados (use --force para refazer).

Uso:
  .venv-ia/bin/python scripts/qualidade.py "saida/<pasta-do-episodio>"
  .venv-ia/bin/python scripts/qualidade.py --all            # todos os episódios
  .venv-ia/bin/python scripts/qualidade.py --force "..."    # refaz existentes
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SAIDA = ROOT / "saida"
VIDEO_EXTS = (".mp4", ".webm", ".mov", ".m4v")
QUALIDADES = [
    (720, "video_720.mp4"),
    (480, "video_480.mp4"),
    (360, "video_360.mp4"),
]


def find_video(folder: Path) -> Path | None:
    return next(
        (p for p in sorted(folder.iterdir()) if p.is_file() and p.suffix.lower() in VIDEO_EXTS),
        None,
    )


def video_height(video: Path) -> int | None:
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=height", "-of", "csv=p=0",
                str(video),
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        height = int(result.stdout.strip())
        return height if height > 0 else None
    except Exception:  # noqa: BLE001
        return None


def criar_qualidades(folder: Path, force: bool = False) -> int:
    video = find_video(folder)
    if not video:
        print(f"  [!] {folder.name}: vídeo original não encontrado — pulando")
        return 0

    height = video_height(video)
    if height is None:
        print(f"  [!] {folder.name}: não deu para ler a altura do vídeo — pulando")
        return 0

    print(f"  {folder.name}: original {video.name} com {height}p")
    if not shutil.which("ffmpeg"):
        print("  [!] ffmpeg não encontrado no PATH")
        return 0

    created = 0
    for target_height, output_name in QUALIDADES:
        output = folder / output_name
        if height <= target_height:
            print(f"  · {output_name}: pulado (original já é <= {target_height}p)")
            continue
        if output.exists() and not force:
            print(f"  · {output_name}: já existe — pulando")
            continue
        print(f"  · gerando {output_name} ({target_height}p)...")
        command = [
            "ffmpeg", "-y", "-i", str(video),
            "-vf", f"scale=-2:{target_height}",
            "-c:v", "libx264", "-preset", "medium", "-crf", "23",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            str(output),
        ]
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode == 0:
            created += 1
            print(f"  ✓ {output_name} criado")
        else:
            tail = (result.stderr or "").strip().splitlines()[-2:]
            print(f"  [!] falha ao criar {output_name}: {' | '.join(tail)}")
    return created


def main() -> int:
    parser = argparse.ArgumentParser(description="Cria versões em qualidade baixa dos vídeos preparados.")
    parser.add_argument("pasta", nargs="?", help="Nome da pasta em saida/ (ou caminho completo)")
    parser.add_argument("--all", action="store_true", help="Processa todos os episódios em saida/")
    parser.add_argument("--force", action="store_true", help="Refaz arquivos já existentes")
    args = parser.parse_args()

    if args.all:
        folders = [f for f in sorted(SAIDA.iterdir()) if f.is_dir()]
    elif args.pasta:
        target = Path(args.pasta)
        if not target.is_absolute():
            target = SAIDA / args.pasta
        if not target.is_dir():
            print(f"Pasta não encontrada: {target}", file=sys.stderr)
            return 1
        folders = [target]
    else:
        parser.print_help()
        return 1

    total = 0
    for folder in folders:
        total += criar_qualidades(folder, args.force)
    print(f"Concluído: {total} arquivo(s) de qualidade baixa criado(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
