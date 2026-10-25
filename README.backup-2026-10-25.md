# Cifra Club → ChordPro

Aplicação web (Next.js) que busca uma música no [Cifra Club](https://www.cifraclub.com.br)
a partir do nome do artista e da música, extrai a letra com os acordes e monta um
arquivo [ChordPro](https://www.chordpro.org/) (`.cho`) pronto pra baixar.

## Como funciona

1. **Busca** (`lib/cifraclub.ts`): a partir do texto digitado (música, ou
   "artista música"), consulta a [Serper](https://serper.dev) (API de
   resultados reais do Google) restrita a `site:cifraclub.com.br` e valida
   cada resultado como página de música real, retornando os melhores para o
   usuário escolher — como uma busca do Google. (A busca interna do próprio
   Cifra Club foi descontinuada pelo site deles — hoje `/busca/` é uma SPA sem
   HTML estático pra raspar — por isso dependemos de uma API de busca externa.
   A Google Custom Search JSON API foi descartada por não aceitar mais
   clientes novos.)
2. **Scraping**: baixa o HTML da página encontrada e localiza o bloco `<pre>`
   que contém a cifra (acordes acima da letra), além de título, artista, tom e
   capotraste.
3. **Conversão** (`lib/chordpro.ts`): converte o formato "acordes acima da letra"
   para ChordPro, inserindo cada acorde como `[Acorde]` na posição correta da
   linha de letra logo abaixo (ou como uma linha `[C] [G] [Am]` quando o trecho
   é só instrumental).
4. A rota `app/api/chordpro/route.ts` expõe isso como `POST /api/chordpro`
   (`{ artist, song }` → `{ chordpro, title, artist, key, capo, sourceUrl }`),
   e `app/page.tsx` é a interface: formulário, preview do ChordPro e botão de
   download do `.cho`.

## Rodando localmente

Crie uma conta gratuita em https://serper.dev (sem cartão de crédito, 2.500
buscas grátis) e pegue a API key no dashboard. Coloque num `.env.local`:

```
SERPER_API_KEY=sua-key-aqui
```

```bash
npm install
npm run dev
```

Abra http://localhost:3000.

## Testes

A lógica de conversão para ChordPro tem testes unitários (sem depender de rede):

```bash
npm test
```

## Deploy na Vercel

O projeto já é um app Next.js padrão, então basta:

1. Importar o repositório em https://vercel.com/new
2. Framework preset: **Next.js** (detectado automaticamente)
3. Defina a variável de ambiente `SERPER_API_KEY` no projeto (Settings →
   Environment Variables) — sem ela a busca por nome retorna erro 500 (colar a
   URL direto continua funcionando sem ela).
4. Deploy.

## Limitações conhecidas

- O scraping depende da estrutura atual do HTML do Cifra Club; se o site mudar
  o layout, os seletores em `lib/cifraclub.ts` podem precisar de ajuste.
- A busca depende da Serper API; a camada gratuita (2.500 buscas) é um saldo
  único, não mensal — depois disso é preciso comprar mais créditos.
- Sem cache/rate limiting — evite fazer muitas requisições em sequência para
  não sobrecarregar o Cifra Club.

## Uso e direitos autorais

Letras e cifras pertencem aos respectivos autores e ao Cifra Club. Este projeto
é para uso pessoal/educacional (montar seus próprios arquivos ChordPro); não
redistribua o conteúdo extraído.
