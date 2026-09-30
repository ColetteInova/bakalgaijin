import { Button } from "@/components/ui/button";
import { initFirebase, watchAuth } from "@/lib/firebase";
import type { User } from "firebase/auth";
import { Heart, LayoutDashboard } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "wouter";

// Botão do header que reflete o estado de login do bakalover:
// - logado (Google ou Twitch): "Painel Bakalover" → /perfil
// - não logado: "Quero ser um Bakalover" → /cadastro e "Já sou um Bakalover" → /perfil
export default function BakaloverButton() {
  const [user, setUser] = useState<User | null>(null);
  const [twitchLogged, setTwitchLogged] = useState(false);

  // Inicializa o Firebase com a config pública do servidor
  useEffect(() => {
    fetch("/api/config")
      .then((res) => res.json())
      .then((c) => {
        const fb = c?.firebase;
        if (fb?.apiKey && fb.projectId && fb.appId) {
          initFirebase({
            apiKey: fb.apiKey,
            authDomain: fb.authDomain || "",
            projectId: fb.projectId,
            appId: fb.appId,
          });
        }
      })
      .catch(() => {});
  }, []);

  // Sessão do Google (Firebase Auth)
  useEffect(() => watchAuth(setUser), []);

  // Sessão da Twitch (guardada em sessionStorage, fora do Firebase)
  useEffect(() => {
    const check = () => {
      try {
        const raw = sessionStorage.getItem("twitch_oauth_session");
        setTwitchLogged(!!(raw && JSON.parse(raw)?.login));
      } catch {
        setTwitchLogged(false);
      }
    };
    check();
    window.addEventListener("storage", check);
    return () => window.removeEventListener("storage", check);
  }, []);

  const loggedIn = !!user || twitchLogged;

  if (loggedIn) {
    return (
      <Link href="/perfil">
        <Button
          size="sm"
          className="h-8 px-3 rounded-lg bg-gradient-to-r from-[#a855f7] to-[#ec4899] hover:from-[#9333ea] hover:to-[#db2777] text-white text-xs font-semibold shadow-lg shadow-[#a855f7]/20"
        >
          <LayoutDashboard className="w-3.5 h-3.5 mr-1" /> Painel Bakalover
        </Button>
      </Link>
    );
  }

  return (
    <>
      <Link href="/cadastro">
        <Button
          size="sm"
          className="h-8 px-3 rounded-lg bg-gradient-to-r from-[#a855f7] to-[#ec4899] hover:from-[#9333ea] hover:to-[#db2777] text-white text-xs font-semibold shadow-lg shadow-[#a855f7]/20"
        >
          <Heart className="w-3.5 h-3.5 mr-1" /> Quero ser um Bakalover
        </Button>
      </Link>
      <Link href="/perfil">
        <Button
          size="sm"
          variant="outline"
          className="h-8 px-3 rounded-lg border-[#26304d] bg-[#1a2138]/70 hover:bg-[#1a2138] text-[#cbd5e1] text-xs"
        >
          Já sou um Bakalover
        </Button>
      </Link>
    </>
  );
}
