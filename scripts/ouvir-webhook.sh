#!/usr/bin/env bash
# Ouve os eventos do Stripe localmente e encaminha para o webhook da API.
#
# Uso:
#   ./scripts/ouvir-webhook.sh                     # eventos checkout.session.completed -> :3001/api/stripe/webhook
#   ./scripts/ouvir-webhook.sh --events=checkout.session.completed,customer.subscription.created
#   ./scripts/ouvir-webhook.sh --no-restart        # não reinicia a API
#
# O script também atualiza STRIPE_WEBHOOK_SECRET no .env com o whsec_ gerado
# pelo Stripe CLI e reinicia a API (tsx não tem watch).
set -euo pipefail

cd "$(dirname "$0")/.."

FORWARD_URL="${FORWARD_URL:-http://localhost:3001/api/stripe/webhook}"
EVENTS="checkout.session.completed,customer.subscription.deleted,customer.subscription.paused,customer.subscription.resumed"
RESTART=1

for arg in "$@"; do
  case "$arg" in
    --forward-url=*) FORWARD_URL="${arg#*=}" ;;
    --events=*) EVENTS="${arg#*=}" ;;
    --no-restart) RESTART=0 ;;
    *) echo "Opção desconhecida: $arg"; exit 1 ;;
  esac
done

if ! command -v stripe >/dev/null 2>&1; then
  echo "Stripe CLI não encontrado. Instale com: brew install stripe/stripe-cli/stripe"
  exit 1
fi

# Chave secreta do .env (evita depender de 'stripe login' na máquina)
API_KEY=""
if [ -f .env ]; then
  API_KEY=$(grep -E '^STRIPE_SECRET_KEY=' .env | head -1 | cut -d= -f2- | tr -d '"' | xargs)
fi
if [ -z "$API_KEY" ] || [[ "$API_KEY" != sk_* ]]; then
  echo "Preencha STRIPE_SECRET_KEY no .env (chave sk_test_... ou sk_live_...) antes de ouvir."
  exit 1
fi

echo "=> Buscando o segredo de assinatura do webhook (whsec_)..."
SECRET=$(stripe listen --api-key "$API_KEY" --print-secret 2>/dev/null || true)
if [[ -z "$SECRET" || "$SECRET" != whsec_* ]]; then
  echo "Falha ao obter o whsec_. Verifique a chave do .env e a conexão." >&2
  exit 1
fi

echo "=> Atualizando STRIPE_WEBHOOK_SECRET no .env"
if grep -qE '^STRIPE_WEBHOOK_SECRET=' .env; then
  sed -i '' -E "s|^STRIPE_WEBHOOK_SECRET=.*|STRIPE_WEBHOOK_SECRET=$SECRET|" .env
else
  printf '\nSTRIPE_WEBHOOK_SECRET=%s\n' "$SECRET" >> .env
fi

if [ "$RESTART" = "1" ]; then
  echo "=> Reiniciando a API para carregar o novo segredo..."
  lsof -ti tcp:3001 | xargs kill 2>/dev/null || true
  sleep 1
  nohup pnpm dev:server > /tmp/bakal-server.log 2>&1 &
  sleep 3
  echo "   API rodando em http://localhost:3001"
fi

echo "=> Ouvindo eventos Stripe ($EVENTS) em $FORWARD_URL — Ctrl+C para parar"
exec stripe listen --api-key "$API_KEY" --forward-to "$FORWARD_URL" --events "$EVENTS"
