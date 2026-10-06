/**
 * /plots/:id/seedlings 苗木批次与来源登记
 * 按地块登记苗木批次，校验批次累计数量与地块面积是否匹配；
 * 支持结存登记（苗圃退苗 / 到场损耗），按总量口径重算可用株数并标记已耗尽批次。
 * 消费模型：Seedling、SeedlingLoss、Plot；复用组件：<StatBadge>、<EmptyPanel>
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ArrowLeftOutlined, DeleteOutlined, EditOutlined, PlusOutlined, StockOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useNavigate, useParams } from 'react-router-dom';
import EmptyPanel from '../components/common/EmptyPanel';
import StatBadge from '../components/common/StatBadge';
import { useIdbTable } from '../hooks/useIdbTable';
import { usePlotStore } from '../stores/plotStore';
import { addSeedlingLoss, db, removeSeedling, removeSeedlingLoss, syncSeedlingDepletion } from '../utils/db';
import {
  SEEDLING_LOSS_KIND_OPTIONS,
  SEEDLING_SOURCE_OPTIONS,
  SEEDLING_SPECIES_OPTIONS,
  type Seedling,
  type SeedlingLoss,
  type SeedlingLossKind,
  type SeedlingSource,
  type SeedlingSpecies,
} from '../types/seedling';
import { ROUTES } from '../router';
import { availableQuantity, sumLossCount } from '../utils/loss';
import { muToM2, round1 } from '../utils/rate';

interface SeedlingFormValues {
  species: SeedlingSpecies;
  source: SeedlingSource;
  spec: string;
  quantity: number;
  arrivalDate: Dayjs;
}

interface LossFormValues {
  kind: SeedlingLossKind;
  lossCount: number;
  registerDate: Dayjs;
}

/** 参考密度：每平方米不超过 2 株（约 0.5 ㎡/株），用于批次数量提示 */
const MAX_PLANTS_PER_M2 = 2;

export default function SeedlingBoard() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const ready = usePlotStore((state) => state.ready);
  const plot = usePlotStore((state) => state.plots.find((item) => item.id === id));
  const plantings = usePlotStore((state) => state.plantings);
  const { rows, loading, create, update } = useIdbTable<Seedling>(db.seedlings, { sortByUpdatedAt: false });
  const lossTable = useIdbTable<SeedlingLoss>(db.seedlingLosses, { sortByUpdatedAt: false });

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Seedling | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<SeedlingFormValues>();
  const [lossTarget, setLossTarget] = useState<Seedling | null>(null);
  const [lossSubmitting, setLossSubmitting] = useState(false);
  const [lossForm] = Form.useForm<LossFormValues>();
  const pendingLossCount = Form.useWatch('lossCount', lossForm);

  const plotSeedlings = useMemo(
    () => rows.filter((row) => row.plotId === id).sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate)),
    [rows, id],
  );

  /** 本地块全部批次的结存登记（按 seedlingId 归属过滤） */
  const plotLosses = useMemo(() => {
    const ids = new Set(plotSeedlings.map((row) => row.id));
    return lossTable.rows.filter((row) => ids.has(row.seedlingId));
  }, [lossTable.rows, plotSeedlings]);

  /** 结存登记弹窗中当前批次的登记历史，按登记日期倒序 */
  const targetLosses = useMemo(
    () =>
      lossTarget === null
        ? []
        : plotLosses
            .filter((row) => row.seedlingId === lossTarget.id)
            .sort((a, b) => b.registerDate.localeCompare(a.registerDate) || b.createdAt.localeCompare(a.createdAt)),
    [plotLosses, lossTarget],
  );

  const totalQuantity = plotSeedlings.reduce((acc, row) => acc + row.quantity, 0);
  const totalLoss = plotLosses.reduce((acc, row) => acc + row.lossCount, 0);
  const totalAvailable = plotSeedlings.reduce((acc, row) => acc + availableQuantity(row, plotLosses), 0);
  const usedQuantity = plantings
    .filter((row) => row.plotId === id)
    .reduce((acc, row) => acc + row.count, 0);

  const density = plot ? round1(totalQuantity / Math.max(1, muToM2(plot.areaMu))) : 0;
  const overloaded = plot !== undefined && density > MAX_PLANTS_PER_M2;

  const openCreate = (): void => {
    setEditing(null);
    form.setFieldsValue({
      species: '秋茄',
      source: '自育苗',
      spec: '50cm 裸根苗',
      quantity: 1000,
      arrivalDate: dayjs(),
    });
    setOpen(true);
  };

  const openEdit = (row: Seedling): void => {
    setEditing(row);
    form.setFieldsValue({
      species: row.species,
      source: row.source,
      spec: row.spec,
      quantity: row.quantity,
      arrivalDate: dayjs(row.arrivalDate),
    });
    setOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    if (id === undefined) return;
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const payload = {
        plotId: id,
        species: values.species,
        source: values.source,
        spec: values.spec.trim(),
        quantity: values.quantity,
        arrivalDate: values.arrivalDate.format('YYYY-MM-DD'),
      };
      if (editing === null) {
        await create({ ...payload, depleted: false }, 'seedling');
        message.success(`已登记苗木批次：${payload.species} ${payload.quantity} 株`);
      } else {
        await update(editing.id, payload);
        // 进场数量变更可能影响耗尽判定，按总量口径重算一次
        await syncSeedlingDepletion(editing.id);
        message.success('苗木批次已更新');
      }
      setOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (row: Seedling): Promise<void> => {
    const bound = plantings.filter((item) => item.seedlingId === row.id).length;
    // 走 db 层事务：级联清理引用该批次的栽植记录与结存登记
    await removeSeedling(row.id);
    message.success(
      bound > 0 ? `已删除批次（同时清理了 ${bound} 条引用它的栽植记录）` : '已删除苗木批次',
    );
  };

  const openLossModal = (row: Seedling): void => {
    setLossTarget(row);
    lossForm.resetFields();
    lossForm.setFieldsValue({ kind: '到场损耗', registerDate: dayjs() });
  };

  const handleAddLoss = async (): Promise<void> => {
    if (lossTarget === null) return;
    try {
      const values = await lossForm.validateFields();
      setLossSubmitting(true);
      await addSeedlingLoss({
        seedlingId: lossTarget.id,
        kind: values.kind,
        lossCount: values.lossCount,
        registerDate: values.registerDate.format('YYYY-MM-DD'),
      });
      // 按总量口径预告登记后的可用株数（写库后 liveQuery 会自动刷新列表）
      const nextAvailable = Math.max(0, availableQuantity(lossTarget, plotLosses) - values.lossCount);
      if (nextAvailable === 0) {
        message.warning(`已登记${values.kind} ${values.lossCount} 株：可用株数归零，批次标记为已耗尽`, 6);
      } else {
        message.success(`已登记${values.kind} ${values.lossCount} 株，当前可用 ${nextAvailable.toLocaleString('zh-CN')} 株`);
      }
      lossForm.setFieldsValue({ lossCount: undefined });
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setLossSubmitting(false);
    }
  };

  const handleRemoveLoss = async (row: SeedlingLoss): Promise<void> => {
    await removeSeedlingLoss(row.id);
    message.success(`已删除 ${row.registerDate} 的${row.kind}登记`);
  };

  if (!ready) {
    return <Card loading title="苗木批次与来源登记" />;
  }

  if (plot === undefined) {
    return (
      <EmptyPanel
        title="地块不存在或已被删除"
        description={`未能找到 id 为「${id ?? ''}」的修复地块。可能是链接已过期，或该地块已被删除。`}
        actionText="返回地块台账"
        onAction={() => navigate(ROUTES.plots)}
        extra={
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(ROUTES.plots)}>
            返回
          </Button>
        }
      />
    );
  }

  const columns: ColumnsType<Seedling> = [
    {
      title: '树种',
      dataIndex: 'species',
      key: 'species',
      width: 120,
      render: (value: string) => <Tag color="green">{value}</Tag>,
    },
    {
      title: '来源',
      dataIndex: 'source',
      key: 'source',
      width: 100,
      render: (value: string) => <Tag color={value === '自育苗' ? 'cyan' : 'gold'}>{value}</Tag>,
    },
    { title: '规格', dataIndex: 'spec', key: 'spec', width: 160 },
    {
      title: '数量（株）',
      dataIndex: 'quantity',
      key: 'quantity',
      width: 110,
      align: 'right',
      sorter: (a, b) => a.quantity - b.quantity,
      render: (value: number) => value.toLocaleString('zh-CN'),
    },
    {
      title: '累计损耗（株）',
      key: 'loss',
      width: 120,
      align: 'right',
      render: (_value, record) => {
        const loss = sumLossCount(plotLosses, record.id);
        return loss > 0 ? <Typography.Text type="danger">{loss.toLocaleString('zh-CN')}</Typography.Text> : '—';
      },
    },
    {
      title: '可用株数',
      key: 'available',
      width: 110,
      align: 'right',
      render: (_value, record) => {
        const available = availableQuantity(record, plotLosses);
        return (
          <Typography.Text strong type={available === 0 ? 'danger' : undefined}>
            {available.toLocaleString('zh-CN')}
          </Typography.Text>
        );
      },
    },
    {
      title: '已栽植（株）',
      key: 'used',
      width: 110,
      align: 'right',
      render: (_value, record) =>
        plantings
          .filter((item) => item.seedlingId === record.id)
          .reduce((acc, item) => acc + item.count, 0)
          .toLocaleString('zh-CN'),
    },
    {
      title: '状态',
      key: 'depleted',
      width: 90,
      render: (_value, record) =>
        record.depleted ? <Tag color="red">已耗尽</Tag> : <Tag color="green">正常</Tag>,
    },
    {
      title: '进场日期',
      dataIndex: 'arrivalDate',
      key: 'arrivalDate',
      width: 130,
      sorter: (a, b) => a.arrivalDate.localeCompare(b.arrivalDate),
    },
    {
      title: '操作',
      key: 'action',
      width: 230,
      render: (_value, record) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<StockOutlined />} onClick={() => openLossModal(record)}>
            结存
          </Button>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除该苗木批次？"
            description="引用该批次的栽植记录与结存登记会被一并清理。"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => void handleDelete(record)}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space size={8} style={{ marginBottom: 12 }} wrap>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(ROUTES.plots)}>
          返回地块台账
        </Button>
        <Typography.Text strong style={{ fontSize: 16 }}>
          {plot.name}
        </Typography.Text>
        <Tag color="cyan">{plot.tideZone}潮位带</Tag>
        <Tag>{plot.substrate}</Tag>
        <Tag color="blue">{plot.restoreMode}</Tag>
        <Typography.Text type="secondary">
          面积 {plot.areaMu} 亩（{Math.round(muToM2(plot.areaMu)).toLocaleString('zh-CN')} ㎡）
        </Typography.Text>
      </Space>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="苗木批次" value={plotSeedlings.length} suffix="批" tone="primary" />
        <StatBadge label="进场苗木合计" value={totalQuantity.toLocaleString('zh-CN')} suffix="株" tone="info" />
        <StatBadge
          label="累计损耗"
          value={totalLoss.toLocaleString('zh-CN')}
          suffix="株"
          tone={totalLoss > 0 ? 'warning' : 'default'}
          hint="苗圃退苗与到场损耗合计，来自结存登记"
        />
        <StatBadge
          label="可用合计"
          value={totalAvailable.toLocaleString('zh-CN')}
          suffix="株"
          tone="primary"
          hint="可用株数 = 进场数量 − 累计损耗，按批次加总"
        />
        <StatBadge
          label="已栽植"
          value={usedQuantity.toLocaleString('zh-CN')}
          suffix="株"
          percent={totalQuantity > 0 ? (usedQuantity / totalQuantity) * 100 : 0}
          tone="success"
        />
        <StatBadge
          label="批次密度"
          value={density}
          suffix="株/㎡"
          tone={overloaded ? 'danger' : 'default'}
          hint={`地块面积 ${plot.areaMu} 亩，建议每平方米不超过 ${MAX_PLANTS_PER_M2} 株`}
        />
      </div>

      {overloaded ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message="苗木批次数量偏多"
          description={`当前地块累计进场 ${totalQuantity} 株，折算密度 ${density} 株/㎡，已超过 ${MAX_PLANTS_PER_M2} 株/㎡ 的参考上限。请核对规格与数量，或拆分到其他地块。`}
        />
      ) : null}

      <Card
        title="苗木批次与来源"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            登记苗木批次
          </Button>
        }
      >
        {plotSeedlings.length === 0 && !loading ? (
          <EmptyPanel
            title="该地块还没有苗木批次"
            description="登记进场苗木的树种、来源、规格与数量，栽植记录才能引用到具体批次。"
            actionText="登记第一批苗木"
            onAction={openCreate}
          />
        ) : (
          <Table<Seedling>
            rowKey="id"
            size="middle"
            loading={loading}
            columns={columns}
            dataSource={plotSeedlings}
            pagination={false}
          />
        )}
      </Card>

      <Modal
        title={editing === null ? '登记苗木批次' : '编辑苗木批次'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void handleSubmit()}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="species" label="树种" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={SEEDLING_SPECIES_OPTIONS.map((value) => ({ value, label: value }))} />
            </Form.Item>
            <Form.Item name="source" label="来源" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={SEEDLING_SOURCE_OPTIONS.map((value) => ({ value, label: value }))} />
            </Form.Item>
          </Space>
          <Form.Item name="spec" label="规格" rules={[{ required: true, message: '请填写苗木规格' }]}>
            <Input placeholder="如：50cm 裸根苗 / 40cm 营养袋苗" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item
              name="quantity"
              label="数量（株）"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请填写数量' }]}
            >
              <InputNumber min={1} max={200000} step={100} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name="arrivalDate"
              label="进场日期"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请选择进场日期' }]}
            >
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            保存后可在栽植记录页引用该批次，登记株距与株数。
          </Typography.Text>
        </Form>
      </Modal>

      <Modal
        title={lossTarget === null ? '结存登记' : `结存登记 · ${lossTarget.species} / ${lossTarget.spec}`}
        open={lossTarget !== null}
        onCancel={() => setLossTarget(null)}
        footer={
          <Button onClick={() => setLossTarget(null)}>关闭</Button>
        }
        width={680}
      >
        {lossTarget !== null ? (
          <>
            <Space size={16} wrap style={{ marginBottom: 12 }}>
              <Typography.Text>
                进场{' '}
                <Typography.Text strong>{lossTarget.quantity.toLocaleString('zh-CN')}</Typography.Text> 株
              </Typography.Text>
              <Typography.Text>
                累计损耗{' '}
                <Typography.Text strong type="danger">
                  {sumLossCount(plotLosses, lossTarget.id).toLocaleString('zh-CN')}
                </Typography.Text>{' '}
                株
              </Typography.Text>
              <Typography.Text>
                当前可用{' '}
                <Typography.Text strong type={availableQuantity(lossTarget, plotLosses) === 0 ? 'danger' : 'success'}>
                  {availableQuantity(lossTarget, plotLosses).toLocaleString('zh-CN')}
                </Typography.Text>{' '}
                株
              </Typography.Text>
              {lossTarget.depleted ? <Tag color="red">已耗尽</Tag> : null}
            </Space>

            <Form form={lossForm} layout="inline" style={{ rowGap: 8, marginBottom: 8 }}>
              <Form.Item name="kind" label="类型" rules={[{ required: true, message: '请选择类型' }]}>
                <Select
                  style={{ width: 116 }}
                  options={SEEDLING_LOSS_KIND_OPTIONS.map((value) => ({ value, label: value }))}
                />
              </Form.Item>
              <Form.Item
                name="lossCount"
                label="损耗株数"
                rules={[{ required: true, message: '请填写损耗株数' }]}
              >
                <InputNumber min={1} max={200000} step={50} placeholder="株数" style={{ width: 130 }} />
              </Form.Item>
              <Form.Item name="registerDate" label="登记日期" rules={[{ required: true, message: '请选择日期' }]}>
                <DatePicker style={{ width: 140 }} />
              </Form.Item>
              <Form.Item>
                <Button type="primary" loading={lossSubmitting} onClick={() => void handleAddLoss()}>
                  添加登记
                </Button>
              </Form.Item>
            </Form>

            {typeof pendingLossCount === 'number' &&
            pendingLossCount > 0 &&
            availableQuantity(lossTarget, plotLosses) - pendingLossCount <= 0 ? (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 8 }}
                message="本次登记后可用株数将归零"
                description="该批次会标记为「已耗尽」，栽植记录将无法再选择它；删除结存登记或调大进场数量可恢复。"
              />
            ) : null}

            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
              可用株数 = 进场数量 − 累计损耗，按全部登记总量重算；补登历史日期的损耗与登记顺序无关。
              一条批次可登记多次，可用归零即标记为已耗尽。
            </Typography.Text>

            <Table<SeedlingLoss>
              rowKey="id"
              size="small"
              dataSource={targetLosses}
              pagination={false}
              locale={{ emptyText: '暂无结存登记' }}
              columns={[
                { title: '登记日期', dataIndex: 'registerDate', key: 'registerDate', width: 110 },
                {
                  title: '类型',
                  dataIndex: 'kind',
                  key: 'kind',
                  width: 100,
                  render: (value: SeedlingLossKind) => (
                    <Tag color={value === '苗圃退苗' ? 'gold' : 'volcano'}>{value}</Tag>
                  ),
                },
                {
                  title: '损耗株数',
                  dataIndex: 'lossCount',
                  key: 'lossCount',
                  width: 100,
                  align: 'right',
                  render: (value: number) => value.toLocaleString('zh-CN'),
                },
                {
                  title: '录入时间',
                  dataIndex: 'createdAt',
                  key: 'createdAt',
                  width: 130,
                  render: (value: string) => dayjs(value).format('YYYY-MM-DD HH:mm'),
                },
                {
                  title: '操作',
                  key: 'action',
                  render: (_value, record) => (
                    <Popconfirm
                      title="确认删除该条结存登记？"
                      description="删除后按剩余登记重算可用株数。"
                      okText="删除"
                      okButtonProps={{ danger: true }}
                      cancelText="取消"
                      onConfirm={() => void handleRemoveLoss(record)}
                    >
                      <Button size="small" type="link" danger icon={<DeleteOutlined />}>
                        删除
                      </Button>
                    </Popconfirm>
                  ),
                },
              ]}
            />
          </>
        ) : null}
      </Modal>
    </div>
  );
}
