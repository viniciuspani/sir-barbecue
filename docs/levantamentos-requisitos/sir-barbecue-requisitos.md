# Sir Barbecue — Plano de Requisitos

> Gerado em: 2026-06-05 | Atualizado em: 2026-06-06
> Fonte: Levantamento de requisitos app para trailer de churrasquinho.docx
> Questões em aberto: resolvidas em 2026-06-06

---

## 📋 Visão Geral do Projeto

- **Nome**: Sir Barbecue — Sistema de Gestão para Churrasquinho
- **Propósito**: Aplicativo mobile para gestão completa de um trailer de churrasquinho, cobrindo o ciclo operacional do negócio: autenticação do proprietário, registro de vendas com múltiplos produtos e formas de pagamento, cadastro e precificação de produtos, controle de estoque (entradas, saídas e alertas), gestão de fornecedores com preço de compra, e geração de relatórios financeiros e gerenciais. O objetivo é profissionalizar a operação, oferecendo controle gerencial, financeiro e operacional ao proprietário em tempo real via smartphone — inclusive em situações de ausência de sinal móvel.
- **Usuários-alvo**:
  - **Proprietária/Administrador** — usuário único em v1; perfil não técnico; uma das usuárias possui deficiência visual parcial (enxerga apenas com um olho); acessa via app mobile para gerenciar todo o negócio
- **Plataforma**: App Mobile (iOS e Android)
- **Contexto de Domínio**: Pequeno negócio alimentício (churrasquinho de rua); presença futura no Instagram (sem integração técnica prevista); sujeito à LGPD; operação em rede móvel 4G/5G com possibilidade de ausência de sinal

---

## ✅ Requisitos Funcionais

---

### Autenticação

**RF-01 — Autenticação: Cadastro via E-mail e Senha**
> O sistema deve permitir que o usuário crie uma conta utilizando e-mail e senha.
> - O e-mail deve ser verificado antes de liberar o acesso
> - A senha deve ter no mínimo 8 caracteres
> - O usuário pode recuperar a senha via link enviado ao e-mail cadastrado
> - Prioridade: **Crítica**

---

**RF-02 — Autenticação: Login Social com Google**
> O sistema deve permitir que o usuário faça login utilizando sua conta Google (OAuth 2.0).
> - O login com Google não requer criação de senha separada
> - Na primeira autenticação via Google, uma conta é criada automaticamente
> - Prioridade: **Crítica**

---

### Cadastro de Produtos

**RF-03 — Cadastro de Produtos: Registro e Precificação**
> O sistema deve permitir cadastrar todos os produtos vendidos pelo churrasquinho, com nome, descrição, preço de venda e categoria. Os produtos inicialmente suportados são: churrasquinho de carne, frango, coração, medalhão de boi, medalhão de frango, medalhão misto (carne e frango), misto (carne, frango e linguiça), refrigerantes, cervejas, lanche (pão com carne) e feijão tropeiro.
> - O usuário pode criar, editar e inativar qualquer produto
> - O preço de venda é editável a qualquer momento
> - Produtos inativados não aparecem na tela de vendas
> - Prioridade: **Crítica**

---

**RF-04 — Cadastro de Produtos: Tela de Cadastro por Categoria**
> O cadastro de produtos deve ser organizado por categoria, cada uma com sua própria tela. Dentro de cada tela, o usuário gerencia todos os produtos daquele grupo (criar, editar, inativar, configurar preço e dias de visibilidade). As categorias são:
> - **Churrasquinho** → carne, frango, coração, medalhão de boi, medalhão de frango, medalhão misto (carne e frango), misto (carne, frango e linguiça)
> - **Bebidas** → refrigerantes e cervejas
> - **Lanches** → lanche (pão com carne)
> - **Especiais** → feijão tropeiro (e demais produtos que não se encaixem nas categorias acima)
> - O usuário navega entre as categorias por uma lista ou menu de seleção
> - Novos produtos são sempre criados dentro de uma categoria existente
> - Prioridade: **Alta**

---

**RF-05 — Cadastro de Produtos: Visibilidade Configurável por Dia da Semana**
> O sistema deve permitir configurar em quais dias da semana cada produto fica visível na tela de vendas. Por padrão, o feijão tropeiro é exibido apenas às sextas-feiras; os demais produtos ficam visíveis todos os dias.
> - O usuário pode habilitar ou desabilitar a visibilidade de qualquer produto para qualquer dia da semana individualmente
> - Produtos configurados como ocultos para o dia atual não aparecem na tela de vendas
> - A configuração padrão do feijão tropeiro é: visível apenas às sextas-feiras
> - O usuário pode alterar essa configuração livremente (ex.: exibir o feijão tropeiro em outros dias se desejar)
> - Prioridade: **Alta**

---

### Cadastro de Fornecedores

**RF-06 — Cadastro de Fornecedores: Registro de Fornecedor**
> O sistema deve permitir cadastrar fornecedores com as seguintes informações: nome do estabelecimento, endereço, nome do responsável e contato de telefone.
> - Todos os campos são editáveis após o cadastro
> - O usuário pode listar, criar, editar e excluir fornecedores
> - Prioridade: **Alta**

---

**RF-07 — Cadastro de Fornecedores: Associação Produto-Fornecedor com Preço de Compra**
> Cada fornecedor deve ser associado aos produtos que fornece, com o preço de compra de cada produto registrado.
> - Um fornecedor pode estar associado a múltiplos produtos
> - O preço de compra é editável por produto/fornecedor
> - O preço de compra alimenta os cálculos de custo e margem nos relatórios e no estoque
> - Prioridade: **Alta**

---

### Estoque

**RF-08 — Estoque: Tela de Gestão de Estoque**
> O sistema deve disponibilizar uma tela dedicada ao controle de estoque, exibindo a quantidade atual de cada produto em estoque.
> - A tela lista todos os produtos com seus respectivos saldos em estoque
> - O saldo é atualizado em tempo real conforme entradas e vendas são registradas
> - Prioridade: **Alta**

---

**RF-09 — Estoque: Registro de Entrada de Estoque**
> O sistema deve permitir registrar a entrada de produtos no estoque quando o proprietário realiza uma compra de fornecedor.
> - O usuário informa o produto, a quantidade adquirida e o fornecedor da compra
> - O saldo do produto em estoque é incrementado pelo valor informado
> - O histórico de entradas fica acessível para consulta
> - Prioridade: **Alta**

---

**RF-10 — Estoque: Dedução Automática por Venda**
> A cada venda registrada, o sistema deve subtrair automaticamente do estoque a quantidade vendida de cada produto.
> - A dedução ocorre no momento do registro da venda
> - Se o saldo de um produto estiver zerado, o sistema exibe alerta ao tentar incluí-lo em uma venda
> - Prioridade: **Alta**

---

**RF-11 — Estoque: Configuração de Alerta de Estoque Baixo**
> O sistema deve disponibilizar uma tela de configuração onde o proprietário define, para cada produto, a quantidade mínima em estoque que dispara uma notificação de alerta.
> - O usuário configura o limite mínimo individualmente para cada produto
> - Quando o saldo de um produto atingir ou ficar abaixo do limite configurado, o app notifica o proprietário via notificação push
> - A tela de configuração lista todos os produtos com seus limites definidos e saldos atuais para facilitar a gestão
> - Produtos com estoque em nível de alerta são destacados visualmente na tela de gestão de estoque
> - Prioridade: **Alta**

---

### Vendas

**RF-12 — Vendas: Registro de Venda com Múltiplos Produtos**
> O sistema deve permitir registrar uma venda contendo um ou mais produtos, com quantidade de cada item.
> - A venda pode incluir qualquer combinação de produtos disponíveis e visíveis no dia
> - O valor total da venda é calculado automaticamente
> - A venda é vinculada à data e hora do registro
> - Vendas registradas offline são armazenadas localmente e sincronizadas ao recuperar conexão
> - Prioridade: **Crítica**

---

**RF-13 — Vendas: Modalidade de Consumo**
> Cada venda deve registrar se o cliente irá consumir no local ou levar os produtos (take-away).
> - O usuário seleciona a modalidade no momento do registro da venda
> - A informação de modalidade é exibida nos relatórios
> - Prioridade: **Média**

---

**RF-14 — Vendas: Formas de Pagamento**
> O sistema deve registrar a forma de pagamento utilizada na venda: dinheiro, PIX, cartão de crédito ou cartão de débito. Não há integração com terminal físico nesta versão — o registro é apenas informativo.
> - Apenas uma forma de pagamento por venda (não há pagamento misto)
> - A forma de pagamento é usada para totalização nos relatórios diários e mensais
> - Prioridade: **Crítica**

---

### Suporte Offline

**RF-15 — Suporte Offline: Registro de Vendas sem Conexão**
> O sistema deve permitir registrar vendas mesmo quando não há conexão com a internet, armazenando os dados localmente no dispositivo.
> - O app detecta automaticamente a ausência de conexão e opera em modo offline
> - O usuário recebe indicação visual de que está em modo offline
> - Todas as funcionalidades de registro de venda permanecem disponíveis offline
> - Prioridade: **Alta**

---

**RF-16 — Suporte Offline: Sincronização ao Recuperar Conexão**
> Ao detectar que a conexão foi restabelecida, o sistema deve sincronizar automaticamente com o servidor todas as vendas registradas offline.
> - A sincronização ocorre em background, sem interromper o uso do app
> - O usuário recebe confirmação visual quando a sincronização for concluída
> - Em caso de conflito de dados, o sistema prioriza os registros locais (offline-first)
> - Prioridade: **Alta**

---

### Relatórios

**RF-17 — Relatórios: Relatório Diário de Vendas**
> O sistema deve gerar um relatório diário contendo todas as vendas do dia, totalizadas e separadas por forma de pagamento (dinheiro, PIX, crédito, débito).
> - O relatório exibe a data de referência
> - Os valores são totalizados por forma de pagamento e apresentados em grand total
> - O usuário pode consultar relatórios de datas anteriores
> - Prioridade: **Crítica**

---

**RF-18 — Relatórios: Relatório Mensal de Vendas**
> O sistema deve gerar um relatório mensal consolidando todas as vendas do mês para fechamento financeiro.
> - O relatório exibe totais por forma de pagamento no período
> - O usuário seleciona o mês/ano de referência
> - Prioridade: **Alta**

---

**RF-19 — Relatórios: Relatório de Produtos Vendidos**
> O sistema deve gerar um relatório de produtos com: quantidade vendida por produto, total financeiro por produto, custo unitário do produto (via fornecedor) e margem de lucro por produto.
> - Os dados podem ser filtrados por período (dia ou mês)
> - Os valores de custo são provenientes do cadastro de fornecedores
> - Prioridade: **Alta**

---

**RF-20 — Relatórios: Relatório Financeiro Gerencial**
> O sistema deve gerar um relatório gerencial completo com: total de vendas, total de produtos vendidos separado por tipo e unificado, ticket médio do cliente (média de gasto por atendimento), custos por produto e custo geral, margem de lucro por produto e margem geral do negócio.
> - O ticket médio é calculado como total de vendas dividido pelo número de atendimentos no período
> - O relatório exibe tanto valores absolutos quanto percentuais nas margens
> - Prioridade: **Alta**

---

**RF-21 — Relatórios: Geração Assíncrona de Relatórios**
> O sistema deve processar a geração de relatórios em background, sem bloquear o uso do aplicativo pelo usuário.
> - O usuário solicita a geração e continua usando o app normalmente
> - O status de processamento é visível (ex.: "aguardando", "gerando", "pronto")
> - Prioridade: **Alta**

---

**RF-22 — Relatórios: Notificação de Relatório Pronto**
> Quando o relatório terminar de ser gerado, o sistema deve notificar o usuário.
> - A notificação informa qual relatório ficou pronto
> - O usuário pode acessar o relatório diretamente pela notificação
> - Prioridade: **Alta**

---

**RF-23 — Relatórios: Tela de Visualização de Relatório**
> O sistema deve exibir o relatório gerado em uma tela dedicada dentro do aplicativo.
> - A tela de visualização fica acessível após a geração do relatório
> - A opção de download (PDF) está disponível nessa tela
> - Prioridade: **Alta**

---

**RF-24 — Relatórios: Download de Relatório em PDF**
> O sistema deve permitir que o usuário faça o download do relatório gerado em formato PDF.
> - O arquivo PDF é salvo no dispositivo do usuário
> - O PDF segue a mesma estrutura e gráficos exibidos na tela de visualização
> - Prioridade: **Alta**

---

**RF-25 — Relatórios: Geração de Relatório em HTML**
> O sistema deve oferecer a opção de gerar o relatório como página HTML, além do PDF.
> - O HTML pode ser aberto em navegador ou compartilhado
> - A estrutura e gráficos do HTML são equivalentes ao PDF
> - Prioridade: **Média**

---

**RF-26 — Relatórios: Visualização com Gráficos**
> Os relatórios devem incluir gráficos para representação visual dos dados, seguindo boas práticas de UX para relatórios mobile.
> - Os gráficos são gerados automaticamente a partir dos dados do relatório
> - Tipos de gráfico devem ser adequados ao dado exibido (ex.: barras para comparação, pizza para proporção)
> - Prioridade: **Alta**

---

### Dashboard

**RF-27 — Dashboard: Painel de Informações Gerais do Mês**
> O sistema deve exibir uma tela de dashboard com as seguintes informações consolidadas do mês corrente: total de vendas (quantidade e valor), quantidade de produtos vendidos por tipo, valor por produto vendido, ticket médio, custos e lucro do negócio.
> - O dashboard é a tela inicial ou de destaque do aplicativo
> - As informações são apresentadas de forma visual e resumida
> - Prioridade: **Alta**

---

**RF-28 — Dashboard: Atualização Automática**
> O dashboard deve ser atualizado automaticamente a cada 5 minutos enquanto o aplicativo estiver em uso.
> - O usuário não precisa acionar manualmente a atualização
> - Uma indicação de data/hora da última atualização é exibida
> - Em modo offline, o dashboard exibe os dados em cache com indicação de que pode estar desatualizado
> - Prioridade: **Média**

---

## ⚙️ Requisitos Não Funcionais

---

**RNF-01 — Desempenho: Estratégia de Cache para Consultas**
> O aplicativo deve utilizar cache local para consultas de dados recorrentes (ex.: dashboard, listagem de produtos), reduzindo chamadas desnecessárias ao servidor.
> - Dados em cache devem refletir alterações em até 5 minutos (sincronizado ao ciclo do dashboard)
> - O tempo de carregamento de telas com cache deve ser inferior a 1 segundo em rede 4G
> - Prioridade: **Alta**

---

**RNF-02 — Desempenho: Geração Assíncrona sem Degradação**
> A geração de relatórios em background não deve impactar a responsividade das demais telas do aplicativo.
> - Telas de cadastro e vendas devem manter tempo de resposta inferior a 2 segundos durante geração de relatório
> - Prioridade: **Alta**

---

**RNF-03 — Usabilidade: Design Minimalista e Amigável**
> O aplicativo deve ter design visual claro, elegante e minimalista, com hierarquia visual bem definida e ausência de elementos desnecessários.
> - O número de toques para completar uma venda não deve exceder 5 interações
> - A paleta de cores e tipografia devem ser consistentes em todas as telas
> - Prioridade: **Alta**

---

**RNF-04 — Usabilidade: Linguagem Clara e Objetiva**
> Todos os textos do aplicativo (labels, botões, mensagens, erros) devem usar linguagem simples, direta e compreensível para usuário não técnico.
> - Termos técnicos devem ser evitados ou explicados
> - Mensagens de erro devem indicar o que fazer, não apenas o que ocorreu
> - Prioridade: **Alta**

---

**RNF-05 — Usabilidade: Acessibilidade para Deficiência Visual Parcial**
> O aplicativo deve ser projetado considerando que uma das usuárias enxerga apenas com um olho, garantindo conforto visual e legibilidade.
> - Tamanho mínimo de fonte: 16sp para textos de corpo; 18sp para rótulos de ação
> - Elementos interativos com área de toque mínima de 48×48dp (diretrizes WCAG 2.1 / Material Design)
> - Contraste mínimo de 4,5:1 entre texto e fundo (nível AA do WCAG)
> - Suporte a recursos nativos de acessibilidade do iOS (VoiceOver) e Android (TalkBack)
> - Prioridade: **Alta**

---

**RNF-06 — Usabilidade: Experiência de Usuário Premium**
> O aplicativo deve adotar as melhores práticas de UX do mercado, proporcionando uma experiência fluída e intuitiva.
> - Feedback visual imediato para toda interação do usuário (loading states, confirmações, animações sutis)
> - Navegação previsível com máximo de 3 níveis de hierarquia de telas
> - Prioridade: **Média**

---

**RNF-07 — Segurança: Autenticação e Proteção de Dados**
> O aplicativo deve proteger o acesso com autenticação via e-mail/senha ou login social com Google (OAuth 2.0). Apenas um usuário (proprietário) é suportado em v1.
> - Tokens de autenticação devem ser armazenados de forma segura (Keychain no iOS / Keystore no Android)
> - A sessão expira após período de inatividade configurável
> - Dados sensíveis (financeiros) não devem ser armazenados em texto simples no dispositivo
> - Comunicação com o servidor deve usar HTTPS/TLS 1.2+
> - Prioridade: **Crítica**

---

**RNF-08 — Conformidade: LGPD**
> O aplicativo deve estar em conformidade com a Lei Geral de Proteção de Dados (Lei nº 13.709/2018). As vendas são registradas sem identificação de clientes (dados anônimos), o que reduz a exposição à LGPD, mas os dados do proprietário (e-mail, Google account) devem ser tratados adequadamente.
> - Dados do proprietário têm finalidade declarada (autenticação e gestão do negócio)
> - Deve haver mecanismo para exclusão da conta e dados a pedido
> - Prioridade: **Alta**

---

**RNF-09 — Confiabilidade: Operação em Rede Móvel e Modo Offline**
> O aplicativo deve funcionar de forma estável em condições de rede móvel 4G/5G e continuar operacional em ausência de sinal, com sincronização automática ao reconectar.
> - Vendas registradas offline não devem ser perdidas
> - O app detecta perda e retorno de conexão automaticamente
> - Mensagens de erro de conectividade devem ser claras e não bloquear o fluxo de venda
> - Prioridade: **Alta**

---

**RNF-10 — Compatibilidade: iOS e Android**
> O aplicativo deve ser compatível com iOS 15+ e Android 10+ (API level 29+).
> - Telas e fluxos devem ser funcionalmente equivalentes nas duas plataformas
> - Prioridade: **Crítica**

---

**RNF-11 — Dados: Retenção e Backup**
> Os dados de vendas, produtos e relatórios devem ser persistidos em servidor (nuvem), com estratégia de backup definida.
> - Os dados de vendas devem ser retidos por no mínimo 5 anos (obrigação fiscal)
> - O usuário não deve perder dados ao trocar de dispositivo
> - Prioridade: **Alta**

---

**RNF-12 — Manutenibilidade: Arquitetura Modular**
> O código do aplicativo deve seguir arquitetura modular que permita adição de novas funcionalidades sem reescrita de módulos existentes.
> - Separação clara entre camadas de UI, lógica de negócio e dados
> - A camada de vendas deve ser desacoplada o suficiente para suportar integração futura com terminal físico de pagamento
> - Prioridade: **Média**

---

**RNF-13 — Portabilidade: Preparação para Impressão via Bluetooth**
> O aplicativo deve ser arquiteturalmente preparado para suportar impressão de comprovantes via impressora Bluetooth em versão futura, mesmo que esta funcionalidade não esteja ativa em v1.
> - A camada de registro de vendas deve expor interface que permita integração com módulo de impressão sem refatoração do núcleo
> - Prioridade: **Baixa**

---

## ✔️ Decisões Registradas

Questões levantadas na análise inicial foram respondidas pelo proprietário e convertidas em requisitos:

| # | Questão | Decisão |
|---|---|---|
| Q1 | Mecanismo de autenticação | Cadastro via e-mail/senha + login social com Google → RF-01, RF-02 |
| Q2 | Controle de estoque no escopo? | Sim — tela própria com entradas manuais, deduções automáticas e alerta de estoque baixo → RF-08, RF-09, RF-10, RF-11 |
| Q3 | Feijão tropeiro — restrição ou ocultação? | Oculto por padrão fora das sextas; configurável pelo usuário para qualquer dia → RF-05 |
| Q4 | Integração com terminal de cartão? | Não em v1 — apenas registro informativo do pagamento; integração é feature futura → RF-14, RNF-12 |
| Q5 | Suporte offline? | Sim — vendas registradas localmente e sincronizadas ao reconectar → RF-15, RF-16, RNF-09 |
| Q6 | Impressão de comprovante? | Não em v1 — app deve ser preparado arquiteturalmente para impressora Bluetooth futura → RNF-13 |
| Q7 | Integração com Instagram? | Apenas contexto de negócio — sem integração técnica prevista |
| Q8 | Múltiplos usuários? | Apenas o proprietário em v1 — sem perfis ou controle de acesso adicional |
| Q9 | Dados de clientes? | Vendas anônimas — sem identificação ou cadastro de clientes |

---

## 🗺️ Fases Sugeridas de Desenvolvimento

**Fase 1 — MVP** *(entrega do valor principal)*

| Requisito | Descrição |
|---|---|
| RF-01, RF-02 | Autenticação: cadastro por e-mail e login com Google |
| RF-03, RF-04 | Cadastro e precificação de produtos por categoria |
| RF-05 | Visibilidade configurável por dia da semana (feijão tropeiro) |
| RF-12, RF-13, RF-14 | Registro de venda com múltiplos produtos, modalidade e forma de pagamento |
| RF-15, RF-16 | Suporte offline: registro local e sincronização automática |
| RF-17 | Relatório diário de vendas por forma de pagamento |
| RNF-07 | Segurança: autenticação e proteção de dados |
| RNF-10 | Compatibilidade iOS e Android |

**Fase 2 — Consolidação** *(experiência completa)*

| Requisito | Descrição |
|---|---|
| RF-06, RF-07 | Cadastro de fornecedores com associação produto-fornecedor e preço de compra |
| RF-08, RF-09, RF-10 | Gestão de estoque: tela dedicada, entradas e dedução automática por venda |
| RF-11 | Alerta de estoque baixo configurável por produto |
| RF-18 | Relatório mensal de vendas |
| RF-19 | Relatório de produtos vendidos (quantidade, custo, margem) |
| RF-21, RF-22, RF-23, RF-24 | Geração assíncrona, notificação, visualização e download PDF |
| RF-27 | Dashboard com informações gerais do mês |
| RNF-01, RNF-02 | Cache e desempenho assíncrono |
| RNF-05, RNF-06 | Acessibilidade e UX premium |
| RNF-09 | Confiabilidade offline e rede móvel |

**Fase 3 — Escala e Polimento** *(refinamento e crescimento)*

| Requisito | Descrição |
|---|---|
| RF-20 | Relatório financeiro gerencial completo com ticket médio e margem geral |
| RF-25 | Geração de relatório em HTML |
| RF-26 | Gráficos nos relatórios |
| RF-28 | Atualização automática do dashboard a cada 5 minutos |
| RNF-08 | Conformidade LGPD |
| RNF-11 | Retenção e backup de dados em nuvem |
| RNF-12 | Arquitetura preparada para integração futura com terminal de pagamento |
| RNF-13 | Preparação arquitetural para impressão via Bluetooth |

---

## 📊 Resumo dos Requisitos

| Categoria | Quantidade |
|---|---|
| Requisitos Funcionais | 28 |
| Requisitos Não Funcionais | 13 |
| Questões em Aberto | 0 |
| Decisões Registradas | 9 |
| **Total de Requisitos** | **41** |
