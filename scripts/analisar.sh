#!/usr/bin/env bash
# analisar.sh — Extrai áudio de um vídeo e transcreve com MLX Whisper.
# Uso: ./scripts/analisar.sh <video.mp4> [modelo] [idioma]
# Idiomas: pt (padrão), ja, en, es...
# Modelos sugeridos (todos no repo mlx-community):
#   mlx-community/whisper-large-v3-turbo (bom e rápido)
#   mlx-community/whisper-medium
#   mlx-community/whisper-small
set -euo pipefail

cd "$(dirname "$0")/.."

PY=".venv-ia/bin/python"
WHISPER_BIN=".venv-ia/bin/mlx_whisper"

VIDEO="${1:-}"
MODEL="${2:-mlx-community/whisper-large-v3-turbo}"
LANG="${3:-pt}"

if [ -z "$VIDEO" ]; then
  echo "Uso: ./scripts/analisar.sh <video.mp4> [modelo]" >&2
  exit 1
fi

if [ ! -f "$VIDEO" ]; then
  echo "Arquivo não encontrado: $VIDEO" >&2
  exit 1
fi

if [ ! -x "$PY" ]; then
  echo "Ambiente .venv-ia não encontrado. Rode: /Users/rafaelcolette-mac/.pyenv/versions/3.11.5/bin/python -m venv .venv-ia && .venv-ia/bin/pip install mlx-whisper" >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg não encontrado. Instale com: brew install ffmpeg" >&2
  exit 1
fi

BASE="$(basename "$VIDEO")"
STEM="${BASE%.*}"
OUTDIR="saida/$STEM"
mkdir -p "$OUTDIR"

WAV="$OUTDIR/audio.wav"

echo "==> [1/2] Extraindo áudio (16kHz mono) de: $VIDEO"
ffmpeg -y -i "$VIDEO" -vn -ar 16000 -ac 1 -c:a pcm_s16le "$WAV" -loglevel error

echo "==> [2/3] Transcrevendo com mlx-whisper ($MODEL, idioma=$LANG)"
"$WHISPER_BIN" "$WAV" \
  --model "$MODEL" \
  --language "$LANG" \
  --output-format srt \
  --output-dir "$OUTDIR" \
  --condition-on-previous-text False \
  --no-speech-threshold 0.6 \
  --hallucination-silence-threshold 0.5

echo "==> [3/3] Removendo repetições/alucinações do .srt"
SRT="$OUTDIR/audio.srt"
if [ -f "$SRT" ]; then
  "$PY" scripts/limpar_srt.py "$SRT"
fi

echo ""
echo "Concluído! Saída em: $OUTDIR"
ls -lah "$OUTDIR"
