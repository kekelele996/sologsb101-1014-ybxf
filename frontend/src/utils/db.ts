/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbmangrove
 * - 含数据结构版本号与 v1 → v2 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - 提供各表增删改查、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Plot } from '../types/plot';
import type { Seedling, SeedlingLoss, SeedlingLossDraft } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { Replant, ReplantState } from '../types/replant';
import { rateLevel } from './rate';
import { isDepleted } from './loss';
import { nowIso, today, uuid } from './id';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbmangrove';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

class MangroveDatabase extends Dexie {
  plots!: Table<Plot, string>;
  seedlings!: Table<Seedling, string>;
  seedlingLosses!: Table<SeedlingLoss, string>;
  plantings!: Table<Planting, string>;
  surveys!: Table<Survey, string>;
  replants!: Table<Replant, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt',
      seedlings: 'id, plotId, species, source, arrivalDate',
      plantings: 'id, plotId, seedlingId, plantDate',
      surveys: 'id, plotId, round, date',
      replants: 'id, plotId, planDate, state',
    });

    // ---------- v2：补齐索引与回写字段，并迁移历史数据 ----------
    this.version(2)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        // 复合索引 [plotId+round]：按地块 + 测次快速取验收记录
        surveys: 'id, plotId, [plotId+round], date, grade',
        replants: 'id, plotId, planDate, state, species',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('plots'),
          tx.table('seedlings'),
          tx.table('plantings'),
          tx.table('surveys'),
          tx.table('replants'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：地块补齐「缺株数 / 最近补植日期」回写字段
        await tx.table('plots').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.missingCount !== 'number') row.missingCount = 0;
          if (typeof row.lastReplantDate !== 'string') row.lastReplantDate = '';
        });
        // 迁移 3：验收记录补齐成活率等级字段
        await tx.table('surveys').toCollection().modify((row: Record<string, unknown>) => {
          const rate = typeof row.survivalRate === 'number' ? row.survivalRate : 0;
          if (typeof row.grade !== 'string') row.grade = rateLevel(rate);
          if (typeof row.gradeManual !== 'boolean') row.gradeManual = false;
        });
      });

    // ---------- v3：新增苗木结存登记表，批次补齐「已耗尽」回写位 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        seedlingLosses: 'id, seedlingId, registerDate',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        surveys: 'id, plotId, [plotId+round], date, grade',
        replants: 'id, plotId, planDate, state, species',
      })
      .upgrade(async (tx) => {
        // 迁移 4：苗木批次补齐 depleted 字段（历史批次均无损耗登记，默认未耗尽）
        await tx.table('seedlings').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.depleted !== 'boolean') row.depleted = false;
        });
      });
  }
}

export const db = new MangroveDatabase();

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.plots.count()) === 0) {
        await seedDatabase();
      }
    })();
  }
  return initPromise;
}

/* -------------------------------- 地块 -------------------------------- */

export async function listPlots(): Promise<Plot[]> {
  const rows = await db.plots.toArray();
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function getPlot(id: string): Promise<Plot | undefined> {
  return db.plots.get(id);
}

export async function putPlot(row: Plot): Promise<void> {
  await db.plots.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function patchPlot(id: string, patch: Partial<Plot>): Promise<void> {
  await db.plots.update(id, { ...patch, updatedAt: nowIso() });
}

/** 删除地块并级联清理其下苗木批次、结存登记、栽植、验收与补植计划 */
export async function removePlot(id: string): Promise<void> {
  await db.transaction('rw', [db.plots, db.seedlings, db.seedlingLosses, db.plantings, db.surveys, db.replants], async () => {
    const seedlingIds = await db.seedlings.where('plotId').equals(id).primaryKeys();
    if (seedlingIds.length > 0) {
      await db.seedlingLosses.where('seedlingId').anyOf(seedlingIds).delete();
    }
    await db.seedlings.where('plotId').equals(id).delete();
    await db.plantings.where('plotId').equals(id).delete();
    await db.surveys.where('plotId').equals(id).delete();
    await db.replants.where('plotId').equals(id).delete();
    await db.plots.delete(id);
  });
}

/* ------------------------------ 苗木批次 ------------------------------ */

export async function listSeedlings(): Promise<Seedling[]> {
  const rows = await db.seedlings.toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function listSeedlingsByPlot(plotId: string): Promise<Seedling[]> {
  const rows = await db.seedlings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function putSeedling(row: Seedling): Promise<void> {
  await db.seedlings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeSeedling(id: string): Promise<void> {
  await db.transaction('rw', db.seedlings, db.seedlingLosses, db.plantings, async () => {
    // 该批次已被栽植记录引用时一并清理，避免出现悬空引用；其结存登记同步删除
    await db.plantings.where('seedlingId').equals(id).delete();
    await db.seedlingLosses.where('seedlingId').equals(id).delete();
    await db.seedlings.delete(id);
  });
}

/* ------------------------------ 结存登记 ------------------------------ */

export async function listSeedlingLosses(seedlingId: string): Promise<SeedlingLoss[]> {
  const rows = await db.seedlingLosses.where('seedlingId').equals(seedlingId).toArray();
  return rows.sort((a, b) => b.registerDate.localeCompare(a.registerDate));
}

/**
 * 按总量口径重算批次可用株数并回写「已耗尽」标记：
 * 可用株数 = max(0, 进场数量 − 累计损耗株数)，归零即耗尽（见 utils/loss.ts）。
 * 结存登记增删、批次进场数量变更后均需调用。
 */
export async function syncSeedlingDepletion(seedlingId: string): Promise<void> {
  const seedling = await db.seedlings.get(seedlingId);
  if (!seedling) return;
  const losses = await db.seedlingLosses.where('seedlingId').equals(seedlingId).toArray();
  const depleted = isDepleted(seedling, losses);
  if (seedling.depleted !== depleted) {
    await db.seedlings.update(seedlingId, { depleted, updatedAt: nowIso() });
  }
}

/** 新增一条结存登记，并在同一事务内回写批次耗尽状态 */
export async function addSeedlingLoss(draft: SeedlingLossDraft): Promise<SeedlingLoss> {
  const stamp = nowIso();
  const row: SeedlingLoss = { ...draft, id: uuid('loss'), createdAt: stamp, updatedAt: stamp, revision: ROW_REVISION };
  await db.transaction('rw', db.seedlingLosses, db.seedlings, async () => {
    await db.seedlingLosses.put(row);
    await syncSeedlingDepletion(draft.seedlingId);
  });
  return row;
}

/** 删除一条结存登记，并在同一事务内回写批次耗尽状态（损耗减少可解除耗尽） */
export async function removeSeedlingLoss(id: string): Promise<void> {
  await db.transaction('rw', db.seedlingLosses, db.seedlings, async () => {
    const row = await db.seedlingLosses.get(id);
    if (!row) return;
    await db.seedlingLosses.delete(id);
    await syncSeedlingDepletion(row.seedlingId);
  });
}

/* ------------------------------- 栽植 ------------------------------- */

export async function listPlantings(): Promise<Planting[]> {
  const rows = await db.plantings.toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function listPlantingsByPlot(plotId: string): Promise<Planting[]> {
  const rows = await db.plantings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function putPlanting(row: Planting): Promise<void> {
  await db.plantings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removePlanting(id: string): Promise<void> {
  await db.plantings.delete(id);
}

/* ------------------------------- 验收 ------------------------------- */

export async function listSurveys(): Promise<Survey[]> {
  const rows = await db.surveys.toArray();
  return rows.sort((a, b) => a.plotId.localeCompare(b.plotId) || a.round - b.round);
}

export async function listSurveysByPlot(plotId: string): Promise<Survey[]> {
  const rows = await db.surveys.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.round - b.round);
}

export async function putSurvey(row: Survey): Promise<void> {
  const grade = row.gradeManual ? row.grade : rateLevel(row.survivalRate);
  await db.surveys.put({ ...row, grade, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 批量调整成活率等级（人工复核覆盖） */
export async function patchSurveyGrades(ids: string[], grade: Survey['grade']): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db.surveys.bulkGet(ids);
  const stamp = nowIso();
  const next = rows
    .filter((row): row is Survey => row !== undefined)
    .map((row) => ({ ...row, grade, gradeManual: true, updatedAt: stamp }));
  if (next.length > 0) await db.surveys.bulkPut(next);
}

export async function removeSurvey(id: string): Promise<void> {
  await db.surveys.delete(id);
}

/* ------------------------------ 补植计划 ------------------------------ */

export async function listReplants(): Promise<Replant[]> {
  const rows = await db.replants.toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function listReplantsByPlot(plotId: string): Promise<Replant[]> {
  const rows = await db.replants.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function putReplant(row: Replant): Promise<void> {
  await db.replants.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeReplant(id: string): Promise<void> {
  await db.replants.delete(id);
}

/**
 * 补植完成回写：
 * 1）扣减地块缺株数；2）写入最近补植日期；3）按补植后的总株数重算最新一次验收的成活率。
 */
export async function applyReplantCompletion(replantId: string): Promise<void> {
  await db.transaction('rw', db.plots, db.replants, db.surveys, db.plantings, async () => {
    const replant = await db.replants.get(replantId);
    if (!replant) return;
    const plot = await db.plots.get(replant.plotId);
    if (!plot) return;

    const nextMissing = Math.max(0, plot.missingCount - replant.missingCount);
    await db.plots.update(plot.id, {
      missingCount: nextMissing,
      lastReplantDate: today(),
      updatedAt: nowIso(),
    });

    const plantings = await db.plantings.where('plotId').equals(plot.id).toArray();
    const total = plantings.reduce((acc, item) => acc + item.count, 0);
    const surveys = await db.surveys.where('plotId').equals(plot.id).toArray();
    if (surveys.length === 0) return;
    const latest = surveys.reduce((acc, item) => (item.round > acc.round ? item : acc));
    // 补植后按「原成活株数 + 本次补植株数」重新计算成活率
    const aliveAfter = latest.aliveCount + replant.missingCount;
    const rate = total > 0 ? Math.round(Math.min(100, (aliveAfter / total) * 100) * 10) / 10 : latest.survivalRate;
    await db.surveys.update(latest.id, {
      aliveCount: aliveAfter,
      survivalRate: rate,
      grade: latest.gradeManual ? latest.grade : rateLevel(rate),
      updatedAt: nowIso(),
    });
  });
}

/** 推进补植状态（待补植 → 已补植 → 已复核），推进到「已补植」时触发回写 */
export async function advanceReplantState(replantId: string, next: ReplantState): Promise<void> {
  await db.replants.update(replantId, { state: next, updatedAt: nowIso() });
  if (next === '已补植') {
    await applyReplantCompletion(replantId);
  }
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  plots: Plot[];
  seedlings: Seedling[];
  seedlingLosses: SeedlingLoss[];
  plantings: Planting[];
  surveys: Survey[];
  replants: Replant[];
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [plots, seedlings, seedlingLosses, plantings, surveys, replants] = await Promise.all([
    db.plots.toArray(),
    db.seedlings.toArray(),
    db.seedlingLosses.toArray(),
    db.plantings.toArray(),
    db.surveys.toArray(),
    db.replants.toArray(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    plots,
    seedlings,
    seedlingLosses,
    plantings,
    surveys,
    replants,
  };
}

/** 用快照覆盖整库（导入存档） */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', [db.plots, db.seedlings, db.seedlingLosses, db.plantings, db.surveys, db.replants], async () => {
    await Promise.all([
      db.plots.clear(),
      db.seedlings.clear(),
      db.seedlingLosses.clear(),
      db.plantings.clear(),
      db.surveys.clear(),
      db.replants.clear(),
    ]);
    await db.plots.bulkPut(snapshot.plots.map((row) => ({ ...row, revision: ROW_REVISION })));
    // 兼容 v2 及更早的存档：批次可能缺少 depleted 字段
    await db.seedlings.bulkPut(
      snapshot.seedlings.map((row) => ({ ...row, depleted: row.depleted ?? false, revision: ROW_REVISION })),
    );
    await db.seedlingLosses.bulkPut(snapshot.seedlingLosses.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.plantings.bulkPut(snapshot.plantings.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.surveys.bulkPut(snapshot.surveys.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.replants.bulkPut(snapshot.replants.map((row) => ({ ...row, revision: ROW_REVISION })));
  });
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', [db.plots, db.seedlings, db.seedlingLosses, db.plantings, db.surveys, db.replants], async () => {
    await Promise.all([
      db.plots.clear(),
      db.seedlings.clear(),
      db.seedlingLosses.clear(),
      db.plantings.clear(),
      db.surveys.clear(),
      db.replants.clear(),
    ]);
  });
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [plots, seedlings, seedlingLosses, plantings, surveys, replants] = await Promise.all([
    db.plots.count(),
    db.seedlings.count(),
    db.seedlingLosses.count(),
    db.plantings.count(),
    db.surveys.count(),
    db.replants.count(),
  ]);
  return { plots, seedlings, seedlingLosses, plantings, surveys, replants };
}
