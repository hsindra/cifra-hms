# CifraX (cifra-hms)

Aplicação web (Next.js) para buscar cifras no [Cifra Club](https://www.cifraclub.com.br),
convertê-las para [ChordPro](https://www.chordpro.org/) **em graus** (Nashville Number
System), salvar, editar e montar setlists. Produção: https://cifra-hms.vercel.app
(acesso com login).

## Funcionalidades

- **Busca** por nome da música (ou "artista música"), ou colando a URL de uma cifra do
  Cifra Club. Os resultados juntam músicas já salvas e cifras da internet, ordenados por
  quantas palavras da busca aparecem no título/artista (empate: a salva vem primeiro).
  A busca por nome sempre mostra a lista pra escolher; a URL colada abre direto.
- **Sugestões ao digitar** (typeahead) entre as músicas salvas — casam por palavra
  inteira; só a última palavra, ainda sendo digitada, pode casar pelo começo.
- **Cifras em graus**: toda música é salva em graus (`[1]`, `[6m]`, `[5/7]`...) com o tom
  de referência; na visualização dá pra ver em graus ou em qualquer tom concreto, e cada
  música guarda um tom preferido.
- **Importação do Cifra Club**:
  - tom lido da página; com capotraste, `Tom: F (com forma de E)` usa a forma (E);
  - sem tom na página, o tom é **deduzido pelos acordes** e a música ganha o comentário
    `{comment: <Tom X deduzido pelos acordes - o Cifra Club não informava o tom>}`;
  - seções viram tags com a sequência de acordes, ex. `{Primeira Parte}[ 1 | 6m | 4 ]`;
    `[Intro] A Em7 G D` e `Intro: D D Bm Bm` viram `{Intro}[ ... ]`;
  - reconhece notação brasileira/estendida de acordes (`7M`, `M7`, `7+`, `°`, `4`, `9`,
    `add9`, `(9)`, `(b5)`, baixo com `/`);
  - mantém as quebras de linha do Cifra Club.
- **Configurações** (menu ☰): converter tom menor no relativo maior ao importar;
  eliminar tablaturas ao importar; tamanho da fonte da letra, da cifra e das tags.
- **Visualização**: acordes sobre a letra; a linha só quebra entre palavras quando
  estoura a largura da tela; tags coloridas (refrão, pré-refrão, ponte); anotações entre
  `<...>` em estilo discreto; tag + progressão `{Verso}[ 1 | 4 ]` vira um badge só.
- **Editor de código ChordPro** (`</>`), com atalhos (em cima e embaixo do editor):
  - `%` insere `[%]` (repete o acorde anterior);
  - **V / Pr / R / P** inserem `{Verso}`, `{Pré-refrão}`, `{Refrão}`, `{Ponte}` no cursor;
  - **juntar linhas**: junta as linhas de cada seção numa só (quebra pela largura da tela);
  - **acordes nas tags**: monta/atualiza `{Tag}[ ... ]` com os acordes da primeira estrofe
    da seção (até linha em branco ou próxima tag), ignorando `[%]` e acordes com `.`, no
    máximo 4 acordes; tags com letra na mesma linha ou seções sem acordes ficam como estão;
  - **desfazer** em vários níveis (até 100; digitação seguida conta como um passo).
- **Minhas músicas**: lista das salvas, ordenada por último acesso por padrão (botão Ordenar).
- **Setlists**: lista nomeada de músicas salvas, lidas em rolagem contínua; reordenar,
  toque duplo pula para a próxima música, botão "topo", alternar graus por música.

## Como funciona a busca na internet

1. **Candidatos** (`lib/cifraclub.ts`): a [Serper](https://serper.dev) (resultados do
   Google) é consultada com `site:cifraclub.com.br`, e os links de música viram candidatos.
2. **Download da página**: o Cifra Club bloqueia (HTTP 403) acessos vindos de servidores
   de nuvem, incluindo a Vercel em qualquer região. Por isso:
   1. acesso direto (após um 403, é pulado por 15 min);
   2. **[ScraperAPI](https://www.scraperapi.com)** (`SCRAPERAPI_KEY`): devolve o HTML
      original — tom real e acordes alinhados. Só os 4 melhores candidatos (1 crédito cada);
   3. plano B: **raspagem da Serper** (`scrape.serper.dev`), que devolve markdown sem o
      tom e sem os espaços antes do primeiro acorde da linha — o tom é deduzido.
3. **Leitura** (`parseCifraHtml`): a cifra fica no `<pre>` da página (no site novo, em
   Next.js, cada linha é um `<div>` com um espaço de largura zero, que é removido); título,
   artista, tom e capotraste vêm do resto da página.
4. Quando a primeira cifra chega, a busca espera no máximo mais 3 s pelas outras.
5. **Conversão** (`lib/chordpro.ts`): "acordes acima da letra" → ChordPro, depois para
   graus (`lib/transpose.ts`).

Erros de acesso mostram o motivo de cada etapa (ex.: resposta do ScraperAPI e da Serper).

### Diagnóstico

`GET /api/debug/cifra?url=<página do Cifra Club>` (exige login) mostra o que o acesso
direto, o ScraperAPI e a raspagem da Serper devolvem para uma página, e onde estão letra,
tom e acordes quando a leitura falha — útil quando o Cifra Club muda o site. Cada chamada
gasta créditos do ScraperAPI e da Serper.

## Estrutura

- `app/HomeShell.tsx` — interface (busca, visualização, editor, músicas, setlists, menu).
- `app/ChordProView.tsx` — renderização da cifra.
- `app/api/search` — busca (salvas + internet) e importação por URL.
- `app/api/songs`, `app/api/setlists`, `app/api/settings` — dados salvos.
- `app/api/auth/*`, `app/login`, `middleware.ts` — login (todas as rotas exigem sessão).
- `lib/cifraclub.ts` — busca, download e leitura das páginas do Cifra Club.
- `lib/chordpro.ts` — conversão para ChordPro, tags, junção de linhas.
- `lib/transpose.ts` — graus ↔ acordes, dedução de tom.
- `lib/fuzzyMatch.ts` — pontuação de busca por palavras.
- `lib/store.ts` — persistência no Upstash Redis (Vercel KV).
- `scripts/` — migrações e importação do Notion.

## Variáveis de ambiente

| Variável | Para quê |
|---|---|
| `SERPER_API_KEY` | busca de candidatos e raspagem de reserva |
| `SCRAPERAPI_KEY` | baixar o HTML original do Cifra Club (opcional, recomendado) |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | banco (Upstash Redis / Vercel KV) |
| `AUTH_USERNAME` | usuário do login |
| `AUTH_PASSWORD_HASH` | hash da senha (`hashPassword` de `lib/auth.ts`, formato `salt:hash`) |
| `AUTH_SESSION_SECRET` | assinatura do cookie de sessão |

Localmente, coloque-as em `.env.local` (git-ignorado). Na Vercel, em Settings →
Environment Variables, e faça um Redeploy depois de mudar.

## Rodando localmente

```bash
npm install
npm run dev
```

Abra http://localhost:3000.

## Testes

```bash
npm test
```

Testes unitários (sem rede) de conversão ChordPro, graus/transposição, dedução de tom e
pontuação de busca.

## Deploy

O repositório tem integração GitHub ↔ Vercel: todo push em `master` faz o deploy de
produção do projeto `cifra-hms` (time `haendels-projects`). Ver `CLAUDE.md` para as regras
de operações manuais na Vercel.

## Limitações conhecidas

- A leitura depende do HTML do Cifra Club; se o site mudar, ajuste `parseCifraHtml` em
  `lib/cifraclub.ts` (use a rota de diagnóstico).
- Sem o ScraperAPI (sem chave ou sem créditos), as cifras vêm pela raspagem da Serper:
  tom deduzido e o primeiro acorde de algumas linhas fora do lugar.
- A dedução de tom escolhe só tons maiores e pode errar em músicas com muitos acordes
  emprestados; pot-pourris com troca de tom ficam todos relativos a um tom só.
- Créditos: Serper (saldo pré-pago) e ScraperAPI (plano gratuito com cota mensal).

## Uso e direitos autorais

Letras e cifras pertencem aos respectivos autores e ao Cifra Club. Projeto para uso
pessoal/educacional; não redistribua o conteúdo extraído.
