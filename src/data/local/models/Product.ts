import { Model } from '@nozbe/watermelondb';
import { field, text } from '@nozbe/watermelondb/decorators';

// Model do WatermelonDB para a tabela `products` (usa decorators — exige o plugin Babel).
export default class ProductModel extends Model {
  static table = 'products';

  @text('name') name!: string;
  @field('price') price!: number;
  @field('is_active') isActive!: boolean;
  @text('category_id') categoryId?: string;
  @field('client_id') clientId!: string;
  @field('needs_sync') needsSync!: boolean;
  @field('synced_at') syncedAt?: number;
}
