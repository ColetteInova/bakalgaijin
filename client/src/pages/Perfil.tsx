import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import {
    getIdToken,
    initFirebase,
    signInWithGoogle,
    signOutFirebase,
    watchAuth,
} from "@/lib/firebase";
import type { User } from "firebase/auth";
import { ArrowLeft, Heart, Loader2, LogOut, Mail, Twitch, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

interface SiteConfig {
  siteUrl?: string;
  twitchClientId?: string;
  twitchRedirectUri?: string;
  firebase?: {
    apiKey?: string;
    authDomain?: string;
    projectId?: string;
    appId?: string;
  };
}

interface Profile {
  uid?: string;
  nome?: string;
  email?: string;
  twitch?: string;
  notify?: boolean;
  provider?: string;
  status?: string;
}

function GoogleIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.26-2.09 3.57-5.17 3.57-8.81z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.87-3c-1.08.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.72-4.96H1.28v3.09A12 12 0 0 0 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.28 14.28a7.2 7.2 0 0 1 0-4.56V6.63H1.28a12 12 0 0 0 0 10.74l4-3.09z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.34.6 4.58 1.79l3.44-3.44A11.96 11.96 0 0 0 12 0 12 12 0 0 0 1.28 6.63l4 3.09C6.22 6.88 8.87 4.77 12 4.77z"
      />
    </svg>
  );
}

export default function Perfil() {
  const [config, setConfig] = useState<SiteConfig>({});
  const [firebaseEnabled, setFirebaseEnabled] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [twitchSession, setTwitchSession] = useState<{
    login: string;
    displayName: string;
    accessToken: string;
    profileImageUrl?: string;
    email?: string;
  } | null>(null);
  const [loadingProvider, setLoadingProvider] = useState<"google" | "twitch" | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingNotify, setSavingNotify] = useState(false);
  const [, setLocation] = useLocation();
  // Verificação inicial da sessão: só mostra os botões de login depois de
  // confirmar que NÃO há sessão válida (Firebase e Twitch)
  const [firebaseChecked, setFirebaseChecked] = useState(false);
  const [twitchChecked, setTwitchChecked] = useState(false);

  // Config do servidor + Firebase no client
  useEffect(() => {
    fetch(api("/api/config"))
      .then((res) => res.json())
      .then((c: SiteConfig) => {
        setConfig(c || {});
        const fb = c?.firebase;
        if (fb?.apiKey && fb.projectId && fb.appId) {
          const ok = initFirebase({
            apiKey: fb.apiKey,
            authDomain: fb.authDomain || "",
            projectId: fb.projectId,
            appId: fb.appId,
          });
          setFirebaseEnabled(ok);
          if (!ok) setFirebaseChecked(true);
        } else {
          setFirebaseChecked(true);
        }
      })
      .catch(() => setFirebaseChecked(true));
  }, []);

  // Observa a sessão do Firebase — só depois que o Firebase é inicializado,
  // senão o watchAuth registraria sem app e o usuário logado nunca apareceria
  useEffect(() => {
    if (!firebaseEnabled) return;
    return watchAuth((u) => {
      setUser(u);
      setFirebaseChecked(true);
    });
  }, [firebaseEnabled]);

  // Sessão Twitch (fora do Firebase): restaura e VALIDA o token no servidor
  // antes de considerar o usuário logado — token expirado volta para o login
  useEffect(() => {
    const raw = sessionStorage.getItem("twitch_oauth_session");
    if (!raw) {
      setTwitchChecked(true);
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed?.login || !parsed?.accessToken) throw new Error("sessão inválida");
      fetch(api("/api/twitch/user"), {
        headers: { Authorization: `Bearer ${parsed.accessToken}` },
      })
        .then(async (res) => {
          if (!res.ok) throw new Error("token expirado");
          const data = await res.json();
          setTwitchSession({
            login: data.login || parsed.login,
            displayName: data.displayName || parsed.displayName || parsed.login,
            accessToken: parsed.accessToken,
            profileImageUrl: data.profileImageUrl || parsed.profileImageUrl || "",
            email: data.email || parsed.email || "",
          });
        })
        .catch(() => {
          sessionStorage.removeItem("twitch_oauth_session");
        })
        .finally(() => setTwitchChecked(true));
    } catch {
      sessionStorage.removeItem("twitch_oauth_session");
      setTwitchChecked(true);
    }
  }, []);

  // Callback do fluxo implícito da Twitch
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const clearHash = () => history.replaceState(null, "", window.location.pathname + window.location.search);
    const token = params.get("access_token");
    if (!token) {
      if (params.get("error")) {
        clearHash();
        toast.error("Login da Twitch cancelado ou recusado.");
      }
      return;
    }
    const savedState = sessionStorage.getItem("twitch_oauth_state");
    sessionStorage.removeItem("twitch_oauth_state");
    if (savedState && params.get("state") !== savedState) {
      clearHash();
      toast.error("Falha na verificação de segurança do login da Twitch.");
      return;
    }
    clearHash();
    void finishTwitchLogin(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function finishTwitchLogin(accessToken: string) {
    setLoadingProvider("twitch");
    try {
      const res = await fetch(api(`/api/twitch/user?access_token=${encodeURIComponent(accessToken)}`));
      const data = await res.json();
      if (!res.ok || !data.login) {
        throw new Error(data?.error || "Não foi possível validar o login da Twitch.");
      }
      const session = {
        login: data.login,
        displayName: data.displayName || data.login,
        accessToken,
        profileImageUrl: data.profileImageUrl || "",
        email: data.email || "",
      };
      sessionStorage.setItem("twitch_oauth_session", JSON.stringify(session));
      setTwitchSession(session);
      toast.success(`Bem-vindo, @${data.login}!`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha no login da Twitch.");
    } finally {
      setLoadingProvider(null);
    }
  }

  function connectTwitch() {
    if (!config.twitchClientId) {
      toast.error("Login da Twitch não configurado no servidor.");
      return;
    }
    const state = crypto.randomUUID();
    sessionStorage.setItem("twitch_oauth_state", state);
    const url = new URL("https://id.twitch.tv/oauth2/authorize");
    url.searchParams.set("client_id", config.twitchClientId);
    url.searchParams.set("scope", "user:read:email");
    // Redirect fixo registrado no app Twitch (evita "redirect_uri mismatch"
    // quando o login começa no /perfil e termina no /cadastro)
    url.searchParams.set(
      "redirect_uri",
      config.twitchRedirectUri || `${window.location.origin}${window.location.pathname}`
    );
    url.searchParams.set("response_type", "token");
    url.searchParams.set("force_verify", "true");
    url.searchParams.set("state", state);
    window.location.href = url.toString();
  }

  async function loginGoogle() {
    if (!firebaseEnabled) {
      toast.error("Firebase não configurado no servidor.");
      return;
    }
    setLoadingProvider("google");
    try {
      await signInWithGoogle();
      document.cookie = "bakalover_auth=1; path=/; max-age=31536000";
      toast.success("Login com Google realizado!");
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === "auth/popup-closed-by-user") return;
      toast.error(error instanceof Error ? error.message : "Falha no login com Google.");
    } finally {
      setLoadingProvider(null);
    }
  }

  // Carrega o perfil quando há autenticação
  useEffect(() => {
    if (!user && !twitchSession) return;
    setLoading(true);
    const isTwitch = !!twitchSession;
    const url = isTwitch
      ? api(`/api/auth/profile?twitchAccessToken=${encodeURIComponent(twitchSession.accessToken)}`)
      : api("/api/auth/profile");
    const run = async () => {
      const token = isTwitch ? null : await getIdToken();
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.status === 401) {
        // Token inválido/expirado: limpa a sessão e volta para a tela de login
        logout();
        setLoading(false);
        return;
      }
      if (res.status === 404) {
        // Autenticado mas sem cadastro: usa a página de cadastro
        toast.info("Complete seu cadastro para virar Bakalover.");
        setLoading(false);
        setLocation("/cadastro");
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        toast.error(data?.error || "Falha ao carregar o perfil.");
        setProfile(null);
      } else {
        setProfile(data);
      }
      setLoading(false);
    };
    run().catch(() => setLoading(false));
  }, [user, twitchSession]);

  async function toggleNotify(checked: boolean) {
    if (!profile) return;
    const previous = profile.notify;
    setProfile((p) => (p ? { ...p, notify: checked } : p));
    setSavingNotify(true);
    try {
      const isTwitch = !!twitchSession;
      const token = isTwitch ? null : await getIdToken();
      const res = await fetch(api("/api/auth/profile"), {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(
          isTwitch
            ? { notify: checked, twitchAccessToken: twitchSession.accessToken }
            : { notify: checked }
        ),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Falha ao atualizar.");
      setProfile(data);
      toast.success(checked ? "Você receberá avisos por e-mail. 📬" : "Avisos por e-mail desativados.");
    } catch (error) {
      setProfile((p) => (p ? { ...p, notify: previous } : p));
      toast.error(error instanceof Error ? error.message : "Falha ao atualizar.");
    } finally {
      setSavingNotify(false);
    }
  }

  function logout() {
    document.cookie = "bakalover_auth=; path=/; max-age=0";
    if (twitchSession) {
      sessionStorage.removeItem("twitch_oauth_session");
      setTwitchSession(null);
    } else {
      signOutFirebase();
    }
    setProfile(null);
  }

  const loggedIn = !!user || !!twitchSession;
  const checking = !firebaseChecked || !twitchChecked;

  return (
    <div className="min-h-screen bg-[#0b0f1a] text-[#eef2ff] flex flex-col font-sans">
      <header className="border-b border-[#26304d]/80 bg-[#141a2e]/70 backdrop-blur-md sticky top-0 z-40">
        <div className="container max-w-3xl mx-auto px-4 h-16 flex items-center justify-between">
          <a
            href={config.siteUrl || (import.meta.env.DEV ? "http://localhost:8080/" : "/")}
            className="flex items-center gap-2 text-sm text-[#8b96b5] hover:text-[#eef2ff] transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Voltar para o site
          </a>
          <Badge variant="outline" className="border-[#ec4899]/40 text-[#ec4899] text-xs px-2 py-0">
            Painel do Bakalover
          </Badge>
        </div>
      </header>

      <main className="container max-w-3xl mx-auto px-4 py-8 flex-1">
        <div className="bg-[#141a2e] border border-[#26304d] rounded-2xl p-6 shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 right-0 w-72 h-72 bg-[#a855f7]/10 rounded-full blur-3xl pointer-events-none -mr-20 -mt-20" />
          <div className="absolute bottom-0 left-0 w-72 h-72 bg-[#ec4899]/10 rounded-full blur-3xl pointer-events-none -ml-20 -mb-20" />
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-[#a855f7] to-[#ec4899] flex items-center justify-center shadow-lg ring-1 ring-white/10">
                <Heart className="w-6 h-6 text-white" />
              </div>
              <div className="flex-1 min-w-0">
                <h1 className="font-bold text-xl tracking-tight bg-gradient-to-r from-[#d8b4fe] via-[#eef2ff] to-[#f9a8d4] bg-clip-text text-transparent">
                  Painel do Bakalover
                </h1>
                <p className="text-xs text-[#8b96b5]">Suas informações e avisos por e-mail</p>
              </div>
              <div className="hidden sm:block flex-1 h-px bg-[#26304d]" />
            </div>

            {checking ? (
              <div className="flex items-center justify-center py-12 text-[#8b96b5]">
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Verificando sua sessão...
              </div>
            ) : !loggedIn ? (
              <div className="space-y-3 max-w-sm mx-auto">
                <Button
                  type="button"
                  onClick={loginGoogle}
                  disabled={loadingProvider !== null || !firebaseEnabled}
                  className="w-full h-11 rounded-xl bg-white text-slate-900 hover:bg-slate-200 font-semibold text-sm"
                >
                  {loadingProvider === "google" ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <GoogleIcon />
                  )}
                  Entrar com Google
                </Button>
                <Button
                  type="button"
                  onClick={connectTwitch}
                  disabled={loadingProvider !== null || !config.twitchClientId}
                  className="w-full h-11 rounded-xl bg-[#a855f7] hover:bg-[#9333ea] text-white font-semibold text-sm"
                >
                  {loadingProvider === "twitch" ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Twitch className="w-4 h-4 mr-2" />
                  )}
                  Entrar com Twitch
                </Button>
              </div>
            ) : loading ? (
              <div className="flex items-center justify-center py-12 text-[#8b96b5]">
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Carregando seu perfil...
              </div>
            ) : !profile ? (
              <div className="text-center py-8">
                <p className="text-sm text-[#8b96b5] mb-4">Não foi possível carregar seu perfil.</p>
                <Button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="h-10 px-5 rounded-xl bg-gradient-to-r from-[#a855f7] to-[#ec4899] hover:from-[#9333ea] hover:to-[#db2777] text-white font-semibold shadow-lg shadow-[#a855f7]/20"
                >
                  Tentar novamente
                </Button>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-5 rounded-xl bg-[#0f172a] border border-[#26304d] p-4">
                  <div className="flex items-center gap-3 min-w-0">
                    {user?.photoURL || twitchSession?.profileImageUrl ? (
                      <img
                        src={user?.photoURL || twitchSession?.profileImageUrl}
                        alt=""
                        className="w-12 h-12 rounded-full object-cover ring-2 ring-[#a855f7]/50 bg-white"
                      />
                    ) : (
                      <div className="w-12 h-12 rounded-full bg-gradient-to-tr from-[#a855f7] to-[#ec4899] flex items-center justify-center text-lg font-bold">
                        {(profile.nome || twitchSession?.login || user?.displayName || "B").slice(0, 1).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="font-semibold truncate">{profile.nome}</p>
                      <p className="text-[11px] text-[#8b96b5] truncate">
                        {twitchSession ? `@${twitchSession.login}` : profile.email || profile.uid}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[10px] font-extrabold uppercase tracking-wider text-[#f59e0b] bg-[#f59e0b]/10 border border-[#f59e0b]/30 px-2 py-1 rounded-full">
                      Bakalover Oficial
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={logout}
                      className="border-[#26304d] bg-[#1a2138]/70 hover:bg-[#1a2138] text-[#cbd5e1] text-xs"
                    >
                      <LogOut className="w-3.5 h-3.5 mr-1" /> Sair
                    </Button>
                  </div>
                </div>

                <div className="space-y-3 mb-6">
                  <div className="flex items-center gap-3 rounded-xl bg-[#0f172a] border border-[#26304d] p-3.5">
                    <UserRound className="w-4 h-4 text-[#8b96b5] shrink-0" />
                    <div className="min-w-0">
                      <p className="text-[11px] text-[#8b96b5]">Nome</p>
                      <p className="text-sm truncate">{profile.nome || "—"}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 rounded-xl bg-[#0f172a] border border-[#26304d] p-3.5">
                    <Mail className="w-4 h-4 text-[#8b96b5] shrink-0" />
                    <div className="min-w-0">
                      <p className="text-[11px] text-[#8b96b5]">E-mail</p>
                      <p className="text-sm truncate">{profile.email || "—"}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 rounded-xl bg-[#0f172a] border border-[#26304d] p-3.5">
                    <Twitch className="w-4 h-4 text-[#a855f7] shrink-0" />
                    <div className="min-w-0">
                      <p className="text-[11px] text-[#8b96b5]">Twitch</p>
                      <p className="text-sm truncate">{profile.twitch ? `@${profile.twitch}` : "—"}</p>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-4 rounded-xl bg-[#0f172a] border border-[#26304d] p-4">
                  <div className="min-w-0">
                    <Label className="text-sm font-medium cursor-pointer">Quero ser avisado de novas análises</Label>
                    <p className="text-[11px] text-[#8b96b5] mt-0.5">
                      Enviaremos um e-mail quando uma nova análise de live for publicada.
                    </p>
                  </div>
                  <Switch
                    checked={profile.notify === true}
                    onCheckedChange={toggleNotify}
                    disabled={savingNotify}
                    className="data-[state=checked]:bg-[#a855f7] data-[state=unchecked]:bg-[#1a2138]"
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </main>

      <footer className="border-t border-[#26304d] bg-[#0b0f1a] py-4 text-center text-xs text-[#8b96b5]">
        <p>Bakalovers &bull; Comunidade oficial de fãs</p>
      </footer>
    </div>
  );
}
