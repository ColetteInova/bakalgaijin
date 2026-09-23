#!/usr/bin/env python3
"""resumir.py — Resume/traduz uma transcrição (.srt) usando um LLM.

Modos:
  local  -> usa Ollama (grátis, local). Requer: brew install ollama && ollama pull qwen3
  nuvem  -> usa API OpenAI-compatível (precisa da env var OPENAI_API_KEY)

Uso:
  .venv-ia/bin/python scripts/resumir.py saida/<nome>/audio.srt --modo local --modelo qwen3
  .venv-ia/bin/python scripts/resumir.py saida/<nome>/audio.srt --modo nuvem --modelo gpt-4o-mini
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

SYS_PROMPT = (
    "Você é um assistente que analisa transcrições de vídeo em português. "
    "Responda em português do Brasil."
)

USER_PROMPT = """Analise a transcrição abaixo (com timestamps) de um vídeo em português.

1. **Resumo geral** em 3 a 5 frases.
2. **Temas por blocos de 10 minutos**: para cada bloco, liste o tema principal e um resumo curto.
3. **Momentos-chave**: os 10 trechos mais importantes/interessantes, cada um com timestamp (HH:MM:SS) e uma frase.

Transcrição:
{transcricao}
"""


def parse_srt(text: str) -> str:
    """Converte .srt em texto corrido: [HH:MM:SS] frase."""
    blocks = re.split(r"\n\s*\n", text.strip())
    out: list[str] = []
    for block in blocks:
        lines = block.splitlines()
        if not lines:
            continue
        # linha com timestamp: 00:00:01,000 --> 00:00:04,000
        m = None
        for ln in lines:
            m = re.search(r"(\d{2}:\d{2}:\d{2}),\d+\s*-->\s*\d{2}:\d{2}:\d{2}", ln)
            if m:
                break
        if not m:
            continue
        start = m.group(1)
        # linhas de conteúdo: sem '-->' e sem número de índice
        content = " ".join(ln for ln in lines if "-->" not in ln and not ln.strip().isdigit())
        if content.strip():
            out.append(f"[{start}] {content.strip()}")
    return "\n".join(out)


def run_ollama(model: str, system: str, prompt: str) -> str:
    import json
    import urllib.request

    body = json.dumps(
        {"model": model, "system": system, "prompt": prompt, "stream": False}
    ).encode("utf-8")
    req = urllib.request.Request(
        "http://localhost:11434/api/generate",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=600) as resp:
        return json.loads(resp.read().decode("utf-8"))["response"]


def run_openai(model: str, system: str, prompt: str) -> str:
    from openai import OpenAI

    client = OpenAI(
        api_key=os.environ.get("OPENAI_API_KEY"),
        base_url=os.environ.get("OPENAI_BASE_URL", None),
    )
    resp = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        temperature=0.2,
    )
    return resp.choices[0].message.content or ""


def main() -> None:
    ap = argparse.ArgumentParser(description="Resume/traduz transcrição com LLM.")
    ap.add_argument("srt", help="Caminho do arquivo .srt")
    ap.add_argument("--modo", choices=["local", "nuvem"], default="local")
    ap.add_argument("--modelo", default="qwen3")
    args = ap.parse_args()

    srt_path = Path(args.srt)
    if not srt_path.exists():
        print(f"Arquivo não encontrado: {srt_path}", file=sys.stderr)
        sys.exit(1)

    texto = parse_srt(srt_path.read_text(encoding="utf-8"))
    if not texto.strip():
        print("Nenhuma fala encontrada no .srt", file=sys.stderr)
        sys.exit(1)

    prompt = USER_PROMPT.format(transcricao=texto)
    print(f"Enviando {len(texto)} caracteres para o LLM ({args.modo}/{args.modelo})...", file=sys.stderr)

    if args.modo == "local":
        resposta = run_ollama(args.modelo, SYS_PROMPT, prompt)
    else:
        resposta = run_openai(args.modelo, SYS_PROMPT, prompt)

    out_path = srt_path.with_suffix(".analise.md")
    out_path.write_text(resposta, encoding="utf-8")
    print("-" * 60)
    print(resposta)
    print("-" * 60)
    print(f"\nSalvo em: {out_path}")


if __name__ == "__main__":
    main()
