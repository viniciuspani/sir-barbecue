import type { StockItem } from '@/domain/entities/StockItem';
import type { Tab } from '@/domain/entities/Tab';

/**
 * Como o saldo de um produto deve ser APRESENTADO na tela de venda.
 *
 * ESPELHO de `core/rules/sale.ts` do repo web (c:\develop\WEB\sir-barbecue-web),
 * onde a mesma regra tem testes. Mudou aqui? Mude lá também.
 *
 * O número em destaque é o DISPONÍVEL, não o saldo do inventário: mostrar
 * "Estoque: 10" quando 4 estão prometidos a uma comanda faz o operador prometer
 * o que não pode entregar. A baixa real continua acontecendo só no fechamento
 * da venda — a comanda RESERVA, não deduz.
 */

export type CartLine = { productId: string; quantity: number };

/** Comprometido: carrinho aberto + todas as comandas abertas. */
export function committedQuantities(cart: CartLine[], tabs: Tab[]): Map<string, number> {
  const map = new Map<string, number>();
  const add = (productId: string, quantity: number) =>
    map.set(productId, (map.get(productId) ?? 0) + quantity);
  for (const i of cart) add(i.productId, i.quantity);
  for (const t of tabs) for (const it of t.items) add(it.productId, it.quantity);
  return map;
}

/**
 * Reservado APENAS pelas comandas (sem o carrinho).
 * O carrinho já aparece no contador do próprio card; repeti-lo na legenda
 * confundiria. O que falta ao operador é saber quanto está prometido às mesas.
 */
export function reservedByTabs(tabs: Tab[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of tabs) {
    for (const i of t.items) map.set(i.productId, (map.get(i.productId) ?? 0) + i.quantity);
  }
  return map;
}

export function availableQuantity(
  productId: string,
  onHand: number,
  committed: Map<string, number>,
): number {
  return onHand - (committed.get(productId) ?? 0);
}

export type StockDisplay = {
  /** Saldo do inventário (o que a baixa da venda vai reduzir). */
  onHand: number;
  /** Reservado por comandas abertas. */
  reserved: number;
  /** onHand − comandas − carrinho. Nunca negativo. */
  available: number;
  status: 'ok' | 'low' | 'reserved' | 'out';
};

export function stockDisplay(
  productId: string,
  item: StockItem | undefined,
  committed: Map<string, number>,
  reserved: Map<string, number>,
): StockDisplay {
  const onHand = item?.quantity ?? 0;
  const alertThreshold = item?.alertThreshold ?? 0;
  const available = Math.max(0, availableQuantity(productId, onHand, committed));
  const reservedQty = reserved.get(productId) ?? 0;

  let status: StockDisplay['status'];
  if (onHand <= 0) {
    status = 'out'; // não há o produto
  } else if (available <= 0) {
    // Existe no estoque, mas está todo prometido. A ação do operador é outra:
    // conferir a comanda, não repor estoque.
    status = 'reserved';
  } else if (alertThreshold > 0 && available <= alertThreshold) {
    status = 'low';
  } else {
    status = 'ok';
  }

  return { onHand, reserved: reservedQty, available, status };
}
