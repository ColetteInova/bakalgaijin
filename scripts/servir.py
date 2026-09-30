#!/usr/bin/env python3
"""Servidor estático para a pasta saida/ com suporte a HTTP Range.

O seek do <video>/<audio> precisa de respostas 206 (Range) — o
`python3 -m http.server` não suporta Range e por isso o controle de
tempo do player não funcionava.

Requisições para /api/* são repassadas ao servidor da API (Express).
Configure a URL com a variável de ambiente BAKA_API_URL.

Uso:
    python3 scripts/servir.py [porta]      # padrão: 8080
"""
import http.server
import json
import os
import re
import sys
import urllib.error
import urllib.request
from urllib.parse import unquote, urlparse

ROOT = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "saida"))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
API_URL = os.environ.get("BAKA_API_URL", "http://localhost:3001").rstrip("/")

_RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)\s*$")


class RangeHandler(http.server.SimpleHTTPRequestHandler):
    """Serve arquivos de ROOT com suporte a pedidos de Range (bytes)."""

    def _proxy_api(self):
        url = API_URL + self.path
        body = None
        length = int(self.headers.get("Content-Length") or 0)
        if length > 0:
            body = self.rfile.read(length)
        headers = {}
        if body is not None and "Content-Type" in self.headers:
            headers["Content-Type"] = self.headers["Content-Type"]
        request = urllib.request.Request(url, data=body, headers=headers, method=self.command)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                data = response.read()
                self.send_response(response.status)
                self.send_header("Content-Type", response.headers.get("Content-Type", "application/json"))
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as err:
            data = err.read()
            self.send_response(err.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as err:  # noqa: BLE001
            payload = json.dumps({"error": f"API indisponível: {err}"}).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    def do_GET(self):
        if self.path.startswith("/api/"):
            self._proxy_api()
            return
        super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/"):
            self._proxy_api()
            return
        super().do_POST()

    do_PUT = do_POST
    do_PATCH = do_POST
    do_DELETE = do_POST

    def translate_path(self, path: str) -> str:
        # raiz fixa em saida/ — não usa o diretório de trabalho
        path = unquote(urlparse(path).path).lstrip("/")
        full = os.path.realpath(os.path.join(ROOT, path))
        if not full.startswith(ROOT):
            full = ROOT
        return full

    def send_head(self):
        self._chunk = None
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            if not self.path.endswith("/"):
                self.send_response(301)
                self.send_header("Location", self.path + "/")
                self.end_headers()
                return None
            index = os.path.join(path, "index.html")
            if os.path.isfile(index):
                path = index
            else:
                return self.list_directory(path)

        ctype = self.guess_type(path)
        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None

        try:
            size = os.fstat(f.fileno()).st_size
            rng = self.headers.get("Range")
            if rng:
                m = _RANGE_RE.match(rng)
                if m:
                    start_s, end_s = m.group(1), m.group(2)
                    if not start_s:
                        # sufixo: últimos N bytes
                        suffix = max(0, int(end_s or 0))
                        start = max(0, size - suffix)
                        end = size - 1
                    else:
                        start = int(start_s)
                        end = min(size - 1, int(end_s)) if end_s else size - 1
                    if start > end or start >= size:
                        self.send_response(416)
                        self.send_header("Content-Range", f"bytes */{size}")
                        self.end_headers()
                        return None
                    length = end - start + 1
                    self.send_response(206)
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                    self.send_header("Accept-Ranges", "bytes")
                    self.send_header("Content-Length", str(length))
                    self.send_header("Content-Type", ctype)
                    self.end_headers()
                    f.seek(start)
                    self._chunk = length
                    return f
            self.send_response(200)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Type", ctype)
            self.end_headers()
            return f
        except OSError:
            f.close()
            self.send_error(404, "File not found")
            return None

    def copyfile(self, source, outputfile):
        chunk = getattr(self, "_chunk", None)
        if chunk is None:
            super().copyfile(source, outputfile)
            return
        remaining = chunk
        while remaining > 0:
            data = source.read(min(65536, remaining))
            if not data:
                break
            outputfile.write(data)
            remaining -= len(data)


if __name__ == "__main__":
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    server = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), RangeHandler)
    actual_port = server.server_address[1]
    print(f"Servindo {ROOT} em http://localhost:{actual_port} (com suporte a Range)")
    print(f"Índice: http://localhost:{actual_port}/index.html")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
