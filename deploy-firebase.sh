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
#   ./deploy-firebase.sh --secrets    # + envia as variáveis do .env.prod como secrets
#                                     #   do Firebase (Secret Manager) — necessário
#                                     #   no PRIMEIRO deploy para a function ter
#                                     #   STRIPE_SECRET_KEY etc. (fallback: .env)
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

# Envia cada variável do .env.prod (ou $SECRETS_FILE) como secret do Firebase
# (Secret Manager). O backend (Cloud Functions/Cloud Run) lê os valores de
# process.env.
upload_secrets() {
  local file="${1:-${SECRETS_FILE:-.env.prod}}"
  if [ ! -f "$file" ]; then
    if [ "$file" = ".env.prod" ] && [ -f ".env" ]; then
      echo "==> Sem .env.prod — usando .env como fallback."
      file=".env"
    else
      echo "==> Sem $file — nenhum secret enviado."
      return 0
    fi
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
      # Se o secret já existe com o MESMO valor, pula (evita versão repetida).
      # Se o CLI não conseguir ler o valor atual, segue com o set (comportamento
      # antigo): não existe → cria a v1; valor diferente → nova versão.
      current="$(npx --yes firebase-tools@latest functions:secrets:access "$key" --project "$PROJECT" 2>/dev/null | tr -d '\n' || true)"
      if [ -z "$current" ]; then
        current="$(npx --yes firebase-tools@latest functions:secrets:get "$key" --project "$PROJECT" 2>/dev/null | tail -n 1 | tr -d '\n' || true)"
      fi
      if [ -n "$current" ] && [ "$current" = "$value" ]; then
        echo "    -> $key (mesmo valor — pulado)"
        continue
      fi
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

echo "==> Fanpage (saida/) na raiz do site — mídias ficam no CDN (R2)..."
# O index do client vira /app.html (rotas /cadastro e /perfil via rewrite no firebase.json);
# o index da fanpage assume a raiz. Mídias já no CDN (mapa/, cortes/, mp4/wav/gpx/kml/srt)
# não sobem para o Firebase.
mv dist/public/index.html dist/public/app.html
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude "mapa/" --exclude "cortes/" \
    --exclude "*.mp4" --exclude "*.wav" --exclude "*.gpx" --exclude "*.kml" --exclude "*.srt" \
    saida/ dist/public/
else
  echo "!! rsync não encontrado — copiando saida/ por inteiro (mídias locais sobem junto)"
  cp -R saida/. dist/public/
fi

echo "==> Build da Cloud Function (api)..."
pnpm exec esbuild functions/src/index.ts \
  --bundle --platform=node --target=node24 --format=cjs \
  --packages=external --outfile=functions/lib/index.js

echo "==> Deploy para o Firebase (projeto: $PROJECT)..."
HOSTING_FILES=$(find dist/public -type f | wc -l | tr -d ' ')
HOSTING_SIZE=$(du -sh dist/public | cut -f1)
FUNCTIONS_SIZE=$(du -sh functions/lib | cut -f1 2>/dev/null || echo "?")
echo "    Pacote do Hosting (dist/public): $HOSTING_SIZE em $HOSTING_FILES arquivos | bundle da function: $FUNCTIONS_SIZE"
export GOOGLE_APPLICATION_CREDENTIALS="$CREDENTIALS"
npx --yes firebase-tools@latest deploy --only hosting,functions,firestore:rules --project "$PROJECT"

echo ""
echo "==> Pronto! Site publicado em https://$PROJECT.web.app"
echo "    Páginas disponíveis: /cadastro e /perfil"
echo "    API: https://$PROJECT.web.app/api/** (Cloud Function \"api\")"
if [ "$WITH_SECRETS" = "0" ]; then
  echo "    ATENÇÃO: rode com --secrets no primeiro deploy para enviar o .env.prod"
fi

