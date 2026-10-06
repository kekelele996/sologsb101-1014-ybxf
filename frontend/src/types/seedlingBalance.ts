/**
 * 结存登记（SeedlingBalance）
 * 苗木批次的损耗登记：苗圃退苗、到场损耗等。一条批次可登记多次，
 * 每次填损耗株数与登记日期（可补登更早日期）。
 */

export interface SeedlingBalance {
  id: string;
  /** 所属苗木批次 */
  seedlingId: string;
  /** 所属地块（冗余存储，便于按地块查询与级联清理） */
  plotId: string;
  /** 损耗株数（株） */
  lossCount: number;
  /** 登记日期 YYYY-MM-DD（支持补登更早日期） */
  date: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新建结存登记的表单草稿 */
export interface SeedlingBalanceDraft {
  seedlingId: string;
  plotId: string;
  lossCount: number;
  date: string;
}
