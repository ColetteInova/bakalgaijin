#!/usr/bin/env python3
"""Regenera dashboard.html + arquivos de rota do mapa (rota.gpx, rota.kml,
rota-a-pe.kml, rota-a-pe.gpx) de pastas JÁ analisadas, sem reprocessar o VOD.

Reaproveita o que já está salvo em disco:
  - relatorio.json + audio.srt → dashboard;
  - mapa/geoloc.json (cache OSINT), mapa/marco_*.jpg (frames) e o vídeo local
    → rotas do mapa (rota.gpx/kml via write_dashboard → ensure_map_assets).

Uso:
    .venv-ia/bin/python scripts/regerar_dashboards.py [pasta1 pasta2 ...] [--sem-geo]
Sem argumentos, regera todas as pastas de saida/.

--sem-geo: atualiza SÓ o <head> (OG/Twitter Cards + título) do dashboard.html
já gerado — não roda geo/frames/rota/clima (nada pesado, segundos por pasta).
"""
import argparse
import html
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import preparar  # noqa: E402


def regerar(nome: str) -> bool:
    folder = ROOT / "saida" / nome
    rel = folder / "relatorio.json"
    if not rel.is_file():
        print(f"  [!] {nome}: sem relatorio.json — pulando", file=sys.stderr)
        return False
    report = json.loads(rel.read_text(encoding="utf-8"))
    srt = folder / "audio.srt"
    blocks = None
    if srt.is_file():
        blocks = preparar.parse_srt_to_blocks(srt.read_text(encoding="utf-8"))
    print(f"== {nome}: regerando dashboard + rotas do mapa...")
    preparar.FOLDER = folder
    preparar.write_dashboard(report, folder / "dashboard.html", blocks)
    print(f"  ✓ {nome}/dashboard.html")
    return True


def regerar_so_head(nome: str) -> bool:
    """Atualiza só o <head> (OG/Twitter Cards + título) — sem geo, frames ou rota."""
    folder = ROOT / "saida" / nome
    dash = folder / "dashboard.html"
    rel = folder / "relatorio.json"
    if not rel.is_file():
        print(f"  [!] {nome}: sem relatorio.json — pulando", file=sys.stderr)
        return False
    if not dash.is_file():
        print(f"  [!] {nome}: sem dashboard.html — use a regeração completa", file=sys.stderr)
        return False
    report = json.loads(rel.read_text(encoding="utf-8"))
    og_tags, page_title = preparar.build_og_tags(report, folder.name)
    text = dash.read_text(encoding="utf-8")
    # substitui o bloco de metadados existente (description + og/twitter) até o <title>
    new_text, n = re.subn(
        r'<meta name="description".*?(?=<title>)',
        lambda _m: og_tags,
        text,
        count=1,
        flags=re.DOTALL,
    )
    if n == 0:
        new_text, n = re.subn(
            r'(<meta name="viewport"[^>]*/>)',
            lambda m: m.group(1) + "\n" + og_tags,
            text,
            count=1,
        )
    if n == 0:
        print(f"  [!] {nome}: <head> fora do padrão — sem patch", file=sys.stderr)
        return False
    new_text, _ = re.subn(
        r"<title>.*?</title>",
        f"<title>{html.escape(page_title)}</title>",
        new_text,
        count=1,
    )
    if new_text != text:
        dash.write_text(new_text, encoding="utf-8")
        print(f"  ✓ {nome}/dashboard.html (só head, sem geo)")
    else:
        print(f"  = {nome}/dashboard.html (já estava atualizado)")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description="Regenera dashboard.html + rotas do mapa de pastas já analisadas.")
    ap.add_argument("pastas", nargs="*", help="Pastas em saida/ (sem argumento: todas)")
    ap.add_argument("--sem-geo", action="store_true", help="Atualiza só o <head> (OG tags/título), sem refazer geo/mapa")
    args = ap.parse_args()
    nomes = args.pastas or sorted(p.name for p in (ROOT / "saida").iterdir() if p.is_dir())
    ok = 0
    for nome in nomes:
        if regerar_so_head(nome) if args.sem_geo else regerar(nome):
            ok += 1
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
