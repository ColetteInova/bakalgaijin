#!/usr/bin/env node
// seed-bakalovers-emulator.mjs — Semeia o Firestore EMULADOR (127.0.0.1:8081)
// com os bakalovers espelhados em .bakalovers.json (mantido pelo server local,
// que sincroniza com o Firestore de produção).
//
// Coleções escritas:
//   bakalovers_public  → { nome, twitch?, apoios? }  (o que a API expõe)
//   bakalovers         → { nome, twitch?, status: "aprovado" } (marca oficial)
//
// Usa apenas a REST API do emulador — nunca toca no Firestore de produção.
// Sai 0 se semeou, 1 se o emulador ainda não respondeu (para retry).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = process.argv[2] || process.env.FIREBASE_PROJECT || "bakalover-fan";
const HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1";
const PORT = process.env.FIRESTORE_EMULATOR_PORT || "8081";

const BASE = `http://${HOST}:${PORT}/v1/projects/${PROJECT}/databases/(default)/documents`;

function stringValue(v) {
  return { stringValue: String(v) };
}

function toFields(entry) {
  const fields = {
    nome: stringValue(typeof entry.nome === "string" ? entry.nome : entry.id),
  };
  if (typeof entry.twitch === "string" && entry.twitch) {
    fields.twitch = stringValue(entry.twitch);
  }
  const apoios = Array.isArray(entry.apoios)
    ? entry.apoios.filter(
        (a) => a && typeof a.emoji === "string" && typeof a.nome === "string"
      )
    : [];
  if (apoios.length) {
    fields.apoios = {
      arrayValue: {
        values: apoios.map((a) => ({
          mapValue: {
            fields: {
              emoji: stringValue(a.emoji),
              nome: stringValue(a.nome),
            },
          },
        })),
      },
    };
  }
  return fields;
}

async function patchDoc(collection, docId, fields) {
  const pathParams = Object.keys(fields)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join("&");
  const url = `${BASE}/${collection}/${encodeURIComponent(docId)}?${pathParams}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      // Token especial do emulador: ignora as regras do Firestore (equivale
      // ao Admin SDK dentro do emulador).
      Authorization: "Bearer owner",
    },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    throw new Error(`PATCH ${collection}/${docId} → ${res.status}`);
  }
}

async function main() {
  // Testa se o emulador está de pé antes de ler o arquivo.
  const ping = await fetch(`${BASE}`, { method: "GET" }).catch(() => null);
  if (!ping) return 1; // emulador ainda não respondeu — retry
  if (!ping.ok && ping.status !== 404) return 1;

  const file = path.join(ROOT, ".bakalovers.json");
  if (!fs.existsSync(file)) {
    console.log("==> .bakalovers.json não encontrado — nada para semear");
    return 0;
  }
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    console.error("!! .bakalovers.json inválido");
    return 1;
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    console.log("==> .bakalovers.json vazio — nada para semear");
    return 0;
  }

  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string") continue;
    const pubFields = toFields(entry);
    const privFields = {
      ...pubFields,
      status: stringValue("aprovado"),
    };
    delete privFields.apoios; // apoios ficam só no espelho público
    await patchDoc("bakalovers_public", entry.id, pubFields);
    await patchDoc("bakalovers", entry.id, privFields);
    console.log(`==> semeado: ${entry.id} (${entry.nome ?? ""})`);
  }
  return 0;
}

main().then((code) => process.exit(code));
