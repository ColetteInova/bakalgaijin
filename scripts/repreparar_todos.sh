#!/usr/bin/env bash
# repreparar_todos.sh — Re-roda a análise (preparar.sh) em TODOS os vídeos de saida/.
#
# Uso: ./scripts/repreparar_todos.sh
# Opções:
#   DEEPSEEK_API_KEY="sk-..." ./scripts/repreparar_todos.sh   (mapa e textos do índice)
#   SKIP_CORTES=1 ./scripts/repreparar_todos.sh               (pula o corte de trechos virais)
#   SKIP_MAPA=1 ./scripts/repreparar_todos.sh                 (pula frames/geoloc/rota do mapa)
#   SKIP_ANALISE=1 ./scripts/repreparar_todos.sh              (pula a análise — mantém relatório e dashboard)
#   SKIP_R2=1 ./scripts/repreparar_todos.sh                   (pula o sync das mídias com o R2/CDN)
#
# Percorre cada subpasta de saida/ que tenha os pré-requisitos
# (comentarios.json + audio.srt) e executa scripts/preparar.sh nela.
set -euo pipefail

cd "$(dirname "$0")/.."

SAIDA_DIR="saida"
SKIP_CORTES="${SKIP_CORTES:-0}"
SKIP_MAPA="${SKIP_MAPA:-0}"
SKIP_ANALISE="${SKIP_ANALISE:-0}"

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
export SKIP_INDEX_UPDATE=1
i=0

for DIR in "${PASTAS[@]}"; do
  i=$((i + 1))
  PASTA="${DIR#$SAIDA_DIR/}"

  if [ ! -f "$DIR/comentarios.json" ] || [ ! -f "$DIR/audio.srt" ]; then
    echo ""
    echo "==> [pulando] $PASTA (faltando comentarios.json ou audio.srt)"
    PULADOS=$((PULADOS + 1))
    continue
  fi

  echo ""
  echo "############################################################"
  echo "==> Processando ($i/${#PASTAS[@]}): $PASTA"
  echo "############################################################"

  if [ "$SKIP_CORTES" = "1" ]; then
    export SKIP_CORTES=1
  fi

  if [ "$SKIP_MAPA" = "1" ]; then
    export SKIP_MAPA=1
  fi

  if [ "$SKIP_ANALISE" = "1" ]; then
    export SKIP_ANALISE=1
  fi

  if ./scripts/preparar.sh "$PASTA"; then
    OK=$((OK + 1))
  else
    echo "!! FALHOU: $PASTA" >&2
    FALHAS=$((FALHAS + 1))
  fi
done

echo ""
echo "==> Atualizando índice geral com os VODs preparados"
if python3 scripts/atualizar_index.py; then
  echo "==> Índice atualizado: $SAIDA_DIR/index.html"
else
  echo "!! Falha ao atualizar $SAIDA_DIR/index.html" >&2
  FALHAS=$((FALHAS + 1))
fi

if [ "${SKIP_R2:-0}" = "1" ]; then
  echo ""
  echo "==> SKIP_R2=1 — pulando sincronização com o R2/CDN"
else
  echo ""
  echo "==> Sincronizando mídias com o R2/CDN (cdn.json + local.json)"
  if python3 scripts/r2_sync.py; then
    echo "==> R2 sincronizado"
  else
    echo "!! Falha ao sincronizar com o R2" >&2
    FALHAS=$((FALHAS + 1))
  fi
fi

echo ""
echo "Concluído! OK=$OK Falhas=$FALHAS Pulados=$PULADOS"
