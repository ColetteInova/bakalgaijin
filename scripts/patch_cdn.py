#!/usr/bin/env python3
"""Aplica o suporte a cdn.json nos dashboards já gerados em saida/.

- Substitui o boot direto (render(); initLiveMap();) pelo boot com fetch de cdn.json
- Corrige renderCortes para aceitar URLs absolutas do CDN
- Adiciona id="gpxLink" ao botão GPX (quando existir)
- Cria cdn.json (modelo) em cada pasta de episódio
"""
import json
import sys
from pathlib import Path

SAIDA = Path(__file__).resolve().parent.parent / "saida"

CDN_BLOCK = """// ---------------------------------------------------------------------------
// CDN (opcional): se existir cdn.json ao lado do dashboard (deploy em hosting
// sem os arquivos de mídia), os links do CDN substituem os arquivos locais.
// Formato: { "video.mp4": "https://cdn.../video.mp4", "cortes/corte-01.mp4": "..." }
// Sem o cdn.json (ou com valores vazios), continua carregando os arquivos da pasta.
// ---------------------------------------------------------------------------
function applyCdnOverrides(map){
  if (!map || typeof map !== "object") return;
  const resolve = (name) => {
    if (!name) return name;
    if (map[name]) return map[name];
    const base = name.includes("/") ? name.split("/").pop() : name;
    return map[base] || name;
  };
  FILES.video = resolve(FILES.video);
  FILES.audio = resolve(FILES.audio);
  FILES.srt = resolve(FILES.srt);
  if (Array.isArray(FILES.cortes)) {
    for (let i = 0; i < FILES.cortes.length; i++) {
      FILES.cortes[i] = resolve("cortes/" + FILES.cortes[i]);
    }
  }
  const q = FILES.qualidades || {};
  for (const k in q) q[k] = resolve(q[k]);
  MAP_STOPS.forEach((s) => { if (s.img) s.img = resolve(s.img); });
  const gpx = document.getElementById("gpxLink");
  if (gpx) {
    const url = map["mapa/rota.gpx"];
    if (url) gpx.setAttribute("href", url);
  }
}

function boot(){
  fetch("cdn.json", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((json) => applyCdnOverrides(json))
    .catch(() => { /* sem cdn.json: usa os arquivos locais */ })
    .finally(() => {
      render();
      initLiveMap();
    });
}

boot();
"""

OLD_BOOT = "render();\ninitLiveMap();"
OLD_CORTES = '    const videoSrc = corteFile ? "cortes/" + corteFile : (FILES.video ? `${FILES.video}#t=${c.inicio_sec},${c.fim_sec}` : null);'
NEW_CORTES = """    const corteSrc = corteFile
      ? (/^https?:\\/\\//i.test(corteFile) ? corteFile : "cortes/" + corteFile)
      : null;
    const videoSrc = corteSrc || (FILES.video ? `${FILES.video}#t=${c.inicio_sec},${c.fim_sec}` : null);"""
OLD_GPX = '<a class="btn" href="mapa/rota.gpx" download="rota.gpx"'
NEW_GPX = '<a class="btn" id="gpxLink" href="mapa/rota.gpx" download="rota.gpx"'

MEDIA_EXTS = (".mp4", ".webm", ".mov", ".m4v", ".wav", ".mp3", ".m4a", ".aac", ".ogg", ".srt")


def write_cdn_template(folder: Path) -> None:
    cdn_path = folder / "cdn.json"
    if cdn_path.exists():
        return
    keys: dict[str, str] = {}
    for p in sorted(folder.iterdir()):
        if p.is_file() and p.suffix.lower() in MEDIA_EXTS:
            keys[p.name] = ""
    cortes_dir = folder / "cortes"
    if cortes_dir.is_dir():
        for p in sorted(cortes_dir.iterdir()):
            if p.is_file() and p.suffix.lower() == ".mp4":
                keys[f"cortes/{p.name}"] = ""
    if (folder / "mapa" / "rota.gpx").exists():
        keys["mapa/rota.gpx"] = ""
    if keys:
        cdn_path.write_text(json.dumps(keys, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"  cdn.json criado em {folder.name}")


def patch_dashboard(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    original = text
    if "applyCdnOverrides" in text:
        print(f"  {path.parent.name}: já patcheado, pulando")
        return
    text = text.replace(OLD_BOOT, CDN_BLOCK, 1)
    text = text.replace(OLD_CORTES, NEW_CORTES, 1)
    text = text.replace(OLD_GPX, NEW_GPX, 1)
    if text == original:
        print(f"  {path.parent.name}: nada a alterar")
        return
    path.write_text(text, encoding="utf-8")
    print(f"  {path.parent.name}: dashboard patcheado")


def main() -> None:
    count = 0
    for folder in sorted(SAIDA.iterdir()):
        if not folder.is_dir():
            continue
        dash = folder / "dashboard.html"
        if not dash.exists():
            continue
        patch_dashboard(dash)
        write_cdn_template(folder)
        count += 1
    if count == 0:
        print("Nenhum dashboard.html encontrado em saida/")
        sys.exit(1)


if __name__ == "__main__":
    main()
