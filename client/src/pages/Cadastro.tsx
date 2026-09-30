import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import {
    getIdToken,
    initFirebase,
    signInWithGoogle,
    signOutFirebase,
    watchAuth,
} from "@/lib/firebase";
import type { User } from "firebase/auth";
import { ArrowLeft, CheckCircle2, Heart, Loader2, LogOut, Mail, Twitch } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

interface SiteConfig {
  siteUrl?: string;
  twitchClientId?: string;
  twitchRedirectUri?: string;
  firebase?: {
    enabled?: boolean;
    apiKey?: string;
    authDomain?: string;
    projectId?: string;
    appId?: string;
  };
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

export default function Cadastro() {
  const [config, setConfig] = useState<SiteConfig>({});
  const [firebaseEnabled, setFirebaseEnabled] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [loadingProvider, setLoadingProvider] = useState<"google" | "twitch" | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ nome: "", email: "", notify: true });
  const [twitchLogin, setTwitchLogin] = useState("");
  const [twitchSession, setTwitchSession] = useState<{
    login: string;
    displayName: string;
    accessToken: string;
    profileImageUrl?: string;
    email?: string;
  } | null>(null);
  const [, setLocation] = useLocation();
  // Aviso exibido quando o usuário vem da fanpage querendo apoiar sem estar logado
  const [apoioAviso, setApoioAviso] = useState("");
  // Enquanto descobre se já é Bakalover, mostra loading em vez do formulário
  const [firebaseChecked, setFirebaseChecked] = useState(false);
  const [twitchChecked, setTwitchChecked] = useState(false);
  const [redirectPending, setRedirectPending] = useState(false);

  // Se veio da fanpage para apoiar (?apoiar=1), retoma o checkout após virar Bakalover
  function destinoPosCadastro(): string {
    const params = new URLSearchParams(window.location.search);
    const comprar = params.get("comprar");
    if (params.get("apoiar") !== "1" || !comprar) return "/perfil";
    const periodo = params.get("periodo") || "";
    return `/perfil?comprar=${encodeURIComponent(comprar)}&periodo=${encodeURIComponent(periodo)}`;
  }

  // Aviso específico para quem quer apoiar mas ainda não é Bakalover
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("apoiar") === "1") {
      setApoioAviso(
        "Para apoiar é preciso ser Bakalover. 💛 Leva menos de um minuto: entre com Google ou Twitch, confirme seus dados e o checkout abre na sequência."
      );
    }
  }, []);

  // Carrega a config do servidor e inicializa o Firebase (Auth) no client
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
        }
      })
      .catch(() => {
        // sem config: botões de login permanecem desativados
      })
      .finally(() => setFirebaseChecked(true));
  }, []);

  // Observa a sessão do Firebase
  useEffect(() => {
    if (!firebaseEnabled) return;
    return watchAuth((u) => {
      setUser(u);
      setFirebaseChecked(true);
      if (u) {
        setForm((f) => ({
          ...f,
          nome: f.nome || u.displayName || "",
          email: f.email || u.email || "",
        }));
        // Já tem cadastro salvo no Firebase? Vai direto para o painel.
        void redirectIfAlreadyRegistered(null);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firebaseEnabled]);

  // Se o usuário já tem cadastro no Firebase (Firestore), redireciona para o painel
  async function redirectIfAlreadyRegistered(session: { accessToken: string } | null) {
    setRedirectPending(true);
    try {
      let res: Response | null = null;
      if (session) {
        res = await fetch(
          api(`/api/auth/profile?twitchAccessToken=${encodeURIComponent(session.accessToken)}`)
        );
      } else {
        const token = await getIdToken();
        if (token) {
          res = await fetch(api("/api/auth/profile"), {
            headers: { Authorization: `Bearer ${token}` },
          });
        }
      }
      if (res?.ok) {
        toast.success("Você já é Bakalover! Abrindo seu painel...");
        setLocation(destinoPosCadastro());
      }
    } catch {
      // sem cadastro: segue o fluxo normal
    } finally {
      setRedirectPending(false);
    }
  }

  // Restaura a sessão da Twitch (validada por fora do Firebase)
  useEffect(() => {
    const raw = sessionStorage.getItem("twitch_oauth_session");
    if (!raw) {
      setTwitchChecked(true);
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.login && parsed?.accessToken) {
        setTwitchSession(parsed);
        setTwitchLogin(parsed.login);
        setForm((f) => ({ ...f, email: f.email || parsed.email || "" }));
        void redirectIfAlreadyRegistered(parsed);
      } else {
        sessionStorage.removeItem("twitch_oauth_session");
      }
    } catch {
      sessionStorage.removeItem("twitch_oauth_session");
    } finally {
      setTwitchChecked(true);
    }
  }, []);

  // Callback do fluxo implícito da Twitch (#access_token=...)
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

  // Twitch é autenticada por fora do Firebase: valida o token direto na Twitch
  // e guarda a sessão localmente (nenhum usuário é criado no Firebase Auth).
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
      setTwitchLogin(data.login);
      setForm((f) => ({ ...f, email: f.email || data.email || "" }));
      toast.success(`Bem-vindo, @${data.login}!`);
      // Já tem cadastro salvo no Firebase? Vai direto para o painel.
      void redirectIfAlreadyRegistered(session);
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

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!user && !twitchSession) return;
    const emailLimpo = form.email.trim();
    if (!form.nome.trim()) {
      toast.error("Preencha o nome.");
      return;
    }
    if (!emailLimpo) {
      toast.error("Preencha o e-mail.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLimpo)) {
      toast.error("E-mail inválido.");
      return;
    }
    setSaving(true);
    try {
      // Google: ID token do Firebase. Twitch: access token validado direto na Twitch.
      const isTwitch = !!twitchSession;
      const token = isTwitch ? null : await getIdToken();
      const res = await fetch(api("/api/auth/register"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(
          isTwitch
            ? {
                nome: form.nome,
                email: emailLimpo,
                notify: form.notify,
                twitchAccessToken: twitchSession.accessToken,
                twitch: twitchSession.login,
              }
            : {
                nome: form.nome,
                email: emailLimpo,
                notify: form.notify,
              }
        ),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Falha ao salvar o cadastro.");
      toast.success("Cadastro concluído! Bem-vindo ao time de Bakalovers oficiais.");
      // Mantém a sessão da Twitch ativa para o painel carregar o perfil na hora
      setLocation(destinoPosCadastro());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao salvar o cadastro.");
    } finally {
      setSaving(false);
    }
  }

  const inputClass =
    "bg-[#0f172a] border-[#26304d] text-[#eef2ff] placeholder:text-[#8b96b5] focus-visible:ring-[#a855f7]/50";

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
            Cadastro
          </Badge>
        </div>
      </header>

      <main className="container max-w-3xl mx-auto px-4 py-8 flex-1">
        {!firebaseChecked || !twitchChecked || redirectPending ? (
          <div className="bg-[#141a2e] border border-[#26304d] rounded-2xl p-10 shadow-2xl flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-[#a855f7]" />
            <p className="text-sm text-[#8b96b5]">Verificando sua sessão...</p>
          </div>
        ) : (
          <>
        {apoioAviso && (
          <div className="mb-4 rounded-xl border border-[#f59e0b]/40 bg-[#f59e0b]/10 px-4 py-3 text-sm text-[#fbbf24] text-center">
            {apoioAviso}
          </div>
        )}
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
                  Quero ser Bakalover
                </h1>
                <p className="text-xs text-[#8b96b5]">Entre com Google ou Twitch e vire um Bakalover oficial</p>
              </div>
              <div className="hidden sm:block flex-1 h-px bg-[#26304d]" />
            </div>

            {!user && !twitchSession ? (
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
                  Continuar com Google
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
                  Continuar com Twitch
                </Button>
                {!firebaseEnabled && (
                  <p className="text-[11px] text-[#8b96b5] text-center">
                    Cadastro indisponível: Firebase não configurado no servidor.
                  </p>
                )}
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-5 rounded-xl bg-[#0f172a] border border-[#26304d] p-3">
                  <div className="flex items-center gap-3 min-w-0">
                    {user?.photoURL || twitchSession?.profileImageUrl ? (
                      <img src={user?.photoURL || twitchSession?.profileImageUrl} alt="" className="w-10 h-10 rounded-full object-cover ring-2 ring-[#a855f7]/50 bg-white" />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-[#a855f7] to-[#ec4899] flex items-center justify-center text-sm font-bold">
                        {(twitchSession?.login || user?.displayName || user?.email || "B").slice(0, 1).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">
                        {twitchSession ? `@${twitchSession.login}` : user?.displayName || user?.email || user?.uid}
                      </p>
                      <p className="text-[11px] text-[#8b96b5] truncate">
                        {twitchSession
                          ? "conectado pela Twitch"
                          : `conectado por ${user?.providerData[0]?.providerId || "Google"}`}
                      </p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      document.cookie = "bakalover_auth=; path=/; max-age=0";
                      if (twitchSession) {
                        sessionStorage.removeItem("twitch_oauth_session");
                        setTwitchSession(null);
                        setTwitchLogin("");
                      } else {
                        signOutFirebase();
                      }
                    }}
                    className="shrink-0 border-[#26304d] bg-[#1a2138]/70 hover:bg-[#1a2138] text-[#cbd5e1] text-xs"
                  >
                    <LogOut className="w-3.5 h-3.5 mr-1" /> Sair
                  </Button>
                </div>

                <form
                  onSubmit={save}
                  onKeyDown={(e) => {
                    // Enter nos campos NÃO cadastra sozinho — só o clique no botão
                    if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
                      e.preventDefault();
                    }
                  }}
                  className="space-y-5"
                >
                  <div className="space-y-1.5">
                    <Label htmlFor="nome" className="text-[#cbd5e1]">
                      Nome <span className="text-[#ec4899]">*</span>
                    </Label>
                    <Input
                      id="nome"
                      value={form.nome}
                      onChange={(e) => setForm((f) => ({ ...f, nome: e.target.value }))}
                      placeholder="Seu nome"
                      className={inputClass}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="email" className="text-[#cbd5e1] flex items-center gap-1.5">
                      <Mail className="w-3.5 h-3.5 text-[#8b96b5]" /> E-mail <span className="text-[#ec4899]">*</span>
                    </Label>
                    <Input
                      id="email"
                      type="email"
                      value={form.email}
                      onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                      placeholder="voce@email.com"
                      className={inputClass}
                    />
                  </div>
                  {twitchLogin && (
                    <div className="space-y-1.5">
                      <Label className="text-[#cbd5e1] flex items-center gap-1.5">
                        <Twitch className="w-3.5 h-3.5 text-[#a855f7]" /> Twitch
                      </Label>
                      <p className="text-sm text-[#c084fc]">
                        <CheckCircle2 className="w-3.5 h-3.5 inline mr-1" /> @{twitchLogin}
                      </p>
                    </div>
                  )}
                  <div className="flex items-start gap-2.5 rounded-xl bg-[#0f172a] border border-[#26304d] p-3.5">
                    <Checkbox
                      id="notify"
                      checked={form.notify}
                      onCheckedChange={(checked) => setForm((f) => ({ ...f, notify: checked === true }))}
                      className="mt-0.5 border-[#26304d] data-[state=checked]:bg-[#a855f7] data-[state=checked]:border-[#a855f7]"
                    />
                    <div>
                      <Label htmlFor="notify" className="text-sm text-[#eef2ff] font-medium cursor-pointer">
                        Quero ser avisado de novas análises
                      </Label>
                      <p className="text-[11px] text-[#8b96b5]">
                        Enviaremos um e-mail quando uma nova análise de live for publicada.
                      </p>
                    </div>
                  </div>
                  <Button
                    type="submit"
                    disabled={saving}
                    className="w-full h-11 rounded-xl bg-gradient-to-r from-[#a855f7] to-[#ec4899] hover:from-[#9333ea] hover:to-[#db2777] text-white font-semibold shadow-lg shadow-[#a855f7]/20"
                  >
                    {saving ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Salvando cadastro...
                      </>
                    ) : (
                      <>
                        <Heart className="w-4 h-4 mr-2" />
                        Virar Bakalover
                      </>
                    )}
                  </Button>
                  <p className="text-[11px] text-[#8b96b5] text-center">
                    Seus dados ficam protegidos no Firebase.
                  </p>
                </form>
              </>
            )}
          </div>
        </div>
          </>
        )}
      </main>

      <footer className="border-t border-[#26304d] bg-[#0b0f1a] py-4 text-center text-xs text-[#8b96b5]">
        <p>Bakalovers &bull; Comunidade oficial de fãs</p>
      </footer>
    </div>
  );
}
