# KotobaLive - Captura de Voz em Japonês e Tradução em Tempo Real

Aplicação web moderna projetada para capturar áudio em japonês e fornecer a tradução imediata em português com interface comparativa lado a lado.

## Funcionalidades Principais

- **Painel Comparativo Lado a Lado**:
  - **Lado Esquerdo**: Transcrição do áudio capturado em Japonês (`ja-JP`), com indicador de gravação ativa e contagem de caracteres.
  - **Lado Direito**: Tradução instantânea para Português (`pt-BR`).
- **Captura de Voz via Microfone**:
  - Utilização da Web Speech API nativa do navegador (`webkitSpeechRecognition` / `SpeechRecognition`) com suporte ao idioma japonês.
  - Suporte a resultados parciais (interim) e finais em tempo real.
- **Simulador de Áudio e Expressões**:
  - Frases prontas em japonês com romanização (Romaji) e tradução para testes imediatos sem necessidade de microfone.
- **Síntese de Voz (TTS)**:
  - Botão para ouvir a pronúncia em japonês ou a tradução em português.
- **Histórico e Exportação**:
  - Registro cronológico de falas recentes.
  - Botão de cópia rápida para a área de transferência e limpeza geral de tela.

## Como Executar

A aplicação está disponível e rodando na porta `3000` via Vite:

- **Endereço Local**: `http://localhost:3000/`
- **Endereço Web**: `https://3000-irkcqljxked7gb462o6d1-2541f854.us1.manus.computer`
