import type { HelpTopic } from '@/content/help/types';

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'vender',
    icon: 'add-circle-outline',
    title: 'Como vender',
    subtitle: 'Venda rápida ou por comanda',
    intro:
      'Toda venda começa na aba Venda. Você pode vender direto (venda rápida) ou abrir uma comanda para atender uma mesa ou cliente que vai consumir aos poucos.',
    flow: [
      { kind: 'start', label: 'Abra a aba Venda' },
      {
        kind: 'decision',
        label: 'É para uma mesa ou cliente que vai voltar a pedir?',
        yes: 'Toque em “+ Comanda” e informe o nome',
        no: 'Siga direto (venda rápida)',
      },
      {
        kind: 'step',
        label: 'Toque nos produtos para adicionar ao carrinho',
        detail: 'Cada toque soma 1 unidade. Produtos marcados “Sem estoque” não podem ser adicionados.',
        icon: 'fast-food-outline',
      },
      {
        kind: 'step',
        label: 'Confira a barra inferior',
        detail: 'Ela mostra a quantidade de itens e o total da venda (ou da comanda selecionada).',
        icon: 'cart-outline',
      },
      {
        kind: 'step',
        label: 'Toque em “Fechar”',
        detail: 'Você vai para a tela de pagamento com o total já calculado.',
        icon: 'checkmark-circle-outline',
      },
      {
        kind: 'step',
        label: 'Escolha pagamento e consumo',
        detail: 'Forma de pagamento: Pix, Dinheiro, Crédito ou Débito. Consumo: No local ou Para viagem.',
        icon: 'card-outline',
      },
      {
        kind: 'step',
        label: 'Toque em “Confirmar venda”',
        icon: 'checkmark-done-outline',
      },
      { kind: 'end', label: 'Venda registrada! ✅' },
    ],
    steps: [
      {
        title: '1. Abra a aba Venda',
        detail: 'É a aba central, com o ícone de “+” — a tela inicial para vender.',
      },
      {
        title: '2. Decida: venda rápida ou comanda?',
        detail:
          'Para vender e fechar na hora, não precisa fazer nada — é só começar a tocar nos produtos (venda rápida). Para atender uma mesa ou cliente que vai pedir mais coisas depois, toque em “+ Comanda”, digite o nome (ex.: “João da mesa 3”) e toque em “Abrir comanda”.',
      },
      {
        title: '3. Adicione os produtos',
        detail:
          'Toque nos cards de produto para ir somando ao carrinho. Use os filtros de categoria no topo para achar mais rápido. Se um produto estiver com a etiqueta “Sem estoque”, ele não pode ser vendido até uma nova entrada no estoque.',
      },
      {
        title: '4. Acompanhe o total',
        detail:
          'A barra na parte de baixo da tela mostra quantos itens estão no carrinho e o valor total. Se estiver numa comanda, o botão “Excluir” também aparece ali, caso precise cancelar a comanda inteira.',
      },
      {
        title: '5. Feche a venda',
        detail: 'Toque em “Fechar” na barra inferior para ir à tela de pagamento.',
      },
      {
        title: '6. Escolha forma de pagamento e consumo',
        detail:
          'Selecione como o cliente pagou (Pix, Dinheiro, Crédito ou Débito) e se o consumo foi No local ou Para viagem.',
      },
      {
        title: '7. Confirme',
        detail:
          'Toque em “Confirmar venda”. A mensagem “Venda registrada!” confirma que deu tudo certo — o estoque já é descontado automaticamente.',
      },
    ],
    tips: [
      'Precisa cancelar uma venda em andamento? Use o botão “Cancelar” na barra inferior antes de fechar — ele limpa o carrinho.',
      'Comandas abertas ficam disponíveis na lista de chips no topo da tela — dá para atender várias mesas ao mesmo tempo sem perder o pedido de nenhuma.',
    ],
  },
  {
    id: 'cadastrar-produto',
    icon: 'fast-food-outline',
    title: 'Como cadastrar produto',
    subtitle: 'Nome, preço, categoria e mais',
    requires: 'products',
    intro:
      'Cadastre aqui tudo que sua churrascaria vende — do espetinho à bebida. É o primeiro passo antes de vender ou de colocar o produto no estoque.',
    flow: [
      { kind: 'start', label: 'Abra a aba Produtos' },
      {
        kind: 'step',
        label: 'Toque no botão “+”',
        detail: 'Abre o formulário de novo produto.',
        icon: 'add-circle-outline',
      },
      {
        kind: 'step',
        label: 'Preencha Nome e Preço (R$)',
        icon: 'pricetag-outline',
      },
      {
        kind: 'step',
        label: 'Escolha uma Categoria',
        detail: 'Opcional — ajuda a organizar a lista de produtos na Venda.',
        icon: 'list-outline',
      },
      {
        kind: 'decision',
        label: 'O produto deve aparecer só em alguns dias da semana?',
        yes: 'Marque os dias em “Dias de visibilidade”',
        no: 'Não marque nenhum dia (aparece todos os dias)',
      },
      {
        kind: 'step',
        label: 'Confira se “Produto ativo” está ligado',
        detail: 'Produto inativo some da tela de Venda.',
        icon: 'toggle-outline',
      },
      { kind: 'step', label: 'Toque em “Cadastrar produto”', icon: 'checkmark-done-outline' },
      { kind: 'end', label: 'Produto cadastrado! ✅' },
    ],
    steps: [
      {
        title: '1. Abra a aba Produtos',
        detail: 'A lista mostra todos os produtos já cadastrados, com nome, categoria e preço.',
      },
      {
        title: '2. Toque no botão “+”',
        detail: 'Fica no canto inferior direito da tela e abre o formulário de novo produto.',
      },
      {
        title: '3. Preencha Nome e Preço',
        detail: 'Ex.: “Espetinho de Carne”, preço em reais (R$).',
      },
      {
        title: '4. Escolha a Categoria',
        detail:
          'Toque em uma das categorias listadas. Se nenhuma categoria aparecer, é porque ainda não há categorias cadastradas — o produto pode ser salvo mesmo assim, sem categoria.',
      },
      {
        title: '5. Defina os Dias de visibilidade (opcional)',
        detail:
          'Deixe sem marcar nada para o produto aparecer todos os dias. Marque dias específicos (ex.: só sábado e domingo) para um produto sazonal.',
      },
      {
        title: '6. Confirme se está “Produto ativo”',
        detail: 'Esse interruptor precisa estar ligado para o produto aparecer na tela de Venda.',
      },
      {
        title: '7. Toque em “Cadastrar produto”',
        detail: 'O produto passa a aparecer na lista de Produtos.',
      },
    ],
    tips: [
      'Produto novo começa sem estoque — ele aparece na Venda marcado como “Sem estoque” até você registrar a primeira entrada (veja “Como colocar um produto no estoque”).',
      'Para editar um produto depois, toque nele na lista de Produtos — os mesmos campos abrem para alteração, com o botão “Salvar alterações”.',
    ],
  },
  {
    id: 'colocar-no-estoque',
    icon: 'cube-outline',
    title: 'Como colocar um produto no estoque',
    subtitle: 'Primeira entrada de um produto novo',
    requires: 'stock',
    intro:
      'Cadastrar o produto não é suficiente para vendê-lo — sem estoque, ele fica bloqueado com a etiqueta “Sem estoque” na tela de Venda. É preciso registrar a primeira entrada.',
    flow: [
      { kind: 'start', label: 'Cadastre o produto em Produtos (se ainda não existir)' },
      {
        kind: 'step',
        label: 'Abra a aba Estoque',
        detail: 'Um produto sem nenhuma entrada ainda não aparece nesta lista.',
        icon: 'cube-outline',
      },
      { kind: 'step', label: 'Toque no botão “+”', icon: 'add-circle-outline' },
      {
        kind: 'step',
        label: 'Em “Produto”, selecione o produto pelo nome',
        icon: 'fast-food-outline',
      },
      {
        kind: 'step',
        label: 'Informe a Quantidade recebida',
        detail: 'Ex.: 50.',
      },
      { kind: 'step', label: 'Toque em “Registrar entrada”', icon: 'checkmark-done-outline' },
      { kind: 'end', label: 'O produto aparece na lista de Estoque! ✅' },
    ],
    steps: [
      {
        title: '1. Cadastre o produto primeiro',
        detail: 'Se ainda não existe, cadastre em Produtos (veja “Como cadastrar produto”).',
      },
      {
        title: '2. Abra a aba Estoque',
        detail:
          'Repare que o produto recém-cadastrado ainda não aparece nesta lista — ela só mostra produtos com pelo menos uma entrada registrada.',
      },
      {
        title: '3. Toque no botão “+”',
        detail: 'Abre a tela “Registrar entrada”.',
      },
      {
        title: '4. Selecione o Produto',
        detail: 'Toque no nome do produto na lista de opções.',
      },
      {
        title: '5. Informe a Quantidade',
        detail: 'A quantidade recebida (ex.: 50 unidades).',
      },
      {
        title: '6. Observações (opcional)',
        detail: 'Um lembrete livre, ex.: “compra no atacado”.',
      },
      {
        title: '7. Toque em “Registrar entrada”',
        detail: 'O produto passa a aparecer na lista de Estoque, com a quantidade cadastrada.',
      },
    ],
    tips: [
      'O custo do produto (quanto você paga por ele) não é cadastrado aqui — isso fica no vínculo com o Fornecedor (veja “Como vincular produto a fornecedor”).',
      'Assim que a quantidade fica maior que zero, o produto sai da etiqueta “Sem estoque” na tela de Venda e pode ser vendido.',
    ],
  },
  {
    id: 'registrar-entrada',
    icon: 'refresh-outline',
    title: 'Como registrar entrada no estoque',
    subtitle: 'Reposição do dia a dia',
    requires: 'stock',
    intro:
      'Sempre que chegar mercadoria nova de um produto que você já vende, registre uma entrada para manter o estoque certo e evitar vender “no vermelho”.',
    flow: [
      { kind: 'start', label: 'Abra a aba Estoque ao receber mercadoria nova' },
      {
        kind: 'step',
        label: 'Encontre o produto na lista',
        detail: 'Produtos com quantidade baixa aparecem com a etiqueta “Estoque baixo”.',
        icon: 'cube-outline',
      },
      {
        kind: 'decision',
        label: 'O produto está marcado “Estoque baixo”?',
        yes: 'Priorize — registre a entrada logo',
        no: 'Registre quando for conveniente',
      },
      { kind: 'step', label: 'Toque no botão “+”', icon: 'add-circle-outline' },
      {
        kind: 'step',
        label: 'Selecione o Produto e informe a Quantidade recebida',
        icon: 'fast-food-outline',
      },
      { kind: 'step', label: 'Toque em “Registrar entrada”', icon: 'checkmark-done-outline' },
      { kind: 'end', label: 'Estoque atualizado! ✅' },
    ],
    steps: [
      {
        title: '1. Abra a aba Estoque',
        detail:
          'Produtos com quantidade igual ou menor que o limite de alerta aparecem marcados “Estoque baixo”.',
      },
      {
        title: '2. Toque no botão “+”',
        detail: 'Abre a tela “Registrar entrada” — a mesma usada na primeira entrada de um produto.',
      },
      {
        title: '3. Selecione o Produto',
        detail: 'Toque no nome do produto que está repondo.',
      },
      {
        title: '4. Informe a Quantidade recebida',
        detail:
          'A quantidade digitada é somada ao estoque atual — não substitui o que já existia. Ex.: se havia 5 e chegaram mais 20, informe 20 (o total passa a ser 25).',
      },
      {
        title: '5. Toque em “Registrar entrada”',
        detail: 'O saldo do produto na aba Estoque é atualizado na hora.',
      },
    ],
    tips: [
      'Ficar de olho na etiqueta “Estoque baixo” evita perder venda por falta de produto — veja também “Como configurar alerta de estoque baixo”.',
      'Toque no produto dentro da aba Estoque para ver o histórico completo de entradas.',
    ],
  },
  {
    id: 'cadastrar-fornecedor',
    icon: 'people-outline',
    title: 'Como cadastrar fornecedor',
    subtitle: 'Nome, contato e endereço',
    requires: 'suppliers',
    intro:
      'Cadastre seus fornecedores para depois vincular produtos a eles e acompanhar quanto você paga em cada compra.',
    flow: [
      { kind: 'start', label: 'Abra Mais → Fornecedores' },
      { kind: 'step', label: 'Toque no botão “+”', icon: 'add-circle-outline' },
      {
        kind: 'step',
        label: 'Preencha o Nome',
        detail: 'Ex.: “Distribuidora Central”.',
        icon: 'business-outline',
      },
      {
        kind: 'step',
        label: 'Contato, Telefone e Endereço',
        detail: 'Todos opcionais — preencha o que tiver à mão.',
        icon: 'call-outline',
      },
      { kind: 'step', label: 'Toque em “Cadastrar fornecedor”', icon: 'checkmark-done-outline' },
      { kind: 'end', label: 'Fornecedor cadastrado! ✅' },
    ],
    steps: [
      {
        title: '1. Abra Mais → Fornecedores',
        detail: 'A lista mostra todos os fornecedores já cadastrados.',
      },
      {
        title: '2. Toque no botão “+”',
        detail: 'Abre o formulário de novo fornecedor.',
      },
      {
        title: '3. Preencha o Nome',
        detail: 'É o único campo obrigatório.',
      },
      {
        title: '4. Contato, Telefone e Endereço (opcionais)',
        detail: 'Ajudam a identificar rápido quem procurar na hora de repor estoque.',
      },
      {
        title: '5. Toque em “Cadastrar fornecedor”',
        detail: 'O fornecedor passa a aparecer na lista de Fornecedores.',
      },
    ],
    tips: [
      'Gerente também acessa a lista de Fornecedores, mas só o Dono pode cadastrar, editar ou excluir — é uma tela de leitura para o Gerente.',
      'Depois de cadastrar, vincule produtos ao fornecedor para registrar o preço de compra (veja “Como vincular produto a fornecedor”).',
    ],
  },
  {
    id: 'vincular-produto-fornecedor',
    icon: 'link-outline',
    title: 'Como vincular produto a fornecedor',
    subtitle: 'Registre o preço de compra',
    requires: 'suppliers',
    intro:
      'Vincular um produto a um fornecedor registra quanto você paga por ele. Esse preço de compra é a base do custo e do lucro que aparecem nos relatórios.',
    flow: [
      { kind: 'start', label: 'Abra Mais → Fornecedores → toque no fornecedor' },
      {
        kind: 'step',
        label: 'Role até “Associar produto”',
        icon: 'list-outline',
      },
      {
        kind: 'step',
        label: 'Selecione o produto pelo nome',
        icon: 'fast-food-outline',
      },
      {
        kind: 'step',
        label: 'Informe o “Preço de compra (R$)”',
        icon: 'pricetag-outline',
      },
      { kind: 'step', label: 'Toque em “Associar produto”', icon: 'checkmark-done-outline' },
      { kind: 'end', label: 'Produto associado! ✅' },
    ],
    steps: [
      {
        title: '1. Abra o fornecedor',
        detail: 'Em Mais → Fornecedores, toque no fornecedor desejado.',
      },
      {
        title: '2. Encontre “Associar produto”',
        detail:
          'Só aparecem ali os produtos que ainda não estão vinculados a esse fornecedor. Se a lista disser “Todos os produtos já estão associados”, não há mais o que vincular.',
      },
      {
        title: '3. Selecione o produto e informe o preço',
        detail: 'Toque no nome do produto e digite o “Preço de compra (R$)”.',
      },
      {
        title: '4. Toque em “Associar produto”',
        detail: 'O vínculo aparece em “Produtos fornecidos”, com o preço ao lado do nome.',
      },
      {
        title: '5. Para mudar o preço depois',
        detail:
          'Toque em “Editar” no vínculo, informe o novo preço e toque em “Salvar”. A mudança fica registrada no histórico do produto.',
      },
    ],
    tips: [
      'Só o Dono pode associar, editar ou remover vínculos — Gerente só visualiza.',
      'Trocando de fornecedor? Use “Inativar”, não “Excluir” — assim o histórico de preços é preservado. “Excluir” é só para corrigir um vínculo cadastrado errado.',
      'Toda mudança de preço fica no histórico do produto (veja “Como verificar histórico de preço”).',
    ],
  },
  {
    id: 'historico-preco',
    icon: 'time-outline',
    title: 'Como verificar histórico de preço',
    subtitle: 'Acompanhe a variação do preço de compra',
    requires: 'stock',
    intro:
      'Cada vez que você atualiza o preço de compra de um produto com um fornecedor, o app guarda um registro. Use o histórico para acompanhar se o produto está encarecendo.',
    flow: [
      { kind: 'start', label: 'Abra a aba Estoque → toque no produto' },
      {
        kind: 'step',
        label: 'Veja “Histórico de entradas”',
        detail: 'Mostra as entradas de estoque com o preço do fornecedor atual.',
        icon: 'cube-outline',
      },
      {
        kind: 'step',
        label: 'Toque em “Ver histórico de preço de compra completo”',
        icon: 'time-outline',
      },
      {
        kind: 'step',
        label: 'Escolha a ordem de exibição',
        detail: '“Mais recente primeiro” ou “Mais antigo primeiro”.',
        icon: 'swap-vertical-outline',
      },
      { kind: 'end', label: 'Veja cada mudança de preço, com fornecedor e data! ✅' },
    ],
    steps: [
      {
        title: '1. Abra o produto na aba Estoque',
        detail: 'Toque no produto para abrir os detalhes de estoque.',
      },
      {
        title: '2. Toque em “Ver histórico de preço de compra completo”',
        detail: 'Fica logo abaixo do histórico de entradas.',
      },
      {
        title: '3. Escolha a ordem',
        detail: 'Use os botões “Mais recente primeiro” ou “Mais antigo primeiro” para reordenar a lista.',
      },
      {
        title: '4. Leia os registros',
        detail:
          'Cada linha mostra o fornecedor, a data e o preço pago naquele momento. A etiqueta “atual” marca o fornecedor ainda vinculado ao produto hoje. Quando há mais de um preço diferente, o maior aparece com a etiqueta “maior” e o menor com “menor”.',
      },
    ],
    tips: [
      'Sem vínculo com fornecedor ainda? O histórico aparece vazio — veja “Como vincular produto a fornecedor” para começar a registrar preços.',
      'Comparar o preço “menor” com o “maior” ajuda a negociar com o fornecedor ou decidir trocar de fornecedor.',
    ],
  },
  {
    id: 'alerta-estoque-baixo',
    icon: 'warning-outline',
    title: 'Como configurar alerta de estoque baixo',
    subtitle: 'Seja avisado antes de faltar produto',
    requires: 'stock',
    intro:
      'Defina um limite mínimo para cada produto. Quando o saldo chegar nesse limite, o produto ganha a etiqueta “Estoque baixo” na aba Estoque.',
    flow: [
      { kind: 'start', label: 'Abra a aba Estoque → toque no produto' },
      {
        kind: 'step',
        label: 'Encontre “Alerta de estoque baixo”',
        icon: 'warning-outline',
      },
      {
        kind: 'step',
        label: 'Informe o “Limite de alerta”',
        detail: 'Ex.: 10. Use 0 para desligar o alerta desse produto.',
        icon: 'create-outline',
      },
      { kind: 'step', label: 'Toque em “Salvar alerta”', icon: 'checkmark-done-outline' },
      { kind: 'end', label: 'Alerta configurado! ✅' },
    ],
    steps: [
      {
        title: '1. Abra o produto na aba Estoque',
        detail: 'Toque no produto para abrir os detalhes de estoque.',
      },
      {
        title: '2. Encontre “Alerta de estoque baixo”',
        detail: 'Logo abaixo do saldo atual do produto.',
      },
      {
        title: '3. Informe o “Limite de alerta”',
        detail:
          'É o saldo mínimo aceitável. Quando a quantidade ficar igual ou menor que esse número, o produto passa a aparecer com a etiqueta “Estoque baixo” na lista de Estoque. Deixe 0 para não alertar sobre esse produto.',
      },
      {
        title: '4. Toque em “Salvar alerta”',
        detail: 'A mensagem “Alerta atualizado!” confirma que o limite foi salvo.',
      },
    ],
    tips: [
      'A etiqueta “Estoque baixo” aparece na lista de Estoque assim que o limite é atingido.',
    ],
  },
  {
    id: 'gerar-relatorios',
    icon: 'bar-chart-outline',
    title: 'Como gerar relatórios',
    subtitle: 'Faturamento, produtos e lucro',
    requires: 'reports',
    intro:
      'Acompanhe o desempenho da sua churrascaria: faturamento, produtos mais vendidos, formas de pagamento e — se você cadastrou o preço de compra dos produtos — o lucro do período.',
    flow: [
      { kind: 'start', label: 'Abra Mais → Relatórios' },
      {
        kind: 'step',
        label: 'Escolha o período',
        detail: '“Hoje”, “7 dias” ou “Mês”.',
        icon: 'calendar-outline',
      },
      {
        kind: 'step',
        label: 'Veja o resumo na tela',
        detail: 'Faturamento, produtos mais vendidos e total por forma de pagamento.',
        icon: 'bar-chart-outline',
      },
      {
        kind: 'step',
        label: 'Toque em “Gerar relatório (HTML)”',
        detail: 'Requer conexão com a internet.',
        icon: 'cloud-download-outline',
      },
      { kind: 'end', label: 'Relatório completo aberto na tela, com lucro e margem! ✅' },
    ],
    steps: [
      {
        title: '1. Abra Mais → Relatórios',
        detail: 'A tela já mostra um resumo rápido do período selecionado.',
      },
      {
        title: '2. Escolha o período',
        detail: 'Toque em “Hoje”, “7 dias” ou “Mês” para trocar o período do resumo.',
      },
      {
        title: '3. Veja o resumo rápido',
        detail:
          'O cartão “Faturamento” mostra o total e o número de vendas. Abaixo, “Produtos mais vendidos” lista os 5 mais vendidos por quantidade, e “Por forma de pagamento” mostra o total recebido em Pix, Dinheiro, Crédito e Débito.',
      },
      {
        title: '4. Toque em “Gerar relatório (HTML)”',
        detail:
          'O relatório completo é montado no servidor — por isso precisa de conexão com a internet.',
      },
      {
        title: '5. Leia o relatório',
        detail:
          'Ele abre em uma janela dentro do app, com o total do período, os produtos mais vendidos, o lucro e a margem de lucro. Toque em “Fechar” para voltar.',
      },
    ],
    tips: [
      'Sem conexão com a internet, o botão “Gerar relatório (HTML)” não funciona — mas o resumo rápido na tela (Faturamento, Produtos mais vendidos, Por forma de pagamento) continua disponível offline.',
      'Para o relatório mostrar lucro e margem certos, vincule cada produto ao fornecedor com o preço de compra (veja “Como vincular produto a fornecedor”) — produtos sem custo cadastrado aparecem com margem “—”.',
    ],
  },
];
