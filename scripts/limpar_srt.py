#!/usr/bin/env python3
"""limpar_srt.py — Pós-processa um .srt para remover alucinações do Whisper.

Remove:
  1. Blocos consecutivos com o mesmo texto (loops).
  2. Linhas que são a mesma palavra/frase repetida muitas vezes (ex.: "お手元の…").
"""
from __future__ import annotations

import re
import sys
from pathlib import Path


def clean_line(text: str, min_repeats: int = 4) -> str | None:
    """Remove texto degenerado (mesma unidade repetida). Retorna None se descartar."""
    t = text.strip()
    if not t:
        return None

    # 1) repetição de substring sem pontuação (ex.: "お手元の" * 50)
    compact = re.sub(r"[。、！？!?\s]", "", t)
    if len(compact) >= 6:
        # tenta substrings de 1 a 12 caracteres como unidade de repetição
        for size in range(1, 13):
            unit = compact[:size]
            if len(unit) < size:
                break
            # reconstrói a string repetindo a unidade e vê se cobre quase tudo
            reps = len(compact) // size
            if reps >= min_repeats:
                rebuilt = unit * reps
                # considera igual se o resto for prefixo da unidade
                if rebuilt == compact or compact.startswith(rebuilt) and len(compact) - len(rebuilt) < size:
                    return None

    # 2) tokeniza em unidades repetíveis (palavras japonesas/partículas/pontuação)
    units = re.findall(r"[^\s。、！？!?]+[。、！？!?]?|[。、！？!?]", t)
    if not units:
        return None
    # se a maioria das unidades for idêntica, é loop alucinado
    first = units[0]
    repeats = sum(1 for u in units if u == first)
    if len(units) >= min_repeats and repeats / len(units) >= 0.8:
        return None
    return t


def parse_and_clean(text: str) -> str:
    blocks = re.split(r"\n\s*\n", text.strip())
    out: list[str] = []
    last_text: str | None = None
    idx = 1
    for block in blocks:
        lines = [ln for ln in block.splitlines() if ln.strip()]
        if not lines:
            continue
        # encontra linha de timestamp
        ts_lines = [ln for ln in lines if "-->" in ln]
        content_lines = [ln for ln in lines if "-->" not in ln and not ln.strip().isdigit()]
        if not ts_lines:
            continue
        content = " ".join(content_lines).strip()
        content = clean_line(content)
        if not content:
            continue
        if content == last_text:
            continue
        last_text = content
        out.append(f"{idx}\n{ts_lines[0]}\n{content}\n")
        idx += 1
    return "\n".join(out)


def main() -> None:
    src = Path(sys.argv[1])
    text = src.read_text(encoding="utf-8")
    cleaned = parse_and_clean(text)
    src.write_text(cleaned + ("\n" if cleaned else ""), encoding="utf-8")
    n_before = len(re.findall(r"-->", text))
    n_after = len(re.findall(r"-->", cleaned))
    print(f"{src.name}: {n_before} blocos -> {n_after} blocos")


if __name__ == "__main__":
    main()
