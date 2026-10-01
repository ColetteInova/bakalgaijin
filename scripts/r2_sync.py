#!/usr/bin/env python3
"""r2_sync.py — Sincroniza as mídias (mp4/wav/gpx/srt) das análises em saida/
para o Cloudflare R2 (S3 Compatible API), subindo apenas o que ainda não existe.

Padrão de chave no R2 (pasta fixa analises):
    analises/<pasta-do-episódio>/<caminho-relativo-do-arquivo>

Depois do upload, atualiza o cdn.json de cada pasta com as URLs públicas
seguindo o mesmo padrão, para os dashboards carregarem do CDN.

Credenciais (variáveis de ambiente ou .env):
    R2_ACCESS_KEY_ID        (token S3 da API do R2)
    R2_SECRET_ACCESS_KEY
    R2_ACCOUNT_ID           (padrão: decd7551d814995e702664a7de0c5c34)
    R2_BUCKET               (padrão: bakalovers)
    R2_PREFIX               (padrão: analises)
    R2_PUBLIC_BASE          (base pública usada no cdn.json; padrão:
                             https://pub-85988ab9688b40be9a59d8d917fc8535.r2.dev)

Uso:
    python3 scripts/r2_sync.py               # sobe o que falta e grava cdn.json
    python3 scripts/r2_sync.py --dry-run     # só mostra o que subiria
    python3 scripts/r2_sync.py --only 2885710366
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
SAIDA = ROOT / "saida"

DEFAULT_ACCOUNT_ID = "decd7551d814995e702664a7de0c5c34"
DEFAULT_BUCKET = "bakalovers"
DEFAULT_PREFIX = "analises"

MEDIA_EXTS = (".mp4", ".wav", ".gpx", ".srt")
SIGV4 = "aws:amz:auto:s3"
SINGLE_PUT_LIMIT = 5 * 1024**3  # R2: PUT único até 5 GiB
PART_SIZE = 1024**3  # 1 GiB por parte no multipart


def load_env(path: Path = ROOT / ".env") -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key.startswith("R2_") and key not in os.environ and value:
            os.environ[key] = value


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n} B" if unit == "B" else f"{n / 1:.1f} {unit}"
        n /= 1024


def curl(args: list[str], **kw) -> subprocess.CompletedProcess:
    cmd = [
        "curl",
        "-sS",
        "--connect-timeout", "30",
        "--retry", "3",
        "--retry-delay", "2",
        "--aws-sigv4", SIGV4,
        "--user", f"{ACCESS}:{SECRET}",
        *args,
    ]
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def r2_url(key: str) -> str:
    return f"https://{ACCOUNT_ID}.r2.cloudflarestorage.com/{BUCKET}/{quote(key, safe='/')}"


def object_exists(key: str) -> bool:
    r = curl(["-I", "-o", "/dev/null", "-w", "%{http_code}", r2_url(key)])
    code = r.stdout.strip()
    if code == "200":
        return True
    if code == "404":
        return False
    print(f"[erro] HEAD {key} -> HTTP {code}: {r.stderr.strip()[:300]}", file=sys.stderr)
    sys.exit(1)


def put_file(path: Path, key: str) -> None:
    r = curl(["--fail", "--upload-file", str(path), r2_url(key)])
    if r.returncode != 0:
        raise RuntimeError(f"upload falhou: {r.stderr.strip()[:500]}")


def multipart_upload(path: Path, key: str) -> None:
    size = path.stat().st_size
    total_parts = -(-size // PART_SIZE)

    r = curl(["-X", "POST", f"{r2_url(key)}?uploads"])
    if r.returncode != 0:
        raise RuntimeError(f"create multipart falhou: {r.stderr.strip()[:500]}")
    m = re.search(r"<UploadId>([^<]+)</UploadId>", r.stdout)
    if not m:
        raise RuntimeError(f"UploadId ausente: {r.stdout[:300]}")
    upload_id = m.group(1)

    parts: list[tuple[int, str]] = []
    tmpdir = Path(tempfile.mkdtemp(prefix="r2part-"))
    try:
        part_no = 0
        remaining = size
        while remaining > 0:
            part_no += 1
            part_size = min(PART_SIZE, remaining)
            remaining -= part_size
            part_path = tmpdir / f"part-{part_no:03d}"
            start = (part_no - 1) * PART_SIZE
            skip_mb = start // (1024 * 1024)
            count_mb = -(-part_size // (1024 * 1024))  # ceil
            dd = subprocess.run(
                [
                    "dd", f"if={path}", f"of={part_path}",
                    "bs=1m", f"skip={skip_mb}", f"count={count_mb}",
                ],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            if dd.returncode != 0:
                raise RuntimeError(f"falha ao fatiar parte {part_no}")
            print(f"    parte {part_no}/{total_parts} ({human(part_size)}) enviando...")
            r = curl([
                "-X", "PUT", "--fail",
                "--upload-file", str(part_path),
                "-D", "-", "-o", "/dev/null",
                f"{r2_url(key)}?partNumber={part_no}&uploadId={upload_id}",
            ])
            if r.returncode != 0:
                raise RuntimeError(f"parte {part_no} falhou: {r.stderr.strip()[:500]}")
            etag_m = re.search(r"(?i)^etag:\s*(\S+)", r.stdout, re.M)
            if not etag_m:
                raise RuntimeError(f"parte {part_no}: ETag ausente")
            parts.append((part_no, etag_m.group(1).strip()))
            print(f"    parte {part_no}/{total_parts} ok")

        body = (
            "<CompleteMultipartUpload>"
            + "".join(
                f"<Part><PartNumber>{n}</PartNumber><ETag>{e}</ETag></Part>"
                for n, e in parts
            )
            + "</CompleteMultipartUpload>"
        )
        fd, body_path = tempfile.mkstemp(suffix=".xml")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(body)
            r = curl([
                "-X", "POST", "--fail",
                "-H", "Content-Type: application/xml",
                "--data-binary", f"@{body_path}",
                f"{r2_url(key)}?uploadId={upload_id}",
            ])
            if r.returncode != 0:
                raise RuntimeError(f"complete multipart falhou: {r.stderr.strip()[:500]}")
        finally:
            os.unlink(body_path)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def update_cdn(folder: Path, public_base: str, urls: dict[str, str]) -> bool:
    cdn_path = folder / "cdn.json"
    cdn: dict[str, str] = {}
    if cdn_path.is_file():
        try:
            cdn = json.loads(cdn_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            cdn = {}
        if not isinstance(cdn, dict):
            cdn = {}
    changed = False
    for rel, key in urls.items():
        url = f"{public_base}/{quote(key, safe='/')}"
        if cdn.get(rel) != url:
            cdn[rel] = url
            changed = True
    if changed:
        cdn_path.write_text(
            json.dumps(cdn, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    return changed


def main() -> int:
    parser = argparse.ArgumentParser(description="Sobe mídias de saida/ para o R2 e atualiza cdn.json")
    parser.add_argument("--dry-run", action="store_true", help="só mostra o que subiria")
    parser.add_argument("--only", metavar="PASTA", help="processa só uma pasta de saida/")
    args = parser.parse_args()

    load_env()

    global ACCESS, SECRET, ACCOUNT_ID, BUCKET, PREFIX
    ACCOUNT_ID = os.environ.get("R2_ACCOUNT_ID", DEFAULT_ACCOUNT_ID)
    BUCKET = os.environ.get("R2_BUCKET", DEFAULT_BUCKET)
    PREFIX = os.environ.get("R2_PREFIX", DEFAULT_PREFIX)
    ACCESS = os.environ.get("R2_ACCESS_KEY_ID", "")
    SECRET = os.environ.get("R2_SECRET_ACCESS_KEY", "")
    if not ACCESS or not SECRET:
        print(
            "Defina R2_ACCESS_KEY_ID e R2_SECRET_ACCESS_KEY "
            "(variáveis de ambiente ou no .env).",
            file=sys.stderr,
        )
        return 1
    public_base = os.environ.get(
        "R2_PUBLIC_BASE", "https://pub-85988ab9688b40be9a59d8d917fc8535.r2.dev"
    ).rstrip("/")

    folders = sorted(f for f in SAIDA.iterdir() if f.is_dir())
    if args.only:
        folders = [SAIDA / args.only]

    for folder in folders:
        files = sorted(
            p for p in folder.rglob("*")
            if p.is_file() and p.suffix.lower() in MEDIA_EXTS
        )
        if not files:
            continue
        print(f"== {folder.name} ({len(files)} mídias)")
        cdn_urls: dict[str, str] = {}
        for path in files:
            rel = path.relative_to(folder).as_posix()
            key = f"{PREFIX}/{folder.name}/{rel}"
            cdn_urls[rel] = key
            if object_exists(key):
                continue
            size = path.stat().st_size
            print(f"  -> {rel} ({human(size)})")
            if args.dry_run:
                continue
            try:
                if size > SINGLE_PUT_LIMIT:
                    multipart_upload(path, key)
                else:
                    put_file(path, key)
                print(f"  ok: {r2_url(key)}")
            except RuntimeError as exc:
                print(f"  [erro] {rel}: {exc}", file=sys.stderr)
                return 1
        if args.dry_run:
            print(f"  (dry-run) atualizaria {len(cdn_urls)} entradas do cdn.json")
            continue
        if update_cdn(folder, public_base, cdn_urls):
            print(f"  cdn.json atualizado ({len(cdn_urls)} URLs)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
