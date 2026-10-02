#!/usr/bin/env python3
"""Gera mapa/rota-a-pe.kml (Google Earth) a partir de geoloc.json.

Uso:
    python3 scripts/gerar_kml_rota.py [pasta-do-episodio] [intervalo-minutos]

Mantém 1 marco a cada `intervalo` minutos (padrão: 5) e liga eles pela rota de
ruas A PÉ do Valhalla (costing `pedestrian`; troque com VALHALLA_COSTING=bicycle).
Sem argumento, usa saida/2885710366. Saída: <pasta>/mapa/rota-a-pe.kml
"""
import hashlib
import json
import math
import os
import ssl
import sys
import time
import urllib.request
from pathlib import Path
from xml.sax.saxutils import escape

DEFAULT = Path("saida/2885710366")


def fmt_t(s: float) -> str:
    s = int(round(s))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}"


def _nearest_idx(synced: list, t: float) -> int | None:
    """Índice do ponto synced mais próximo de t (None se não houver rota)."""
    if not synced:
        return None
    import bisect

    ts = [p["t"] for p in synced]
    i = bisect.bisect_left(ts, t)
    if i == 0:
        return 0
    if i >= len(ts):
        return len(ts) - 1
    return i - 1 if t - ts[i - 1] <= ts[i] - t else i


def _hav_km(a: tuple, b: tuple) -> float:
    """Distância haversine entre (lat, lng) em km."""
    la1, lo1 = a
    la2, lo2 = b
    d = math.radians(la2 - la1)
    lo = math.radians(lo2 - lo1)
    h = (
        math.sin(d / 2) ** 2
        + math.cos(math.radians(la1)) * math.cos(math.radians(la2)) * math.sin(lo / 2) ** 2
    )
    return 6371 * 2 * math.asin(math.sqrt(h))


def _route_km(seg: list) -> float:
    return sum(_hav_km(a, b) for a, b in zip(seg, seg[1:]))


def _dec6(s: str) -> list[list]:
    """Decodifica polyline6 do Valhalla → lista de [lat, lng]."""
    coords: list[list] = []
    lat = lon = 0
    i = 0
    while i < len(s):
        d = 0
        shift = 0
        while True:
            b = ord(s[i]) - 63
            i += 1
            d |= (b & 0x1F) << shift
            shift += 5
            if b < 0x20:
                break
        lat += (d >> 1) if (d & 1) == 0 else ~(d >> 1)
        d = 0
        shift = 0
        while True:
            b = ord(s[i]) - 63
            i += 1
            d |= (b & 0x1F) << shift
            shift += 5
            if b < 0x20:
                break
        lon += (d >> 1) if (d & 1) == 0 else ~(d >> 1)
        coords.append([lat / 1e6, lon / 1e6])
    return coords


VALHALLA_MAX_LOCS = 10  # limite do servidor público FOSSGIS


def _valhalla_track(folder: Path, pts: list[tuple[int, dict]]) -> list[str]:
    """Rota a pé ligando os pontos em ordem, via Valhalla (pedestrian).

    - O servidor público aceita no máx. 10 pontos por chamada → roteia em blocos
      de 10 (com o ponto de fronteira repetido) e junta tudo.
    - Cada perna é comparada com a linha reta: volta absurda (> 2,5x + 300 m)
      vira linha reta (ex.: becos desconectados no OSM).
    - Cache em mapa/valhalla_route.json (invalidado quando os pontos mudam).
    """
    if len(pts) < 2:
        return []
    costing = os.environ.get("VALHALLA_COSTING", "pedestrian")
    sig = hashlib.md5(
        ("v1|" + costing + "|" + ";".join(f"{v['lat']:.5f},{v['lng']:.5f}" for _, v in pts)).encode("utf-8")
    ).hexdigest()
    cache_file = folder / "mapa" / "valhalla_route.json"
    if cache_file.exists():
        try:
            data = json.loads(cache_file.read_text(encoding="utf-8"))
            if data.get("sig") == sig and isinstance(data.get("coords"), list):
                return [f"{c['lng']:.6f},{c['lat']:.6f},0" for c in data["coords"]]
        except Exception:  # noqa: BLE001
            pass
    try:
        import certifi

        ssl_ctx = ssl.create_default_context(cafile=certifi.where())
    except Exception:  # noqa: BLE001
        ssl_ctx = None

    def post(body: dict) -> dict | None:
        req = urllib.request.Request(
            "https://valhalla1.openstreetmap.de/route",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "User-Agent": "bakalgaijin-mapa/1.0 (KML Google Earth)"},
        )
        try:
            with urllib.request.urlopen(req, timeout=90, context=ssl_ctx) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            print(f"  [!] Valhalla falhou: {exc}", file=sys.stderr)
            return None

    # rota em blocos de 10 pontos (com fronteira repetida); junta as pernas
    legs: list[tuple[list, list, list[list] | None]] = []
    for start in range(0, len(pts) - 1, VALHALLA_MAX_LOCS - 1):
        chunk = pts[start : start + VALHALLA_MAX_LOCS]
        if len(chunk) < 2:
            continue
        resp = post(
            {
                "locations": [{"lat": v["lat"], "lon": v["lng"]} for _, v in chunk],
                "costing": costing,
            }
        )
        trip = (resp or {}).get("trip")
        trip_legs = trip.get("legs") if trip else None
        for li in range(len(chunk) - 1):
            leg_shape = None
            if trip_legs and li < len(trip_legs) and trip_legs[li].get("shape"):
                leg_shape = _dec6(trip_legs[li]["shape"])
            a = [chunk[li][1]["lat"], chunk[li][1]["lng"]]
            b = [chunk[li + 1][1]["lat"], chunk[li + 1][1]["lng"]]
            legs.append((a, b, leg_shape))
        time.sleep(0.5)

    # sanidade por perna contra a linha reta
    out: list[list] = []
    for a, b, leg_pts in legs:
        straight = _hav_km(a, b)
        seg = leg_pts if leg_pts and _route_km(leg_pts) <= straight * 2.5 + 0.3 else None
        if seg is None:
            seg = [a, b]  # linha reta como último recurso
        out.extend(seg[1:] if out and seg[0] == out[-1] else seg)

    if out:
        cache_file.write_text(
            json.dumps({"sig": sig, "costing": costing, "coords": out}, ensure_ascii=False),
            encoding="utf-8",
        )
    return [f"{c[1]:.6f},{c[0]:.6f},0" for c in out]


def _write_gpx(dest: Path, coords: list[list], marcos: list[tuple[int, dict]]) -> None:
    """GPX com a rota (trk) + marcos (wpt) — abre no uMap/JOSM/GPS/OpenStreetMap."""
    def esc(txt: str) -> str:
        return (
            str(txt).replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;")
        )

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="bakalgaijin-mapa (rota a pé)" xmlns="http://www.topografix.com/GPX/1/1">',
        "  <metadata><name>Rota a pé — Baka Gaijin</name></metadata>",
    ]
    for sec, v in marcos:
        desc = " · ".join([p for p in ([v.get("rua")] + (v.get("estabelecimentos") or [])) if p])
        lines += [
            f'  <wpt lat="{v["lat"]:.6f}" lon="{v["lng"]:.6f}">',
            f"    <name>{esc(fmt_t(sec) + ' — ' + (v.get('nome') or ''))}</name>",
            f"    <desc>{esc(desc)}</desc>",
            "  </wpt>",
        ]
    lines += ["  <trk>", "    <name>Rota a pé (sem voltas)</name>", "    <trkseg>"]
    for lat, lng in coords:
        lines.append(f'      <trkpt lat="{lat:.6f}" lon="{lng:.6f}"/>')
    lines += ["    </trkseg>", "  </trk>", "</gpx>"]
    dest.write_text("\n".join(lines) + "\n", encoding="utf-8")


def build_route_exports(folder: Path, intervalo: float = 5.0) -> dict:
    """Gera mapa/rota-a-pe.kml (Google Earth/Maps) + mapa/rota-a-pe.gpx (OSM).

    Devolve {kml, gpx, coords, marcos, modo, pontos} — coords em [[lat, lng], ...].
    """
    step = intervalo * 60.0
    geoloc_path = folder / "mapa" / "geoloc.json"
    if not geoloc_path.exists():
        return {"erro": f"não achei {geoloc_path}"}
    geoloc = json.loads(geoloc_path.read_text(encoding="utf-8"))
    bairro = geoloc.get("bairro", "").strip()

    # Rota sincronizada do OSRM, em ordem cronológica (fallback)
    synced = []
    route_path = folder / "mapa" / "osrm_route.json"
    if route_path.exists():
        try:
            route = json.loads(route_path.read_text(encoding="utf-8"))
            synced = sorted(route.get("synced", []), key=lambda x: x["t"])
        except Exception:  # noqa: BLE001
            synced = []

    # Marcos: entradas numéricas (segundos) do geoloc
    marcos = []
    for key, v in geoloc.items():
        if not key.isdigit() or v.get("skip"):
            continue
        marcos.append((int(key), v))
    marcos.sort()

    # Seleciona 1 marco a cada `intervalo` minutos, a partir do 1º marco
    selecionados: list[tuple[int, dict]] = []
    if marcos:
        base = marcos[0][0]
        for t, v in marcos:
            if abs((t - base) - round((t - base) / step) * step) < 1e-6:
                selecionados.append((t, v))
        if selecionados[-1][0] != marcos[-1][0]:
            selecionados.append(marcos[-1])  # sempre fecha no último marco

    # Trajeto: rota de ruas a pé (Valhalla) ligando os pontos; se falhar,
    # cai no caminho real sincronizado + reta onde não cobre.
    track_coords = _valhalla_track(folder, selecionados)
    usou_fallback = not track_coords
    modo = "rota sincronizada + reta" if usou_fallback else "rota a pé (ruas)"
    if usou_fallback:
        prev = None
        for t, v in selecionados:
            if prev is None:
                if synced:
                    end = _nearest_idx(synced, t)
                    track_coords.extend(
                        f"{p['lng']:.6f},{p['lat']:.6f},0" for p in synced[: end + 1]
                    )
                track_coords.append(f"{v['lng']},{v['lat']},0")
            else:
                i0 = _nearest_idx(synced, prev[0])
                i1 = _nearest_idx(synced, t)
                if i0 is not None and i1 is not None and i1 > i0:
                    track_coords.extend(
                        f"{p['lng']:.6f},{p['lat']:.6f},0" for p in synced[i0 + 1 : i1 + 1]
                    )
                track_coords.append(f"{v['lng']},{v['lat']},0")  # sempre passa pelo marco
            prev = (t, v)

    coords_ll = [[float(x.split(",")[1]), float(x.split(",")[0])] for x in track_coords]

    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<kml xmlns="http://www.opengis.net/kml/2.2">',
        "  <Document>",
        f"    <name>Rota a pé — Baka Gaijin ({bairro or 'São Paulo'})</name>",
        "    <open>1</open>",
        '    <Style id="rota">',
        "      <LineStyle><color>ff2f6bff</color><width>4</width></LineStyle>",
        "    </Style>",
        '    <Style id="marco">',
        "      <IconStyle><scale>0.8</scale>",
        '        <Icon><href>https://maps.google.com/mapfiles/kml/paddle/red-circle.png</href></Icon>',
        "      </IconStyle>",
        "      <LabelStyle><scale>0.9</scale></LabelStyle>",
        "    </Style>",
    ]

    if track_coords:
        parts += [
            "    <Placemark>",
            f'      <name>Rota a pé ({modo})</name>',
            '      <styleUrl>#rota</styleUrl>',
            "      <LineString>",
            "        <tessellate>1</tessellate>",
            "        <coordinates>",
            "          " + " ".join(track_coords),
            "        </coordinates>",
            "      </LineString>",
            "    </Placemark>",
        ]

    parts.append('    <Folder><name>Marcos da live</name><open>0</open>')
    if usou_fallback and synced and (not selecionados or selecionados[0][0] > synced[0]["t"] + step):
        local_json = folder / "local.json"
        inicio = ""
        if local_json.exists():
            inicio = json.loads(local_json.read_text()).get("inicio", "")
        parts += [
            "      <Placemark>",
            f'        <name>{fmt_t(synced[0]["t"])} — Início</name>',
            '        <styleUrl>#marco</styleUrl>',
            f"        <description>{escape(inicio)}</description>",
            "        <Point>",
            f"          <coordinates>{synced[0]['lng']},{synced[0]['lat']},0</coordinates>",
            "        </Point>",
            "      </Placemark>",
        ]
    for n, (sec, v) in enumerate(selecionados, 1):
        nome = v.get("nome") or f"Marco {n}"
        desc_parts = []
        if v.get("rua"):
            desc_parts.append(f"<b>{v['rua']}</b>")
        if v.get("estabelecimentos"):
            desc_parts.append(" • ".join(v["estabelecimentos"]))
        if v.get("justificativa"):
            desc_parts.append(v["justificativa"])
        desc = escape("<br>".join(desc_parts))
        parts += [
            "      <Placemark>",
            f'        <name>{fmt_t(sec)} — {escape(nome)}</name>',
            '        <styleUrl>#marco</styleUrl>',
            f"        <description>{desc}</description>",
            "        <Point>",
            f"          <coordinates>{v['lng']},{v['lat']},0</coordinates>",
            "        </Point>",
            "      </Placemark>",
        ]
    parts += ["    </Folder>", "  </Document>", "</kml>"]

    out = folder / "mapa" / "rota-a-pe.kml"
    out.write_text("\n".join(parts) + "\n", encoding="utf-8")
    gpx_out = folder / "mapa" / "rota-a-pe.gpx"
    _write_gpx(gpx_out, coords_ll, selecionados)
    return {
        "kml": str(out),
        "gpx": str(gpx_out),
        "coords": coords_ll,
        "marcos": len(selecionados),
        "modo": modo,
        "pontos": len(track_coords),
    }


def main() -> None:
    folder = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
    try:
        intervalo = float(sys.argv[2]) if len(sys.argv) > 2 else 5.0
    except ValueError:
        sys.exit("intervalo inválido (ex.: 5)")
    res = build_route_exports(folder, intervalo)
    if "erro" in res:
        sys.exit(res["erro"])
    print(
        f"✓ {res['kml']} + {res['gpx']} (intervalo de {intervalo:g} min, {res['modo']}, {res['pontos']} pontos, {res['marcos']} marcos)"
    )


if __name__ == "__main__":
    main()
