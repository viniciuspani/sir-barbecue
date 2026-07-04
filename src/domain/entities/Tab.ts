// Entidades de domínio de Comanda (tab). Estado de trabalho LOCAL (não sincronizado).
// Uma comanda é um "carrinho nomeado e persistente": só vira Sale no pagamento (RF-12..14).

export interface TabItem {
  id: string;
  productId: string;
  name: string;
  unitPrice: number;
  quantity: number;
}

export interface Tab {
  id: string;
  customerName: string; // rótulo da comanda; não é cadastro de cliente (venda anônima — Q9)
  openedAt: number; // epoch ms
  items: TabItem[];
}

export interface NewTabItem {
  productId: string;
  name: string;
  unitPrice: number;
}
