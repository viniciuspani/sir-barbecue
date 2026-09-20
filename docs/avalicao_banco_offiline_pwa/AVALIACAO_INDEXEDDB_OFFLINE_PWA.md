# Avaliação de arquitetura e segurança — banco offline (IndexedDB) no PWA

**Projeto:** Sir Barbecue — PWA (`c:\develop\WEB\sir-barbecue-web`)
**Data:** 19/09/2026
**Natureza:** avaliação de arquitetura e segurança. **Nenhum código foi escrito.**

---

## 1. Veredito

**VIÁVEL COM CONDIÇÕES.** É possível implantar um banco local no PWA para operar sem internet
sem abrir brecha relevante de ataque — mas o ganho de segurança não vem da tecnologia escolhida,
e sim de **o que se guarda** e de **quem valida**.

Três afirmações sustentam esse veredito:

1. **O risco principal não é o "hacker externo".** É o operador com o aparelho na mão e o DevTools
   aberto. Nenhum armazenamento de navegador protege contra ele — nem IndexedDB, nem OPFS, nem
   Cache Storage. Quem protege é o servidor.
2. **O servidor já protege.** A RPC `create_sale` (MIGRATION_12, preservada na MIGRATION_27)
   confere o preço contra o cadastro, exige assinatura ativa via `tenant_has_access`
   (MIGRATION_11), é idempotente por `client_id` e derruba a transação inteira em oversell
   (`CHECK quantity >= 0`). Uma fila offline que drene por essa RPC **herda todas essas guardas**.
3. **O que precisa de decisão não é segurança — é operação.** Venda feita offline pode ser
   *legitimamente recusada* na hora de subir (preço mudou, estoque acabou). Dinheiro já está no
   caixa. Esse é o problema difícil deste projeto, e ele é de negócio, não de criptografia.

> **Condição inegociável:** o banco local é **cache descartável + fila de intenções**.
> No instante em que ele virar fonte de verdade para preço, saldo, papel do usuário ou
> licença, o desenho passa a ser inseguro — e nenhuma cifra conserta isso.

---

## 2. Escopo confirmado com o dono

| Item | Definição |
|---|---|
| **Comandas** | **Fora do escopo.** Offline cobre apenas venda rápida (carrinho). |
| **Janela offline** | **Máximo 4 horas.** Passado o teto, o app se recusa a operar. |
| **Quem opera** | **Qualquer perfil** — `owner`, `manager` ou `employee`. |
| **Prioridade** | O PWA continua **online-first**. Offline é contingência de queda de rede. |

A exclusão das comandas é a decisão de maior valor deste escopo. Comanda tem estado compartilhado
entre aparelhos, Realtime, reserva de estoque e snapshot de preço; resolver conflito de comanda
offline exigiria uma máquina de merge que hoje não existe em lugar nenhum do produto. Venda rápida
é um evento pontual e idempotente — cabe numa fila.

---

## 3. Situação atual (levantada no código)

### 3.1 O que já está certo e não deve ser mexido

| Controle | Onde | Observação |
|---|---|---|
| Preço não é ditado pelo cliente | `MIGRATION_12_create_sale_guards.sql:77-109` | Confere contra `products.price` (tolerância R$ 0,01). Fecha o ataque "employee vende a R$ 0,01". |
| Guarda de assinatura na escrita | `MIGRATION_11_tenant_has_access.sql` | Policies de escrita exigem `tenant_has_access`. O kill switch do dono desliga de verdade. |
| Idempotência | `MIGRATION_12:65-70` | `client_id` já gravado → retorna sem duplicar. **É a peça que torna uma fila offline segura.** |
| Oversell barrado no servidor | `MIGRATION_12:124-133` | `deduct_stock_on_sale` + `CHECK quantity >= 0` derrubam a transação. |
| Trilha de auditoria append-only | `MIGRATION_14_audit_log.sql` | Sem policy de INSERT/UPDATE/DELETE para o cliente. Nem o owner adultera. |
| CSP restritiva | `netlify.toml:45` | `script-src 'self'`, sem `unsafe-inline` em script, `frame-ancestors 'none'`, `object-src 'none'`. |
| Nenhuma resposta do Supabase em cache | `vite.config.ts` (`runtimeCaching: []`) | Decisão correta: dado de PDV velho é pior que erro de rede. |
| Gate de acesso fail-closed | `src/core/rules/access.ts:86-95` | Sem resposta do servidor → `unverified` → bloqueado. |
| Cache de vínculo escopado por usuário | `src/core/services/membership.ts:12` | `membership.<userId>` — não vaza entre contas no mesmo navegador. |

### 3.2 O que hoje impede o offline

- Não existe banco local: a venda vai direta à RPC (`src/data/repositories/sales.ts:51-68`).
- `src/core/rules/access.ts:6-13` **recusa deliberadamente** cachear o veredito de assinatura.
  Sem mudança aqui, o app bloqueia a tela inteira assim que perde a rede — o offline não
  chega nem a começar.
- `src/data/connectivity.ts` já detecta online/offline via `navigator.onLine` + eventos.
- O log de erro do web não tem fila (`src/data/services/errorLog.ts:14-16`) — some quando offline.

---

## 4. Modelo de ameaça

Com "qualquer perfil opera o aparelho", o ator relevante muda de figura.

### A1 — Operador interno com DevTools (**ameaça principal**)

Funcionário abre o DevTools no Chrome/Safari do aparelho e edita o banco local.
Tentativas possíveis:

| Tentativa | Resultado com o desenho recomendado |
|---|---|
| Baixar `unit_price` para R$ 0,01 na fila | **Bloqueado no servidor** — `create_sale` recusa: "preço divergente do cadastro". |
| Apagar uma venda da fila antes de subir (furto de caixa) | **Não detectável pelo servidor.** Mitigação é operacional: contador visível de pendentes + conferência de caixa. Ver §7.3. |
| Inflar o saldo de estoque no cache para vender o que não existe | **Bloqueado** — `CHECK quantity >= 0` derruba a transação no drain. |
| Editar o papel cacheado de `employee` para `owner` | **Bloqueado** — RLS usa `tenant_members` do servidor, não o cache (`membership.ts:9-11`). |
| Estender o veredito de assinatura para operar de graça | **Depende da §7.2.** É o ponto onde o desenho pode ser arruinado. |
| Forjar `client_id` repetido para "reusar" uma venda | Idempotência devolve a venda existente. Sem efeito. |

### A2 — XSS (impacto agravado pelo offline)

Hoje um XSS rouba a sessão. Com banco local, ele passa a **plantar ou apagar registros na fila**
e a ler dados de negócio em repouso. A CSP atual é a defesa real e está bem construída;
`style-src 'unsafe-inline'` (necessário pelo Tailwind) é aceitável, porque não permite execução
de script. **Com IndexedDB em produção, a CSP deixa de ser higiene e passa a ser controle crítico.**

### A3 — Aparelho perdido, roubado ou compartilhado

Trailer de rua, aparelho que passa de mão em mão. O risco é dado de negócio em repouso
(catálogo, preços, custo, vendas do dia) legível por quem pegar o aparelho destravado.
Atenuação: guardar o mínimo, cifrar, e expurgar no logout/troca de usuário.

### A4 — Multiusuário no mesmo navegador

Dono e funcionário usam o mesmo aparelho. Sem escopo de chave, o dado de um vaza para a
sessão do outro — e pior, um cache do dono poderia ser adotado por um funcionário.
O projeto já resolveu isso no `localStorage` (escopo por `userId`); a mesma regra vale aqui,
com escopo por `userId` **e** `tenantId`.

### A5 — Atacante externo pela rede

**Sem mudança relevante.** O IndexedDB é `same-origin`, não é exposto pela rede, e a origem
é HTTPS com HSTS `preload`. O offline não amplia essa superfície.

---

## 5. Por que IndexedDB, e o que seria "mais seguro"

Pergunta do dono: *existe opção mais segura no lugar do IndexedDB?*

**Não.** Todo armazenamento local do navegador é legível e editável por quem opera o aparelho —
não existe Keychain/Keystore no web. A comparação real:

| Opção | Contra o operador com DevTools | Veredito |
|---|---|---|
| `localStorage` | Idêntico. Ainda é síncrono, ~5 MB, só string | Pior, não melhor |
| Cache Storage (SW) | Idêntico. Feito para resposta HTTP, não para fila transacional | Errado para o caso |
| OPFS | Menos visível no DevTools, mas qualquer script da origem lê — obscuridade, não segurança. Suporte irregular no Safari do iPhone, que é o alvo | Não |
| Cookie `httpOnly` | Único que o JS não lê — mas só o **servidor** escreve, e offline não há servidor. 4 KB | Inútil aqui |
| Só memória (sem persistir) | Seguro de verdade | **Falha o requisito**: o iOS descarta a aba do PWA em segundo plano e a venda evapora |
| **IndexedDB cifrado (recomendado)** | Bloqueia leitura e adulteração manual | **Melhor relação** |

### 5.1 A cifra que vale a pena

Chave AES-GCM gerada com **`extractable: false`** e guardada como objeto `CryptoKey` dentro do
próprio IndexedDB:

- O DevTools mostra um objeto opaco — **as bytes da chave não são recuperáveis**, nem por script.
- Os registros ficam ilegíveis e não editáveis à mão.
- **Elimina o ataque realista do cenário A1** (funcionário mexendo no banco entre atendimentos)
  e mitiga A3 (aparelho perdido).

Limites que precisam ser ditos com todas as letras:

- **Não protege contra XSS.** Script rodando na origem chama `decrypt` normalmente. Por isso a CSP
  continua sendo a primeira linha.
- **Não substitui a validação do servidor.** É defesa em profundidade, não autoridade.
- `crypto.subtle` **só existe em contexto seguro** (HTTPS/localhost) — a mesma armadilha já
  documentada em `src/lib/uuid.ts`. Testar pelo IP da rede em HTTP quebra tudo; precisa de
  degradação explícita em desenvolvimento.
- Guardar `CryptoKey` no IndexedDB funciona nos navegadores modernos, **mas precisa ser verificado
  na versão do Safari do iPhone alvo** antes de virar dependência.

---

## 6. Arquitetura recomendada

### 6.1 A regra de ouro

```
IndexedDB = cache de LEITURA descartável  +  fila de INTENÇÕES idempotente
                     (nunca fonte de verdade)
```

### 6.2 O que pode e o que não pode ser guardado

**PODE (cache de leitura, cifrado, com validade curta):**
- Catálogo: produtos ativos, nome, preço, categoria, dias de visibilidade.
- Saldo de estoque **como último valor conhecido**, sempre exibido com marca de "desatualizado".
- Nome da empresa, papel do usuário — **apenas para desenhar a tela**, nunca para autorizar.

**PODE (fila de escrita, cifrada):**
- Vendas pendentes: `client_id` (UUID v4 já gerado por `src/lib/uuid.ts`), itens, forma de
  pagamento, modo de consumo, carimbo de tempo local **e** âncora de tempo do servidor (§7.1).
- Fila de `error_logs` — fecha o buraco do `errorLog.ts:14-16` de graça.

**NÃO PODE, em hipótese alguma:**
- Veredito de assinatura em forma que conceda acesso (ver §7.2 para a única forma segura).
- Token/refresh token movido para cá. **Fica onde está**, no `localStorage` do Supabase:
  mover não protege nada (o cliente precisa usá-lo de qualquer jeito) e arrisca quebrar
  `detectSessionInUrl` e o refresh automático.
- Comandas (fora do escopo — e com bom motivo).
- Histórico de vendas antigas, dados de fornecedor/custo, relatórios.
- Qualquer dado de outro tenant.

### 6.3 Escopo, ciclo de vida e expurgo

- Nome do banco ou das chaves escopado por **`userId` + `tenantId`**.
- **No logout, troca de usuário ou troca de empresa: apagar tudo**, exceto a fila pendente do
  próprio usuário — que deve ser drenada *antes* de permitir o logout (o mobile já faz isso:
  `countPending()` recusa ações com pendência).
- Vínculo perdido (funcionário órfão, empresa excluída): **expurgo total**.
- Cache de leitura com TTL de 4h; expirado, é apagado e não alimenta mais a tela.
- `navigator.storage.persist()` para reduzir despejo — e aceitar que o iOS pode despejar mesmo
  assim. A fila **não pode** ser o único registro de algo com valor financeiro por muito tempo:
  é exatamente por isso que a janela é de 4h.

### 6.4 Drenagem

1. Voltou a rede → drenar **em série**, na ordem de criação, uma venda por vez.
2. Cada item vai pela RPC `create_sale` — **nunca por insert solto**. Insert solto pula a guarda
   de preço e a de assinatura, e reintroduz o problema histórico de oversell.
3. Sucesso ou "já existe" (idempotência) → remove da fila.
4. Falha **de rede** → mantém na fila, tenta de novo com backoff.
5. Falha **de regra** (preço divergente, estoque insuficiente, assinatura vencida) → **não
   descartar em silêncio**: mover para uma lista de "vendas recusadas" visível na tela, com o
   motivo em português, e registrar em `error_logs`. Ver §8.1.

---

## 7. Os três pontos onde este desenho pode dar errado

### 7.1 O relógio do aparelho não é confiável

A janela de 4h medida com `Date.now()` é contornável: basta o operador atrasar o relógio do
telefone. Portanto:

> **A janela de 4h é uma trava de UX, não um controle de segurança.**

Como torná-la real:
- Guardar, a cada resposta do servidor, uma **âncora de tempo** (hora do servidor + valor de
  `performance.now()` no momento). O tempo decorrido offline é medido pelo relógio monotônico,
  que não é afetado por mudança de fuso ou de hora.
- O controle *de verdade* fica no servidor: a RPC recebe o instante de criação e **recusa (ou
  marca) venda cuja idade exceda o teto**, comparando com `now()` do Postgres. Ver §8.2.

### 7.2 O gate de assinatura é o ponto mais delicado do projeto

Hoje `access.ts` nega sem resposta do servidor — e essa decisão está **documentada como
deliberada**, justamente para não abrir bypass. Qualquer cache ingênuo do veredito transforma
"sem internet" em "licença vitalícia": basta desligar o Wi-Fi.

**Recomendação:** conceder carência offline **de no máximo 4h**, atrelada à mesma âncora de tempo
monotônica da §7.1, e **apenas quando o último veredito conhecido era `allowed`**. Nunca conceder
a partir de `unverified`. Três salvaguardas:

1. A carência **só libera a fila** — não libera tela de empresa, relatórios, exportação nem
   qualquer escrita que não seja venda.
2. O veredito cacheado entra no registro **cifrado** (§5.1), o que impede a edição manual trivial.
3. A palavra final continua sendo do servidor: se a assinatura venceu durante o offline, a RLS
   e `tenant_has_access` recusam o drain. A carência concede *coleta*, nunca *validade*.

Isso é uma **flexibilização consciente** de uma decisão de segurança existente. Está registrada
aqui para que ninguém a encontre depois achando que foi descuido. Observação: o app Android já faz
o equivalente com 72h de graça — o web pedir 4h é postura mais conservadora que a do mobile.

### 7.3 A venda que o operador apaga antes de subir

Nenhum controle técnico no navegador resolve: quem controla o aparelho controla a fila.
As mitigações são de processo e visibilidade:
- Contador de pendentes **sempre visível** enquanto houver fila (o operador sabe que alguém sabe).
- Ao voltar a rede, notificar o resultado do drain.
- `audit_log` já registra o que sobe; a conferência de caixa × faturamento é o controle real.

---

## 8. Mudanças necessárias no servidor

### 8.1 Motivo de recusa legível (obrigatório)

`create_sale` hoje levanta exceções com mensagens em texto ("preço divergente do cadastro do
produto"). Para o drain, o app precisa **distinguir** recusa por preço, por estoque e por
assinatura, para dizer ao operador o que fazer. Recomenda-se códigos de erro estáveis
(`SQLSTATE` próprio ou prefixo padronizado) em vez de casar string em português — casar string
quebra na primeira revisão de texto.

### 8.2 Idade da venda offline (recomendado)

Novo parâmetro opcional `p_created_offline_at`. O servidor:
- recusa se `now() - p_created_offline_at` exceder o teto acordado (sugestão: 6h, com folga sobre
  as 4h do app, para não punir o drain lento);
- registra em `audit_log` toda venda que chegou com atraso relevante.

Isso transfere a janela de 4h do navegador (não confiável) para o Postgres (confiável).

### 8.3 Política de preço divergente (decisão do dono — ver §10)

Hoje o drain de uma venda feita antes de uma mudança de preço **falha**. O caminho do Android
não tem esse problema porque não passa pela RPC — e o preço vindo do aparelho é aceito, com
divergência registrada pela `MIGRATION_14` (registra, não bloqueia). O web precisa de uma regra
explícita. Três opções em §10.

### 8.4 O que **não** mudar

- Não afrouxar a guarda de preço para "qualquer valor" em nome do offline. Seria desfazer a
  correção do A06-02 pela porta dos fundos.
- Não dar ao PWA o caminho de insert solto que o mobile usa. É o caminho não validado.

---

## 9. Riscos operacionais (não são de segurança, mas decidem o sucesso)

| Risco | Consequência | Mitigação |
|---|---|---|
| Preço mudou durante o offline | Venda recusada no drain, dinheiro no caixa | §10, decisão 1 |
| Estoque acabou durante o offline | Venda recusada no drain | Bloquear venda offline de item com saldo cacheado ≤ 0; aceitar o resto como risco residual |
| Assinatura venceu durante o offline | Fila inteira travada | Carência de 48h do servidor já ajuda; avisar antes de vencer |
| iOS despeja o storage | Fila perdida | `persist()` + janela curta + contador visível |
| Aparelho ficou offline > 4h | App se recusa a vender | É o comportamento desejado. Precisa de mensagem clara, não de erro genérico |
| Sessão expira offline | O `access_token` do Supabase dura ~1h e o refresh exige rede | **Testar explicitamente**: o app deve continuar utilizável offline com token expirado e renovar no retorno da rede, sem deslogar o operador |

---

## 10. Decisões pendentes do dono

**Decisão 1 — venda offline cujo preço mudou.** (bloqueia a implementação)
- (a) **Recusar** e exigir refazer a venda. Mais seguro, pior no balcão.
- (b) **Aceitar o preço do momento da venda** e registrar divergência no `audit_log` — é o
  tratamento que o app Android já recebe hoje pela MIGRATION_14. Coerente entre plataformas.
- (c) Aceitar dentro de uma janela (ex.: preço vigente nas últimas 4h), recusar fora dela.
  Mais justo, mais caro de implementar (exige histórico de preço do produto).

*Recomendação: (b)* — alinha as duas plataformas e evita que o operador perca a venda.

**Decisão 2 — carência do gate de assinatura offline.** Confirmar as 4h da §7.2, ou reduzir.

**Decisão 3 — comportamento ao estourar as 4h.** App volta a ser somente-leitura (consulta o
catálogo, não vende) ou bloqueia a tela inteira?

---

## 11. Plano sugerido, por fases

| Fase | Entrega | Por que nesta ordem |
|---|---|---|
| **F1** | Camada de armazenamento cifrado (AES-GCM, chave não-extraível, escopo `userId`+`tenantId`, expurgo no logout) + fila de `error_logs` | Valida a base em algo de baixo risco financeiro. Se o `CryptoKey` no IndexedDB falhar no Safari alvo, falha aqui e barato |
| **F2** | Cache de leitura do catálogo/estoque com TTL de 4h e marca de "desatualizado" na tela | O app passa a *abrir e mostrar* offline, sem ainda escrever nada |
| **F3** | Mudanças no servidor: códigos de erro estáveis (§8.1), `p_created_offline_at` (§8.2), política da Decisão 1 | O servidor precisa estar pronto **antes** de existir fila, nunca depois |
| **F4** | Fila de vendas + drenagem em série + tela de recusadas + contador de pendentes | O núcleo |
| **F5** | Carência de 4h do gate de assinatura com âncora de tempo monotônica | Deliberadamente por último: é a mudança mais sensível |
| **F6** | Roteiro de teste adversarial (§12) | Só vale como pronto depois de passar |

---

## 12. Critérios de aceite — testes adversariais obrigatórios

Nenhuma fase é "pronta" sem estes testes, executados **no aparelho real**, com DevTools:

1. Editar o preço de um item na fila → o drain **recusa** e a venda aparece na lista de recusadas
   com motivo legível.
2. Inflar o saldo de estoque no cache e vender além do disponível → o drain **recusa**.
3. Trocar o papel cacheado para `owner` → nenhuma tela ou escrita nova é liberada.
4. Adulterar o veredito de assinatura cacheado → o registro cifrado não é editável; e o drain
   com assinatura vencida **falha** de qualquer forma.
5. Atrasar o relógio do aparelho em 10h → a janela de 4h **não** se estende (relógio monotônico),
   e o servidor recusa pela idade.
6. Logar com o usuário A, sair, logar com o usuário B → **nenhum** dado de A permanece acessível.
7. Ficar 4h offline → o app entra no estado decidido na Decisão 3, com mensagem clara.
8. Ficar offline por mais de 1h e voltar → o operador **não** é deslogado e a fila drena.
9. Fechar e reabrir o PWA instalado no iPhone com fila pendente → a fila sobrevive.
10. Rodar `curl -sI` na origem publicada → CSP e HSTS continuam íntegros após o deploy.

---

## 13. Conclusão

A pergunta do dono era se dá para colocar um banco offline no PWA sem abrir brecha. A resposta é
**sim**, e o motivo é que o trabalho difícil já foi feito: o servidor não confia no cliente.
`create_sale` valida preço, assinatura, tenant e estoque, e é idempotente. Uma fila offline que
drene por essa porta não cria caminho novo de ataque — ela cria um **atraso** entre a intenção e
a validação.

O que esse atraso traz de novo não é vulnerabilidade, é **ambiguidade operacional**: uma venda que
o sistema pode legitimamente recusar depois de o dinheiro já ter entrado. É aí que está o risco
real do projeto, e é por isso que a Decisão 1 (§10) precisa ser tomada antes da primeira linha
de código.

Sobre a tecnologia: não existe alternativa "mais segura" ao IndexedDB no navegador. Existe
**usar o IndexedDB de forma mais segura** — guardando o mínimo, cifrando com chave não-extraível,
escopando por usuário e empresa, expurgando cedo, e mantendo o servidor como única autoridade.
