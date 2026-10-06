/**
 * 苗木批次（Seedling）
 * 一次进场的一批苗木，登记树种、来源、规格与数量。
 */

/** 树种：秋茄 / 桐花树 / 白骨壤 / 无瓣海桑 */
export type SeedlingSpecies = '秋茄' | '桐花树' | '白骨壤' | '无瓣海桑';

/** 来源：自育苗 / 外购 */
export type SeedlingSource = '自育苗' | '外购';

export const SEEDLING_SPECIES_OPTIONS: SeedlingSpecies[] = ['秋茄', '桐花树', '白骨壤', '无瓣海桑'];
export const SEEDLING_SOURCE_OPTIONS: SeedlingSource[] = ['自育苗', '外购'];

export interface Seedling {
  id: string;
  /** 所属地块 */
  plotId: string;
  /** 树种 */
  species: SeedlingSpecies;
  /** 来源 */
  source: SeedlingSource;
  /** 规格（如 50cm 裸根苗 / 40cm 营养袋苗） */
  spec: string;
  /** 数量（株） */
  quantity: number;
  /** 进场日期 YYYY-MM-DD */
  arrivalDate: string;
  /**
   * 是否已耗尽：可用株数（进场数量 − 累计损耗）归零时由结存登记回写。
   * 已耗尽批次不再出现在栽植记录的批次选择中，但批次与结存登记保留。
   */
  depleted: boolean;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新建 / 编辑苗木批次的表单草稿 */
export interface SeedlingDraft {
  plotId: string;
  species: SeedlingSpecies;
  source: SeedlingSource;
  spec: string;
  quantity: number;
  arrivalDate: string;
}

/** 损耗类型：苗圃退苗 / 到场损耗 */
export type SeedlingLossKind = '苗圃退苗' | '到场损耗';

export const SEEDLING_LOSS_KIND_OPTIONS: SeedlingLossKind[] = ['苗圃退苗', '到场损耗'];

/**
 * 苗木结存登记（SeedlingLoss）
 * 登记某一批次的损耗株数与登记日期，一条批次可登记多次；
 * 可用株数按「进场数量 − 累计损耗」总量口径重算（见 utils/loss.ts）。
 */
export interface SeedlingLoss {
  id: string;
  /** 所属苗木批次 */
  seedlingId: string;
  /** 损耗类型 */
  kind: SeedlingLossKind;
  /** 损耗株数 */
  lossCount: number;
  /** 登记日期 YYYY-MM-DD（允许补登历史日期） */
  registerDate: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新建结存登记的表单草稿 */
export interface SeedlingLossDraft {
  seedlingId: string;
  kind: SeedlingLossKind;
  lossCount: number;
  registerDate: string;
}
