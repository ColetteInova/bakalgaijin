#!/usr/bin/env bash
# reprocessar_todos.sh — Re-executa UMA etapa em TODOS os episódios de saida/.
#
# Uso: ./scripts/reprocessar_todos.sh <etapa>
# Etapas: mapa | cortes | qualidade
#
#   mapa      apaga mapa/geoloc.json + mapa/osrm_route.json e re-geolocaliza
#             (frames + Gemini/Nominatim + rota OSRM) e regenera o dashboard
#   cortes    refaz os cortes virais (cortar.py --force) e atualiza o dashboard
#   qualidade gera as versões em baixa qualidade (qualidade.py)
#
# Pré-requisitos por pasta:
#   mapa/cortes: video.mp4 (ou similar) + audio.srt
#   qualidade:   video.mp4 (ou similar)
set -euo pipefail

cd "$(dirname "$0")/.."

ETAPA="${1:-}"
case "$ETAPA" in
  mapa|cortes|qualidade) ;;
  *)
    echo "Uso: $0 <mapa|cortes|qualidade>" >&2
    exit 1
    ;;
esac

SAIDA_DIR="saida"
if [ ! -d "$SAIDA_DIR" ]; then
  echo "Pasta não encontrada: $SAIDA_DIR" >&2
  exit 1
fi

PY=""
for candidate in ".venv-ia/bin/python" "$(command -v python3 2>/dev/null)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    PY="$candidate"
    break
  fi
done
if [ -z "$PY" ]; then
  echo "Python 3 não encontrado." >&2
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

tem_video() {
  [ -f "$1/video.mp4" ] || [ -f "$1/video.webm" ] || [ -f "$1/video.mov" ] || [ -f "$1/video.m4v" ]
}

echo "==> Reprocessando etapa '$ETAPA' em ${#PASTAS[@]} pasta(s) de $SAIDA_DIR/"
OK=0
FALHAS=0
PULADOS=0
export SKIP_INDEX_UPDATE=1

for DIR in "${PASTAS[@]}"; do
  PASTA="${DIR#$SAIDA_DIR/}"

  elegivel=1
  case "$ETAPA" in
    mapa|cortes)
      if ! tem_video "$DIR" || [ ! -f "$DIR/audio.srt" ]; then elegivel=0; fi
      ;;
    qualidade)
      if ! tem_video "$DIR"; then elegivel=0; fi
      ;;
  esac

  if [ "$elegivel" = "0" ]; then
    echo ""
    echo "==> [pulando] $PASTA (faltando vídeo ou audio.srt para '$ETAPA')"
    PULADOS=$((PULADOS + 1))
    continue
  fi

  echo ""
  echo "############################################################"
  echo "==> Processando: $PASTA"
  echo "############################################################"

  if case "$ETAPA" in
       mapa)
         rm -f "$DIR/mapa/geoloc.json" "$DIR/mapa/osrm_route.json"
         "$PY" scripts/preparar.py "$DIR"
         ;;
       cortes)
         "$PY" scripts/cortar.py --force "$DIR"
         "$PY" scripts/preparar.py "$DIR"
         ;;
       qualidade)
         "$PY" scripts/qualidade.py "$DIR"
         ;;
     esac; then
    OK=$((OK + 1))
  else
    echo "!! FALHOU: $PASTA" >&2
    FALHAS=$((FALHAS + 1))
  fi
done

echo ""
echo "==> Atualizando índice geral com os VODs preparados"
if "$PY" scripts/atualizar_index.py; then
  echo "==> Índice atualizado: $SAIDA_DIR/index.html"
else
  echo "!! Falha ao atualizar $SAIDA_DIR/index.html" >&2
  FALHAS=$((FALHAS + 1))
fi

echo ""
echo "Concluído! Etapa=$ETAPA OK=$OK Falhas=$FALHAS Pulados=$PULADOS"
