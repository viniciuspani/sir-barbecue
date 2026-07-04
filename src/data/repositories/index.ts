// Instâncias únicas dos repositórios (DI-lite). As telas dependem da interface de domínio.
import { DrizzleCategoryRepository } from './CategoryRepository';
import { DrizzleProductRepository } from './ProductRepository';
import { DrizzleSaleRepository } from './SaleRepository';
import { DrizzleStockRepository } from './StockRepository';
import { DrizzleSupplierRepository } from './SupplierRepository';
import { DrizzleTabRepository } from './TabRepository';

import type { CategoryRepository } from '@/domain/repositories/CategoryRepository';
import type { ProductRepository } from '@/domain/repositories/ProductRepository';
import type { SaleRepository } from '@/domain/repositories/SaleRepository';
import type { StockRepository } from '@/domain/repositories/StockRepository';
import type { SupplierRepository } from '@/domain/repositories/SupplierRepository';
import type { TabRepository } from '@/domain/repositories/TabRepository';

export const productRepository: ProductRepository = new DrizzleProductRepository();
export const categoryRepository: CategoryRepository = new DrizzleCategoryRepository();
export const saleRepository: SaleRepository = new DrizzleSaleRepository();
export const stockRepository: StockRepository = new DrizzleStockRepository();
export const supplierRepository: SupplierRepository = new DrizzleSupplierRepository();
export const tabRepository: TabRepository = new DrizzleTabRepository();
