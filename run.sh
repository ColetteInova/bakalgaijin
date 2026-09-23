#!/bin/bash
set -e

cd "$(dirname "$0")"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm não encontrado. Instale com: npm install -g pnpm"
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "Instalando dependências..."
  pnpm install
fi

kill_port() {
  local port=$1
  local pid
  pid=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  if [ -n "$pid" ]; then
    echo "Porta $port em uso (PID $pid). Matando processo..."
    kill -9 $pid
    sleep 1
  fi
}

kill_port 3000
kill_port 3001

trap 'kill 0' EXIT INT TERM

echo "Iniciando servidor (porta 3001)..."
pnpm dev:server &

echo "Iniciando frontend (porta 3000)..."
pnpm dev

wait
