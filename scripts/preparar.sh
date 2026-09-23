#!/usr/bin/env bash
# preparar.sh — Gera a análise completa de um VOD já processado (pasta em saida/).
#
# Uso: ./scripts/preparar.sh <nome-da-pasta-em-saida>
# Ex.: ./scripts/preparar.sh "resenha de beco [v2875158366].temp"
#
# A pasta deve conter:
#   - comentarios.json  (gerado pela aba "Comentários" da aplicação)
#   - audio.srt         (transcrição gerada pelo analisar.sh)
#   - video.mp4         (opcional, usado para nomear o vídeo)
#
# Gera, dentro da própria pasta:
#   - relatorio.json    ("banco de dados" com todas as métricas, sentimentos, temas e insights)
#   - relatorio.md      (relatório Markdown)
#   - relatorio.csv     (comentários classificados em CSV)
#   - dashboard.html    (página HTML interativa com toda a análise)
set -euo pipefail

cd "$(dirname "$0")/.."

PASTA="${1:-}"

if [ -z "$PASTA" ]; then
  echo "Uso: ./scripts/preparar.sh <nome-da-pasta-em-saida>" >&2
  echo 'Ex.: ./scripts/preparar.sh "resenha de beco [v2875158366].temp"' >&2
  exit 1
fi

DIR="saida/$PASTA"

if [ ! -d "$DIR" ]; then
  echo "Pasta não encontrada: $DIR" >&2
  echo "Pastas disponíveis em saida/:" >&2
  ls -1 saida 2>/dev/null || true
  exit 1
fi

PY=".venv-ia/bin/python"
if [ ! -x "$PY" ]; then
  echo "Ambiente .venv-ia não encontrado. Rode: python3 -m venv .venv-ia && .venv-ia/bin/pip install requests" >&2
  exit 1
fi

echo "==> Analisando: $DIR"
"$PY" scripts/preparar.py "$DIR"

echo ""
echo "==> Cortando trechos virais (subpasta cortes/)"
"$PY" scripts/cortar.py "$DIR"

echo ""
echo "==> Atualizando dashboard com os cortes gerados"
"$PY" scripts/preparar.py "$DIR"

echo ""
echo "Concluído! Saída em: $DIR"
ls -lah "$DIR"
