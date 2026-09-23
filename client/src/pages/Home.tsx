import React, { useState, useEffect, useRef } from "react";
import { 
  Mic, 
  MicOff, 
  Trash2, 
  Copy, 
  Check, 
  Volume2, 
  Sparkles, 
  Languages, 
  ArrowRightLeft,
  PlayCircle,
  HelpCircle,
  AlertCircle,
  Twitch
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Link } from "wouter";

interface HistoryItem {
  id: string;
  japanese: string;
  romaji?: string;
  portuguese: string;
  timestamp: string;
}

const PRESET_PHRASES = [
  { ja: "こんにちは、お元気ですか？", romaji: "Konnichiwa, ogenki desu ka?", pt: "Olá, como você está?" },
  { ja: "はじめまして、よろしくお願いします。", romaji: "Hajimemashite, yoroshiku onegaishimasu.", pt: "Muito prazer em conhecê-lo." },
  { ja: "この近くに美味しいレストランはありますか？", romaji: "Kono chikaku ni oishii resutoran wa arimasu ka?", pt: "Tem algum restaurante bom aqui perto?" },
  { ja: "駅はどこにありますか？", romaji: "Eki wa doko ni arimasu ka?", pt: "Onde fica a estação de trem?" },
  { ja: "どうもありがとうございます！", romaji: "Doumo arigatou gozaimasu!", pt: "Muito obrigado(a)!" },
  { ja: "日本語を少し勉強しています。", romaji: "Nihongo o sukoshi benkyou shite imasu.", pt: "Estou estudando um pouco de japonês." }
];

export default function Home() {
  const [isListening, setIsListening] = useState(false);
  const [interimJapanese, setInterimJapanese] = useState("");
  const [currentJapanese, setCurrentJapanese] = useState("");
  const [currentPortuguese, setCurrentPortuguese] = useState("");
  const [isTranslating, setIsTranslating] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    return [
      {
        id: "1",
        japanese: "こんにちは！今日はとても良い天気ですね。",
        romaji: "Konnichiwa! Kyou wa totemo ii tenki desu ne.",
        portuguese: "Olá! Hoje o tempo está muito bom, não é?",
        timestamp: "12:30"
      },
      {
        id: "2",
        japanese: "日本語の音声をリアルタイムで翻訳します。",
        romaji: "Nihongo no onsei o riarutaimu de honyaku shimasu.",
        portuguese: "Traduz áudio em japonês em tempo real.",
        timestamp: "12:31"
      }
    ];
  });
  const [copiedJa, setCopiedJa] = useState(false);
  const [copiedPt, setCopiedPt] = useState(false);
  const [hasSpeechSupport, setHasSpeechSupport] = useState(true);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    const SpeechRecognition = 
      (window as any).SpeechRecognition || 
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setHasSpeechSupport(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "ja-JP";
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onstart = () => {
      setIsListening(true);
      toast.info("Microfone ativado! Fale em japonês.");
    };

    recognition.onresult = (event: any) => {
      let interim = "";
      let final = "";

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          final += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
        }
      }

      if (interim) {
        setInterimJapanese(interim);
      }

      if (final) {
        setInterimJapanese("");
        handleNewJapaneseText(final);
      }
    };

    recognition.onerror = (event: any) => {
      console.error("Speech Recognition Error:", event.error);
      if (event.error === "not-allowed") {
        toast.error("Permissão de microfone negada no navegador.");
      } else if (event.error !== "no-speech") {
        toast.error(`Erro no microfone: ${event.error}`);
      }
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;

    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch (e) {
          // ignore
        }
      }
    };
  }, []);

  // Função para traduzir Japonês -> Português (MyMemory API com fallback elegante)
  const translateText = async (text: string): Promise<string> => {
    try {
      const encoded = encodeURIComponent(text);
      const res = await fetch(`https://api.mymemory.translated.net/get?q=${encoded}&langpair=ja|pt-BR`);
      if (!res.ok) throw new Error("Falha na tradução pública");
      const data = await res.json();
      if (data && data.responseData && data.responseData.translatedText) {
        return data.responseData.translatedText;
      }
    } catch (err) {
      console.warn("MyMemory API falhou, tentando fallback direto", err);
    }

    // Fallback com dicionário de termos comuns se API falhar
    const matched = PRESET_PHRASES.find(p => p.ja.includes(text) || text.includes(p.ja));
    if (matched) return matched.pt;

    return "Tradução estimada: " + text;
  };

  const handleNewJapaneseText = async (text: string) => {
    setCurrentJapanese(text);
    setIsTranslating(true);
    const pt = await translateText(text);
    setCurrentPortuguese(pt);
    setIsTranslating(false);

    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    setHistory(prev => [
      {
        id: Math.random().toString(),
        japanese: text,
        portuguese: pt,
        timestamp: timeStr
      },
      ...prev.slice(0, 19)
    ]);
  };

  const toggleListening = () => {
    if (!hasSpeechSupport) {
      toast.error("O seu navegador não possui suporte à API de reconhecimento de voz.");
      return;
    }

    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      toast.info("Captura de áudio pausada.");
    } else {
      try {
        recognitionRef.current?.start();
      } catch (err) {
        console.error("Falha ao iniciar reconhecimento:", err);
      }
    }
  };

  const playTTS = (text: string, lang: string) => {
    if (!('speechSynthesis' in window)) {
      toast.error("Seu navegador não suporta síntese de voz.");
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = 0.95;
    window.speechSynthesis.speak(utterance);
    toast.success(`Reproduzindo áudio em ${lang === 'ja-JP' ? 'japonês' : 'português'}...`);
  };

  const copyToClipboard = (text: string, isJa: boolean) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    if (isJa) {
      setCopiedJa(true);
      setTimeout(() => setCopiedJa(false), 2000);
    } else {
      setCopiedPt(true);
      setTimeout(() => setCopiedPt(false), 2000);
    }
    toast.success("Texto copiado para a área de transferência!");
  };

  const clearAll = () => {
    setCurrentJapanese("");
    setCurrentPortuguese("");
    setInterimJapanese("");
    setHistory([]);
    toast.info("Painel e histórico limpos.");
  };

  const useSample = (phrase: typeof PRESET_PHRASES[0]) => {
    handleNewJapaneseText(phrase.ja);
    toast.success("Frase de exemplo aplicada!");
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-rose-500 selection:text-white">
      {/* Top Banner / Navbar */}
      <header className="border-b border-slate-800/80 bg-slate-900/60 backdrop-blur-md sticky top-0 z-40">
        <div className="container max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-rose-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-rose-900/20 ring-1 ring-white/10">
              <Languages className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-lg tracking-tight bg-gradient-to-r from-rose-200 via-slate-100 to-indigo-200 bg-clip-text text-transparent">
                  KotobaLive
                </span>
                <Badge variant="outline" className="border-rose-500/40 text-rose-400 text-xs px-2 py-0">
                  JA ➔ PT-BR
                </Badge>
              </div>
              <p className="text-xs text-slate-400">Captura de Voz em Japonês e Tradução em Tempo Real</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Link href="/vod">
              <Button
                variant="outline"
                size="sm"
                className="border-slate-700 bg-slate-800/50 hover:bg-slate-800 text-slate-300 text-xs"
              >
                <Twitch className="w-3.5 h-3.5 mr-1 text-purple-400" />
                Baixar VODs
              </Button>
            </Link>
            <Button
              variant="outline"
              size="sm"
              onClick={clearAll}
              className="border-slate-700 bg-slate-800/50 hover:bg-slate-800 text-slate-300 text-xs"
            >
              <Trash2 className="w-3.5 h-3.5 mr-1 text-slate-400" />
              Limpar
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="container max-w-7xl mx-auto px-4 py-6 flex-1 flex flex-col gap-6">
        
        {/* Banner de Status / Controles Principais */}
        <div className="bg-gradient-to-r from-slate-900 via-slate-850 to-slate-900 border border-slate-800 rounded-2xl p-5 shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 right-0 w-96 h-96 bg-rose-600/10 rounded-full blur-3xl pointer-events-none -mr-20 -mt-20" />
          <div className="absolute bottom-0 left-0 w-96 h-96 bg-indigo-600/10 rounded-full blur-3xl pointer-events-none -ml-20 -mb-20" />

          <div className="relative z-10 flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="relative">
                <Button
                  size="lg"
                  onClick={toggleListening}
                  className={`h-16 px-8 rounded-full font-medium transition-all shadow-xl flex items-center gap-3 text-base ${
                    isListening
                      ? "bg-rose-600 hover:bg-rose-700 text-white animate-pulse ring-4 ring-rose-500/30"
                      : "bg-indigo-600 hover:bg-indigo-700 text-white ring-2 ring-indigo-500/30"
                  }`}
                >
                  {isListening ? (
                    <>
                      <MicOff className="w-6 h-6 animate-bounce" />
                      <span>Parar Gravação</span>
                    </>
                  ) : (
                    <>
                      <Mic className="w-6 h-6" />
                      <span>Iniciar Captura de Voz</span>
                    </>
                  )}
                </Button>
                {isListening && (
                  <span className="absolute -top-1 -right-1 flex h-4 w-4">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-4 w-4 bg-rose-500"></span>
                  </span>
                )}
              </div>

              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-200">
                    {isListening ? "Ouvindo áudio em Japonês (ja-JP)..." : "Microfone pronto"}
                  </span>
                  {isListening && (
                    <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  )}
                </div>
                <p className="text-xs text-slate-400">
                  {hasSpeechSupport 
                    ? "Fale no microfone ou clique nas frases de demonstração abaixo"
                    : "Atenção: Seu navegador não suporta reconhecimento direto, utilize os botões de simulação."}
                </p>
              </div>
            </div>

            {/* Ações Rápidas de Teste */}
            <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
              <span className="text-slate-400 flex items-center gap-1">
                <Sparkles className="w-3.5 h-3.5 text-rose-400" />
                Exemplos para testar:
              </span>
              {PRESET_PHRASES.slice(0, 3).map((p, idx) => (
                <button
                  key={idx}
                  onClick={() => useSample(p)}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 border border-slate-700/60 text-slate-300 transition-colors"
                >
                  {p.ja}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* PAINEL DUPLO LADO A LADO: JAPONÊS (ESQUERDA) VS TRADUÇÃO (DIREITA) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 flex-1">
          
          {/* LADO ESQUERDO: ÁUDIO E TEXTO EM JAPONÊS */}
          <div className="flex flex-col bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-xl ring-1 ring-white/5">
            {/* Header Lado Esquerdo */}
            <div className="px-5 py-4 border-b border-slate-800/80 bg-slate-900 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xl">🇯🇵</span>
                <div>
                  <h2 className="font-semibold text-sm text-slate-100 flex items-center gap-2">
                    Áudio Capturado (Japonês)
                    <Badge variant="secondary" className="bg-rose-950/60 text-rose-300 border-rose-800 text-[10px] px-1.5">
                      ja-JP
                    </Badge>
                  </h2>
                  <p className="text-[11px] text-slate-400">Transcrição em tempo real do áudio</p>
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-slate-400 hover:text-slate-100"
                  onClick={() => playTTS(currentJapanese || interimJapanese, "ja-JP")}
                  disabled={!currentJapanese && !interimJapanese}
                  title="Ouvir em Japonês"
                >
                  <Volume2 className="w-4 h-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-slate-400 hover:text-slate-100"
                  onClick={() => copyToClipboard(currentJapanese || interimJapanese, true)}
                  disabled={!currentJapanese && !interimJapanese}
                  title="Copiar texto"
                >
                  {copiedJa ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </Button>
              </div>
            </div>

            {/* Conteúdo Lado Esquerdo */}
            <div className="p-6 flex-1 flex flex-col justify-between min-h-[260px] bg-gradient-to-b from-slate-900/40 to-slate-950/40">
              <div className="space-y-4">
                {currentJapanese || interimJapanese ? (
                  <div>
                    <div className="text-2xl md:text-3xl font-medium tracking-wide text-rose-100 leading-relaxed font-sans">
                      {currentJapanese}
                      {interimJapanese && (
                        <span className="text-rose-400/70 italic ml-2">
                          {interimJapanese} ...
                        </span>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center py-12 text-center text-slate-500">
                    <div className="w-12 h-12 rounded-full bg-slate-800/80 flex items-center justify-center mb-3">
                      <Mic className="w-6 h-6 text-slate-400" />
                    </div>
                    <p className="text-sm font-medium text-slate-300">Aguardando áudio em japonês...</p>
                    <p className="text-xs text-slate-500 mt-1 max-w-xs">
                      Clique no botão "Iniciar Captura de Voz" e comece a falar, ou clique em uma das frases abaixo.
                    </p>
                  </div>
                )}
              </div>

              {/* Indicador de Status inferior */}
              <div className="pt-4 border-t border-slate-800/60 flex items-center justify-between text-xs text-slate-400">
                <span className="flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full ${isListening ? "bg-rose-500 animate-ping" : "bg-slate-600"}`} />
                  {isListening ? "Escutando continuamente..." : "Microfone ocioso"}
                </span>
                <span className="text-[11px] text-slate-500">
                  {currentJapanese.length} caracteres capturados
                </span>
              </div>
            </div>
          </div>

          {/* LADO DIREITO: TRADUÇÃO EM PORTUGUÊS */}
          <div className="flex flex-col bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-xl ring-1 ring-white/5">
            {/* Header Lado Direito */}
            <div className="px-5 py-4 border-b border-slate-800/80 bg-slate-900 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xl">🇧🇷</span>
                <div>
                  <h2 className="font-semibold text-sm text-slate-100 flex items-center gap-2">
                    Tradução em Português
                    <Badge variant="secondary" className="bg-indigo-950/60 text-indigo-300 border-indigo-800 text-[10px] px-1.5">
                      pt-BR
                    </Badge>
                  </h2>
                  <p className="text-[11px] text-slate-400">Resultado traduzido simultaneamente</p>
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-slate-400 hover:text-slate-100"
                  onClick={() => playTTS(currentPortuguese, "pt-BR")}
                  disabled={!currentPortuguese}
                  title="Ouvir em Português"
                >
                  <Volume2 className="w-4 h-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-slate-400 hover:text-slate-100"
                  onClick={() => copyToClipboard(currentPortuguese, false)}
                  disabled={!currentPortuguese}
                  title="Copiar texto traduzido"
                >
                  {copiedPt ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </Button>
              </div>
            </div>

            {/* Conteúdo Lado Direito */}
            <div className="p-6 flex-1 flex flex-col justify-between min-h-[260px] bg-gradient-to-b from-slate-900/40 to-slate-950/40">
              <div className="space-y-4">
                {isTranslating ? (
                  <div className="h-full flex flex-col items-center justify-center py-12 text-center">
                    <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-3" />
                    <p className="text-sm text-indigo-300">Traduzindo do japonês para o português...</p>
                  </div>
                ) : currentPortuguese ? (
                  <div>
                    <div className="text-2xl md:text-3xl font-medium tracking-tight text-indigo-100 leading-relaxed">
                      {currentPortuguese}
                    </div>
                  </div>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center py-12 text-center text-slate-500">
                    <div className="w-12 h-12 rounded-full bg-slate-800/80 flex items-center justify-center mb-3">
                      <ArrowRightLeft className="w-6 h-6 text-slate-400" />
                    </div>
                    <p className="text-sm font-medium text-slate-300">Aguardando tradução...</p>
                    <p className="text-xs text-slate-500 mt-1 max-w-xs">
                      Assim que o áudio em japonês for capturado, a tradução correspondente aparecerá aqui.
                    </p>
                  </div>
                )}
              </div>

              {/* Indicador de Status inferior */}
              <div className="pt-4 border-t border-slate-800/60 flex items-center justify-between text-xs text-slate-400">
                <span className="flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full ${currentPortuguese ? "bg-indigo-400" : "bg-slate-600"}`} />
                  {currentPortuguese ? "Tradução concluída" : "Pronto para traduzir"}
                </span>
                <span className="text-[11px] text-slate-500">
                  Português Brasileiro (pt-BR)
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* BANCO DE FRASES E SIMULADOR DE ÁUDIO */}
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
              <PlayCircle className="w-4 h-4 text-rose-400" />
              Frases em Japonês para Testar (Simulação de Áudio)
            </h3>
            <span className="text-xs text-slate-400">Clique para testar a transcrição e tradução imediata</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {PRESET_PHRASES.map((phrase, idx) => (
              <div 
                key={idx}
                onClick={() => useSample(phrase)}
                className="group p-3.5 rounded-xl bg-slate-850/80 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 cursor-pointer transition-all hover:shadow-md flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-base font-semibold text-rose-200 group-hover:text-rose-100">
                      {phrase.ja}
                    </span>
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-slate-400 hover:text-white"
                      onClick={(e) => {
                        e.stopPropagation();
                        playTTS(phrase.ja, "ja-JP");
                      }}
                      title="Ouvir pronúncia"
                    >
                      <Volume2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                  <p className="text-xs text-slate-400 italic mb-2">{phrase.romaji}</p>
                </div>
                <div className="pt-2 border-t border-slate-800/80 text-xs text-indigo-300 font-medium">
                  {phrase.pt}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* HISTÓRICO DE CAPTURAS */}
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
              <Languages className="w-4 h-4 text-indigo-400" />
              Histórico de Falas Capturadas
            </h3>
            <span className="text-xs text-slate-400">{history.length} registro(s)</span>
          </div>

          {history.length === 0 ? (
            <p className="text-xs text-slate-500 py-4 text-center">Nenhuma fala registrada até o momento.</p>
          ) : (
            <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
              {history.map((item) => (
                <div
                  key={item.id}
                  className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/80 hover:border-slate-700/80 transition-colors flex flex-col md:flex-row items-start md:items-center justify-between gap-3 text-sm"
                >
                  <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-3 w-full">
                    <div>
                      <span className="text-[10px] uppercase font-bold tracking-wider text-rose-400 block mb-0.5">Japonês</span>
                      <p className="text-slate-200 font-medium">{item.japanese}</p>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase font-bold tracking-wider text-indigo-400 block mb-0.5">Português</span>
                      <p className="text-slate-300">{item.portuguese}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 self-end md:self-center shrink-0">
                    <span className="text-[11px] text-slate-500">{item.timestamp}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-slate-400 hover:text-white"
                      onClick={() => playTTS(item.japanese, "ja-JP")}
                      title="Ouvir em japonês"
                    >
                      <Volume2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800/80 bg-slate-950/80 py-4 text-center text-xs text-slate-500">
        <p>KotobaLive &bull; Transcrição e Tradução de Voz Japonês para Português &bull; Desenvolvido com Web Speech API</p>
      </footer>
    </div>
  );
}
