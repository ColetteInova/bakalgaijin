#!/bin/bash
# emular.sh — Sobe a API de produção (Cloud Function "api") + client no emulador
# do Firebase, usando o .env da raiz (copiado para functions/.env — é de lá que
# defineString lê as variáveis localmente).
#
# Uso:
#   ./scripts/emular.sh
#
# Portas do emulador:
#   Hosting   5050  → http://localhost:5050        (client + rewrite /api/**)
#   Functions 5001  → http://localhost:5001        (function "api" direta)
#   Firestore 8081  (8080 fica livre para a fanpage saida/ no scripts/servir.py)
#   Auth      9099
#   UI        4000  → http://localhost:4000
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="${FIREBASE_PROJECT:-bakalover-fan}"

# 1) .env da raiz → functions/.env sanitizado (só linhas KEY=value, sem
# comentários/aspas) e com as chaves FIREBASE_* renomeadas para CLIENT_FIREBASE_*
# (o parser estrito do firebase-tools rejeita o prefixo reservado FIREBASE_).
# O emulador resolve os params do defineString daqui.
if [ -f ".env" ]; then
  node -e '
const fs = require("fs");
const rename = {
  FIREBASE_API_KEY: "CLIENT_FIREBASE_API_KEY",
  FIREBASE_AUTH_DOMAIN: "CLIENT_FIREBASE_AUTH_DOMAIN",
  FIREBASE_PROJECT_ID: "CLIENT_FIREBASE_PROJECT_ID",
  FIREBASE_APP_ID: "CLIENT_FIREBASE_APP_ID",
};
const skip = new Set(["FIREBASE_SERVICE_ACCOUNT", "TWITCH_OAUTH_REDIRECT_URI"]);
const out = [];
for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (!m) continue;
  let key = m[1];
  if (skip.has(key)) continue;
  if (key.startsWith("SUPPORT_LINK_")) continue; // removido da API
  if (rename[key]) key = rename[key];
  let value = m[2];
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("\x27") && value.endsWith("\x27"))) {
    value = value.slice(1, -1);
  }
  out.push(`${key}=${value}`);
}
fs.writeFileSync("functions/.env", out.join("\n") + "\n", "utf8");
console.log(`==> functions/.env gerado com ${out.length} variáveis`);
'
else
  echo "!! .env não encontrado na raiz — a function sobe sem secrets (checkout/webhook 503)"
fi

# Overrides específicos do emulador (o firebase-tools também carrega .env.local)
cat > functions/.env.local <<'EOF'
CLIENT_URL=http://localhost:5050
SITE_URL=http://localhost:5050/
TWITCH_OAUTH_REDIRECT_URI=http://localhost:5050/cadastro
EOF
echo "==> functions/.env.local com CLIENT_URL/SITE_URL do emulador"

# 2) Build da function (esbuild → functions/lib/index.js)
echo "==> Build da Cloud Function (api)..."
pnpm exec esbuild functions/src/index.ts \
  --bundle --platform=node --target=node24 --format=cjs \
  --packages=external --outfile=functions/lib/index.js

# 3) Dependências da function (o emulador executa com node local)
if [ ! -d "functions/node_modules" ]; then
  echo "==> Instalando dependências de functions/..."
  (cd functions && npm install --no-audit --no-fund)
fi

# 4) Build do client (o Hosting do emulador serve dist/public)
echo "==> Build do client (VITE_ONLY_BAKALOVERS=1)..."
VITE_ONLY_BAKALOVERS=1 pnpm exec vite build

# 5) Seed do Firestore emulador (em background): assim que o emulador subir,
# semeia bakalovers_public/bakalovers a partir do espelho .bakalovers.json —
# sem isso, /api/bakalovers volta [] porque o Firestore do emulador é vazio.
(
  for i in $(seq 1 90); do
    if node scripts/seed-bakalovers-emulator.mjs "$PROJECT"; then
      echo "==> Firestore emulador semeado com os bakalovers"
      exit 0
    fi
    sleep 2
  done
  echo "!! Não foi possível semear o Firestore emulador (emulador não subiu?)" >&2
) &

# 6) Emuladores
echo "==> Subindo emuladores (projeto: $PROJECT)..."
echo "    Site:  http://localhost:5050"
echo "    API:   http://localhost:5050/api/** (via rewrite do Hosting)"
echo "    UI:    http://localhost:4000"
npx --yes firebase-tools@latest emulators:start \
  --only functions,firestore,auth,hosting --project "$PROJECT"
