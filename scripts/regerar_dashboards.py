#!/usr/bin/env python3
"""Regenera dashboard.html + arquivos de rota do mapa (rota.gpx, rota.kml,
rota-a-pe.kml, rota-a-pe.gpx) de pastas JÁ analisadas, sem reprocessar o VOD.

Reaproveita o que já está salvo em disco:
  - relatorio.json + audio.srt → dashboard;
  - mapa/geoloc.json (cache OSINT), mapa/marco_*.jpg (frames) e o vídeo local
    → rotas do mapa (rota.gpx/kml via write_dashboard → ensure_map_assets).

Uso:
    .venv-ia/bin/python scripts/regerar_dashboards.py [pasta1 pasta2 ...]
Sem argumentos, regera todas as pastas de saida/.
"""
import json
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


def main() -> int:
    nomes = sys.argv[1:]
    if not nomes:
        nomes = sorted(p.name for p in (ROOT / "saida").iterdir() if p.is_dir())
    for nome in nomes:
        regerar(nome)
    return 0


if __name__ == "__main__":
    sys.exit(main())
