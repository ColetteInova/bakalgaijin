#!/usr/bin/env bash
# repreparar_todos.sh — Re-roda a análise (preparar.sh) em TODOS os vídeos de saida/.
#
# Uso: ./scripts/repreparar_todos.sh
# Opções:
#   DEEPSEEK_API_KEY="sk-..." ./scripts/repreparar_todos.sh   (geolocaliza marcos do mapa)
#   SKIP_CORTES=1 ./scripts/repreparar_todos.sh               (pula o corte de trechos virais)
#
# Percorre cada subpasta de saida/ que tenha os pré-requisitos
# (comentarios.json + audio.srt) e executa scripts/preparar.sh nela.
set -euo pipefail

cd "$(dirname "$0")/.."

SAIDA_DIR="saida"
SKIP_CORTES="${SKIP_CORTES:-0}"

if [ ! -d "$SAIDA_DIR" ]; then
  echo "Pasta não encontrada: $SAIDA_DIR" >&2
  exit 1
fi

PASTAS=()
while IFS= read -r dir; do
  PASTAS+=("$dir")
done < <(find "$SAIDA_DIR" -mindepth 1 -maxdepth 1 -type d | sort)

if [ "${#PASTAS[@]}" -eq 0 ]; then
  echo "Nenhuma pasta de vídeo em $SAIDA_DIR/." >&2
  exit 1
fi

echo "==> Re-preparando ${#PASTAS[@]} vídeo(s) de $SAIDA_DIR/"
OK=0
FALHAS=0
PULADOS=0

for DIR in "${PASTAS[@]}"; do
  PASTA="${DIR#$SAIDA_DIR/}"

  if [ ! -f "$DIR/comentarios.json" ] || [ ! -f "$DIR/audio.srt" ]; then
    echo ""
    echo "==> [pulando] $PASTA (faltando comentarios.json ou audio.srt)"
    PULADOS=$((PULADOS + 1))
    continue
  fi

  echo ""
  echo "############################################################"
  echo "==> Processando: $PASTA"
  echo "############################################################"

  if [ "$SKIP_CORTES" = "1" ]; then
    export SKIP_CORTES=1
  fi

  if ./scripts/preparar.sh "$PASTA"; then
    OK=$((OK + 1))
  else
    echo "!! FALHOU: $PASTA" >&2
    FALHAS=$((FALHAS + 1))
  fi
done

echo ""
echo "Concluído! OK=$OK Falhas=$FALHAS Pulados=$PULADOS"
