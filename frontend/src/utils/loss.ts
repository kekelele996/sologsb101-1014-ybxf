/**
 * 苗木结存（损耗）计算口径
 *
 * 口径决策：采用「总量重算」而非「逐次扣减」。
 *   可用株数 = max(0, 进场数量 − 累计损耗株数)
 *
 * 理由：
 * 1. 纯扣减序列下，逐次扣减（每步归零截断）与总量重算数学等价
 *    （max(0, max(0, x−a)−b) = max(0, x−a−b)）；两者结果不同只发生在
 *    逐次扣减把中间快照固化、补登历史日期时不回溯重算的实现里，
 *    而那种实现的台账本身不自洽。
 * 2. 总量口径与登记顺序无关：苗圃退苗 / 到场损耗多为事后补登，
 *    补登、改登、删登都只是把累计损耗重算一次，结果幂等。
 * 3. 批次上只需回写 depleted 布尔位，无需维护快照链。
 *
 * 可用株数归零（累计损耗 ≥ 进场数量）即判定批次「已耗尽」，
 * 已耗尽批次不再出现在栽植记录的批次选择中，批次与结存登记保留。
 */
import type { Seedling, SeedlingLoss } from '../types/seedling';

/** 某批次的累计损耗株数 */
export function sumLossCount(losses: SeedlingLoss[], seedlingId: string): number {
  return losses.filter((row) => row.seedlingId === seedlingId).reduce((acc, row) => acc + row.lossCount, 0);
}

/** 可用株数 = max(0, 进场数量 − 累计损耗株数) */
export function availableQuantity(seedling: Pick<Seedling, 'id' | 'quantity'>, losses: SeedlingLoss[]): number {
  return Math.max(0, seedling.quantity - sumLossCount(losses, seedling.id));
}

/** 是否已耗尽：累计损耗 ≥ 进场数量（进场数量恒 ≥ 1，故等价于可用株数归零） */
export function isDepleted(seedling: Pick<Seedling, 'id' | 'quantity'>, losses: SeedlingLoss[]): boolean {
  return sumLossCount(losses, seedling.id) >= seedling.quantity;
}
