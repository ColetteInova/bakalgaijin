#!/usr/bin/env python3
"""Baixa os ícones lucide usados na fanpage para saida/icons/lucide/ e troca as
referências https://api.iconify.design/... por caminhos locais (evita 429 da API).

Uso:
    .venv-ia/bin/python scripts/icones_locais.py

Reescreve saida/index.html e scripts/atualizar_index.py (f-strings do gerador)
para apontarem para icons/lucide/<icone>__<cor>.svg.
"""
import re
import ssl
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "saida" / "index.html"
GERADOR = ROOT / "scripts" / "atualizar_index.py"
ICONS_DIR = ROOT / "saida" / "icons" / "lucide"

URL_PATTERN = re.compile(
    r"https://api\.iconify\.design/lucide/([a-z0-9-]+)\.svg\?color=%23([0-9a-fA-F]{6})"
)
# Referências já reescritas para caminhos locais (para re-runs completarem faltas)
LOCAL_PATTERN = re.compile(r"icons/lucide/([a-z0-9-]+)__([0-9a-f]{6})\.svg")
# Ícones usados no loop dinâmico do atualizar_index.py (não aparecem literais lá)
DYNAMIC_STATS = ("eye", "message-circle", "thumbs-up", "scissors")


def _download(icon: str, color: str, ctx: ssl.SSLContext | None) -> bytes:
    """Baixa o SVG do ícone na cor desejada.

    Tenta primeiro a API do Iconify e, se estiver em rate-limit (429), usa o
    repositório oficial do lucide (raw.githubusercontent.com) e troca o
    `currentColor` pela cor pedida.
    """
    urls = [
        f"https://api.iconify.design/lucide/{icon}.svg?color=%23{color}",
        f"https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/{icon}.svg",
    ]
    last_exc: Exception | None = None
    for url in urls:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "bakalgaijin-fanpage/1.0"})
            with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
                data = resp.read()
            if "githubusercontent" in url:
                # ícone do repositório usa currentColor → pinta com a cor pedida
                data = data.replace(b"currentColor", f"#{color}".encode())
            return data
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            continue
    raise last_exc if last_exc else RuntimeError(f"sem fonte para {icon}")


def main() -> int:
    index_text = INDEX.read_text(encoding="utf-8")
    gerador_text = GERADOR.read_text(encoding="utf-8")

    pairs = set(URL_PATTERN.findall(index_text)) | set(URL_PATTERN.findall(gerador_text))
    pairs.update((m.group(1), m.group(2)) for m in LOCAL_PATTERN.finditer(index_text))
    pairs.update((m.group(1), m.group(2)) for m in LOCAL_PATTERN.finditer(gerador_text))
    pairs.update((icon, "ffffff") for icon in DYNAMIC_STATS)

    try:
        import certifi

        ctx = ssl.create_default_context(cafile=certifi.where())
    except Exception:  # noqa: BLE001
        ctx = None

    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    baixados = 0
    for icon, color in sorted(pairs):
        dest = ICONS_DIR / f"{icon}__{color}.svg"
        if dest.exists() and dest.stat().st_size > 100:
            continue
        try:
            dest.write_bytes(_download(icon, color, ctx))
            baixados += 1
            print(f"  ✓ {icon} ({color})")
        except Exception as exc:  # noqa: BLE001
            print(f"  [!] {icon} ({color}) falhou: {exc}", file=sys.stderr)

    # Reescreve as referências estáticas dos dois arquivos
    def _sub(m: re.Match) -> str:
        return f"icons/lucide/{m.group(1)}__{m.group(2).lower()}.svg"

    new_index = URL_PATTERN.sub(_sub, index_text)
    new_gerador = URL_PATTERN.sub(_sub, gerador_text)
    # Loop dinâmico do gerador: {icon} fixo na cor branca
    new_gerador = new_gerador.replace(
        'https://api.iconify.design/lucide/{icon}.svg?color=%23ffffff',
        'icons/lucide/{icon}__ffffff.svg',
    )
    if new_index != index_text:
        INDEX.write_text(new_index, encoding="utf-8")
        print(f"  ✓ {INDEX.name} atualizado")
    if new_gerador != gerador_text:
        GERADOR.write_text(new_gerador, encoding="utf-8")
        print(f"  ✓ {GERADOR.name} atualizado")
    print(f"Concluído: {baixados} ícones baixados, {len(pairs)} no total")
    return 0


if __name__ == "__main__":
    sys.exit(main())
