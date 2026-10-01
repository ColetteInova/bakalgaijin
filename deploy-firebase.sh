#!/bin/bash
# deploy-firebase.sh — Build de produção (client dos Bakalovers: /cadastro e
# /perfil) e deploy no Firebase Hosting + Cloud Function "api" (functions/).
#
# A API de produção (auth, perfil, apoio/Stripe, bakalovers públicos) roda na
# Cloud Function e é exposta em <site>/api/** via rewrite no firebase.json.
# O client local (tradutor de voz, downloader de VODs) vive em client/vod.html
# e não é publicado — funciona apenas no localhost (pnpm dev).
#
# Uso:
#   ./deploy-firebase.sh              # deploy do front + function (sem secrets)
#   ./deploy-firebase.sh --secrets    # + envia as variáveis do .env como secrets
#                                     #   do Firebase (Secret Manager) — necessário
#                                     #   no PRIMEIRO deploy para a function ter
#                                     #   STRIPE_SECRET_KEY etc.
#
# Observações:
#   - Cloud Functions exige o plano Blaze no Firebase.
#   - A function lê os secrets via defineString (functions/src/index.ts).
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
      # Chaves com prefixo reservado (FIREBASE_*) não podem virar secrets do
      # mesmo nome: a function lê CLIENT_FIREBASE_*. A service account é
      # desnecessária na function (usa ADC do próprio Cloud Functions).
      case "$key" in
        FIREBASE_SERVICE_ACCOUNT) continue ;;
        SUPPORT_LINK_*) continue ;; # não usado mais — removido da API
        FIREBASE_API_KEY|FIREBASE_AUTH_DOMAIN|FIREBASE_PROJECT_ID|FIREBASE_APP_ID)
          key="CLIENT_FIREBASE_${key#FIREBASE_}" ;;
      esac
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

echo "==> Build de produção (VITE_ONLY_BAKALOVERS=1 — só a entrada index.html; vod.html fica de fora)..."
if [ -n "${VITE_API_BASE_URL:-}" ]; then
  echo "    API pública: $VITE_API_BASE_URL"
  VITE_ONLY_BAKALOVERS=1 VITE_API_BASE_URL="$VITE_API_BASE_URL" pnpm exec vite build
else
  echo "    (sem VITE_API_BASE_URL — as páginas usarão /api/* relativo)"
  VITE_ONLY_BAKALOVERS=1 pnpm exec vite build
fi

echo "==> Build da Cloud Function (api)..."
pnpm exec esbuild functions/src/index.ts \
  --bundle --platform=node --target=node20 --format=cjs \
  --packages=external --outfile=functions/lib/index.js

echo "==> Deploy para o Firebase (projeto: $PROJECT)..."
export GOOGLE_APPLICATION_CREDENTIALS="$CREDENTIALS"
npx --yes firebase-tools@latest deploy --only hosting,functions,firestore:rules --project "$PROJECT"

echo ""
echo "==> Pronto! Site publicado em https://$PROJECT.web.app"
echo "    Páginas disponíveis: /cadastro e /perfil"
echo "    API: https://$PROJECT.web.app/api/** (Cloud Function \"api\")"
if [ "$WITH_SECRETS" = "0" ]; then
  echo "    ATENÇÃO: rode com --secrets no primeiro deploy para enviar o .env"
fi

