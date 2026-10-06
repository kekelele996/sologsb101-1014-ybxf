/**
 * 苗木批次结存计算
 *
 * 结存口径（重算口径，项目统一采用）：
 *   可用株数 = 进场数量 − 该批次全部结存登记的损耗株数合计
 * 每次登记后都按进场数量重新累计，结果与登记先后顺序无关；即使补登日期更早的
 * 损耗，也会立即参与重算。
 *
 * 备选口径（逐次扣减口径）：
 *   可用株数 = 上一次可用株数 − 本次损耗
 * 该口径按登记顺序逐次扣减，当补登日期早于上次登记日期时，补登的损耗不会参与
 * 历史余额重算，可用株数会虚高，因此不予采用。
 *
 * 可用株数 ≤ 0 时批次标记为「已耗尽」；耗尽后批次与结存登记记录仍保留，
 * 只是不再出现在栽植记录的批次选择中。
 */
import type { Seedling } from '../types/seedling';
import type { SeedlingBalance } from '../types/seedlingBalance';

/** 某批次的累计损耗株数 */
export function sumLosses(balances: SeedlingBalance[], seedlingId: string): number {
  return balances
    .filter((row) => row.seedlingId === seedlingId)
    .reduce((acc, row) => acc + row.lossCount, 0);
}

/** 某批次的全部结存登记，按登记日期先后排列（日期相同按创建时间） */
export function balancesOf(balances: SeedlingBalance[], seedlingId: string): SeedlingBalance[] {
  return balances
    .filter((row) => row.seedlingId === seedlingId)
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
}

/** 可用株数：进场数量 − 累计损耗（不为负） */
export function availableQuantity(seedling: Seedling, balances: SeedlingBalance[]): number {
  return Math.max(0, seedling.quantity - sumLosses(balances, seedling.id));
}

/** 批次是否已耗尽：累计损耗 ≥ 进场数量（可用株数归零） */
export function isDepleted(seedling: Seedling, balances: SeedlingBalance[]): boolean {
  return seedling.quantity - sumLosses(balances, seedling.id) <= 0;
}
