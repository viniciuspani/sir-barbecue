import { create } from 'zustand';

export interface CartItem {
  productId: string;
  name: string;
  unitPrice: number;
  quantity: number;
}

interface CartState {
  items: CartItem[];
  add: (item: Omit<CartItem, 'quantity'>, quantity?: number) => void;
  decrement: (productId: string) => void;
  remove: (productId: string) => void;
  clear: () => void;
  total: () => number;
  count: () => number;
}

// Carrinho da venda em andamento (telas 4 "Nova Venda" e 5 "Fechar Venda").
export const useCartStore = create<CartState>((set, get) => ({
  items: [],
  add: (item, quantity = 1) =>
    set((state) => {
      const existing = state.items.find((i) => i.productId === item.productId);
      if (existing) {
        return {
          items: state.items.map((i) =>
            i.productId === item.productId ? { ...i, quantity: i.quantity + quantity } : i,
          ),
        };
      }
      return { items: [...state.items, { ...item, quantity }] };
    }),
  decrement: (productId) =>
    set((state) => {
      const existing = state.items.find((i) => i.productId === productId);
      if (!existing) return state;
      if (existing.quantity <= 1) {
        return { items: state.items.filter((i) => i.productId !== productId) };
      }
      return {
        items: state.items.map((i) =>
          i.productId === productId ? { ...i, quantity: i.quantity - 1 } : i,
        ),
      };
    }),
  remove: (productId) =>
    set((state) => ({ items: state.items.filter((i) => i.productId !== productId) })),
  clear: () => set({ items: [] }),
  total: () => get().items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0),
  count: () => get().items.reduce((sum, i) => sum + i.quantity, 0),
}));
