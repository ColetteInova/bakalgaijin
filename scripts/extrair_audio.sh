#!/usr/bin/env bash
# extrair_audio.sh — Extrai o áudio (audio.wav) do video.mp4 da pasta do
# episódio e, se audio.srt não existir, transcreve com MLX Whisper.
#
# Uso: ./scripts/extrair_audio.sh <pasta> [modelo] [idioma]
# Ex.: ./scripts/extrair_audio.sh 2871566138
#      ./scripts/extrair_audio.sh 2871566138 mlx-community/whisper-medium ja
set -euo pipefail

cd "$(dirname "$0")/.."

PASTA="${1:-}"
MODEL="${2:-mlx-community/whisper-large-v3-turbo}"
LANG="${3:-pt}"

if [ -z "$PASTA" ]; then
  echo "Uso: ./scripts/extrair_audio.sh <pasta-em-saida> [modelo] [idioma]" >&2
  echo 'Ex.: ./scripts/extrair_audio.sh 2871566138' >&2
  exit 1
fi

DIR="$PASTA"
case "$PASTA" in
  saida/*|*/saida/*) DIR="$PASTA" ;;
  *) DIR="saida/$PASTA" ;;
esac

if [ ! -d "$DIR" ]; then
  echo "Pasta não encontrada: $DIR" >&2
  echo "Pastas disponíveis em saida/:" >&2
  ls -1 saida 2>/dev/null || true
  exit 1
fi

VIDEO="$DIR/video.mp4"
if [ ! -f "$VIDEO" ]; then
  echo "video.mp4 não encontrado em: $DIR" >&2
  exit 1
fi

WAV="$DIR/audio.wav"
SRT="$DIR/audio.srt"

if [ -f "$SRT" ]; then
  echo "audio.srt já existe — extraindo apenas o áudio (sem transcrever de novo)."
  TRANS=0
else
  TRANS=1
fi

echo "==> [1/2] Extraindo áudio (16kHz mono) de: $VIDEO"
ffmpeg -y -i "$VIDEO" -vn -ar 16000 -ac 1 -c:a pcm_s16le "$WAV" -loglevel error

if [ "$TRANS" = "1" ]; then
  echo "==> [2/2] Transcrevendo com mlx-whisper ($MODEL, idioma=$LANG)"
  .venv-ia/bin/mlx_whisper "$WAV" \
    --model "$MODEL" \
    --language "$LANG" \
    --output-format srt \
    --output-dir "$DIR" \
    --condition-on-previous-text False \
    --no-speech-threshold 0.6 \
    --hallucination-silence-threshold 0.5
  if [ -f "$SRT" ]; then
    .venv-ia/bin/python scripts/limpar_srt.py "$SRT"
  fi
fi

echo ""
echo "Concluído! Áudio em: $DIR"
ls -lah "$WAV"
