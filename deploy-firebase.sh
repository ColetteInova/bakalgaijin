#!/bin/bash
# deploy-firebase.sh — Build de produção (somente /cadastro e /perfil) e deploy
# no Firebase Hosting.
#
# As demais páginas (tradutor de voz, downloader de VODs) continuam disponíveis
# apenas no localhost (pnpm dev).
#
# Uso:
#   ./deploy-firebase.sh              # deploy só do front (hosting)
#   ./deploy-firebase.sh --secrets    # + envia as variáveis do .env como secrets
#                                     #   do Firebase (Secret Manager) para o backend
#
# Variáveis de ambiente (opcionais):
#   VITE_API_BASE_URL   URL pública da API Express (ex.: https://api.seudominio.com)
#                       As páginas usam /api/* relativo por padrão; no Firebase
#                       informe a URL completa do servidor da API.
#   FIREBASE_PROJECT    ID do projeto Firebase (padrão: bakalover-fan)
#   GOOGLE_APPLICATION_CREDENTIALS  caminho da service account (padrão:
#                       ./firebase-service-account.json)
set -euo pipefail
cd "$(dirname "$0")"

PROJECT="${FIREBASE_PROJECT:-bakalover-fan}"
CREDENTIALS="${GOOGLE_APPLICATION_CREDENTIALS:-$(pwd)/firebase-service-account.json}"
WITH_SECRETS=0

for arg in "$@"; do
  case "$arg" in
    --secrets) WITH_SECRETS=1 ;;
    *) echo "!! Argumento desconhecido: $arg" >&2; exit 1 ;;
  esac
done

if [ ! -f "$CREDENTIALS" ]; then
  echo "!! Service account não encontrada: $CREDENTIALS" >&2
  echo "   Baixe em Firebase Console > Configurações do projeto > Contas de serviço." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "!! pnpm não encontrado. Instale com: npm install -g pnpm" >&2
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "==> Instalando dependências..."
  pnpm install
fi

# Envia cada variável do .env como secret do Firebase (Secret Manager).
# O backend (Cloud Functions/Cloud Run) lê os valores de process.env.
upload_secrets() {
  local file="${1:-.env}"
  if [ ! -f "$file" ]; then
    echo "==> Sem $file — nenhum secret enviado."
    return 0
  fi
  echo "==> Enviando secrets do $file para o projeto $PROJECT..."
  local key value line
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%"${line##*[![:space:]]}"}"  # trim à direita
    [ -z "$line" ] && continue
    case "$line" in
      \#*) continue ;;
    esac
    if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      [ -z "$value" ] && continue
      # remove aspas simples/duplas ao redor do valor
      value="${value%\"}"; value="${value#\"}"
      value="${value%\'}"; value="${value#\'}"
      printf '%s' "$value" > .secret-tmp
      echo "    -> $key"
      npx --yes firebase-tools@latest functions:secrets:set "$key" \
        --project "$PROJECT" --data-file .secret-tmp
      rm -f .secret-tmp
    fi
  done < "$file"
  echo "==> Secrets atualizados."
}

if [ "$WITH_SECRETS" = "1" ]; then
  export GOOGLE_APPLICATION_CREDENTIALS="$CREDENTIALS"
  upload_secrets
fi

echo "==> Build de produção (VITE_ONLY_BAKALOVERS=1 — apenas /cadastro e /perfil)..."
if [ -n "${VITE_API_BASE_URL:-}" ]; then
  echo "    API pública: $VITE_API_BASE_URL"
  VITE_ONLY_BAKALOVERS=1 VITE_API_BASE_URL="$VITE_API_BASE_URL" pnpm exec vite build
else
  echo "    (sem VITE_API_BASE_URL — as páginas usarão /api/* relativo)"
  VITE_ONLY_BAKALOVERS=1 pnpm exec vite build
fi

echo "==> Deploy para o Firebase (projeto: $PROJECT)..."
export GOOGLE_APPLICATION_CREDENTIALS="$CREDENTIALS"
npx --yes firebase-tools@latest deploy --only hosting,firestore:rules --project "$PROJECT"

echo ""
echo "==> Pronto! Site publicado em https://$PROJECT.web.app"
echo "    Páginas disponíveis: /cadastro e /perfil"

