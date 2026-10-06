/**
 * /plots/:id/seedlings 苗木批次与来源登记
 * 按地块登记苗木批次，校验批次累计数量与地块面积是否匹配。
 * 消费模型：Seedling、Plot；复用组件：<StatBadge>、<EmptyPanel>
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
import { ArrowLeftOutlined, DeleteOutlined, EditOutlined, PlusOutlined, ProfileOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useNavigate, useParams } from 'react-router-dom';
import EmptyPanel from '../components/common/EmptyPanel';
import StatBadge from '../components/common/StatBadge';
import { useIdbTable } from '../hooks/useIdbTable';
import { usePlotStore } from '../stores/plotStore';
import { db } from '../utils/db';
import {
  SEEDLING_SOURCE_OPTIONS,
  SEEDLING_SPECIES_OPTIONS,
  type Seedling,
  type SeedlingSource,
  type SeedlingSpecies,
} from '../types/seedling';
import type { SeedlingBalance } from '../types/seedlingBalance';
import { availableQuantity, isDepleted, sumLosses } from '../utils/seedlingBalance';
import { ROUTES } from '../router';
import { muToM2, round1 } from '../utils/rate';

interface SeedlingFormValues {
  species: SeedlingSpecies;
  source: SeedlingSource;
  spec: string;
  quantity: number;
  arrivalDate: Dayjs;
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
  const { rows, loading, create, update, remove } = useIdbTable<Seedling>(db.seedlings, { sortByUpdatedAt: false });
  const balanceTable = useIdbTable<SeedlingBalance>(db.seedlingBalances, { sortByUpdatedAt: false });

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Seedling | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<SeedlingFormValues>();

  // 结存登记弹窗：当前登记的批次与表单
  const [balanceSeedling, setBalanceSeedling] = useState<Seedling | null>(null);
  const [balanceSubmitting, setBalanceSubmitting] = useState(false);
  const [balanceForm] = Form.useForm<{ lossCount: number; date: Dayjs }>();
  const balanceLossCount = Form.useWatch('lossCount', balanceForm);

  const plotSeedlings = useMemo(
    () => rows.filter((row) => row.plotId === id).sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate)),
    [rows, id],
  );

  const plotBalances = useMemo(
    () => balanceTable.rows.filter((row) => row.plotId === id),
    [balanceTable.rows, id],
  );

  const totalQuantity = plotSeedlings.reduce((acc, row) => acc + row.quantity, 0);
  const totalLoss = plotSeedlings.reduce((acc, row) => acc + sumLosses(plotBalances, row.id), 0);
  const totalAvailable = plotSeedlings.reduce((acc, row) => acc + availableQuantity(row, plotBalances), 0);
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
        await create(payload, 'seedling');
        message.success(`已登记苗木批次：${payload.species} ${payload.quantity} 株`);
      } else {
        await update(editing.id, payload);
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
    await remove(row.id);
    message.success(
      bound > 0 ? `已删除批次（同时清理了 ${bound} 条引用它的栽植记录）` : '已删除苗木批次',
    );
  };

  const openBalance = (row: Seedling): void => {
    setBalanceSeedling(row);
    balanceForm.setFieldsValue({ lossCount: undefined, date: dayjs() });
  };

  const handleBalanceSubmit = async (): Promise<void> => {
    if (id === undefined || balanceSeedling === null) return;
    try {
      const values = await balanceForm.validateFields();
      setBalanceSubmitting(true);
      await balanceTable.create({
        seedlingId: balanceSeedling.id,
        plotId: id,
        lossCount: values.lossCount,
        date: values.date.format('YYYY-MM-DD'),
      });
      message.success(`已登记损耗 ${values.lossCount.toLocaleString('zh-CN')} 株`);
      balanceForm.setFieldsValue({ lossCount: undefined, date: dayjs() });
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setBalanceSubmitting(false);
    }
  };

  const handleDeleteBalance = async (row: SeedlingBalance): Promise<void> => {
    await balanceTable.remove(row.id);
    message.success('结存登记已删除，可用株数已重算');
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
      width: 120,
      align: 'right',
      sorter: (a, b) => a.quantity - b.quantity,
      render: (value: number) => value.toLocaleString('zh-CN'),
    },
    {
      title: '已栽植（株）',
      key: 'used',
      width: 120,
      align: 'right',
      render: (_value, record) =>
        plantings
          .filter((item) => item.seedlingId === record.id)
          .reduce((acc, item) => acc + item.count, 0)
          .toLocaleString('zh-CN'),
    },
    {
      title: '累计损耗（株）',
      key: 'loss',
      width: 120,
      align: 'right',
      sorter: (a, b) => sumLosses(plotBalances, a.id) - sumLosses(plotBalances, b.id),
      render: (_value, record) => sumLosses(plotBalances, record.id).toLocaleString('zh-CN'),
    },
    {
      title: '结存可用（株）',
      key: 'available',
      width: 130,
      align: 'right',
      sorter: (a, b) => availableQuantity(a, plotBalances) - availableQuantity(b, plotBalances),
      render: (_value, record) => {
        const available = availableQuantity(record, plotBalances);
        return (
          <span style={available === 0 ? { color: '#c0392b', fontWeight: 600 } : undefined}>
            {available.toLocaleString('zh-CN')}
          </span>
        );
      },
    },
    {
      title: '状态',
      key: 'status',
      width: 100,
      render: (_value, record) =>
        isDepleted(record, plotBalances) ? <Tag color="red">已耗尽</Tag> : <Tag color="green">正常</Tag>,
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
      width: 250,
      render: (_value, record) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<ProfileOutlined />} onClick={() => openBalance(record)}>
            结存登记
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
          tone="danger"
          hint="苗圃退苗与到场损耗合计；可用株数 = 进场数量 − 累计损耗"
        />
        <StatBadge
          label="结存可用"
          value={totalAvailable.toLocaleString('zh-CN')}
          suffix="株"
          tone="success"
          hint="各批次进场数量扣减累计损耗后的可栽植株数"
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
        title={balanceSeedling === null ? '结存登记' : `结存登记 · ${balanceSeedling.species} ${balanceSeedling.spec}`}
        open={balanceSeedling !== null}
        onCancel={() => setBalanceSeedling(null)}
        onOk={() => void handleBalanceSubmit()}
        confirmLoading={balanceSubmitting}
        okText="登记损耗"
        cancelText="关闭"
        width={640}
      >
        {balanceSeedling !== null ? (
          <div>
            <Space size={16} style={{ marginBottom: 12 }} wrap>
              <Typography.Text>
                进场 <Typography.Text strong>{balanceSeedling.quantity.toLocaleString('zh-CN')}</Typography.Text> 株
              </Typography.Text>
              <Typography.Text type="secondary">
                累计损耗 {sumLosses(plotBalances, balanceSeedling.id).toLocaleString('zh-CN')} 株
              </Typography.Text>
              <Typography.Text>
                结存可用{' '}
                <Typography.Text
                  strong
                  type={isDepleted(balanceSeedling, plotBalances) ? 'danger' : 'success'}
                >
                  {availableQuantity(balanceSeedling, plotBalances).toLocaleString('zh-CN')}
                </Typography.Text>{' '}
                株
              </Typography.Text>
            </Space>

            {isDepleted(balanceSeedling, plotBalances) ? (
              <Alert
                type="error"
                showIcon
                style={{ marginBottom: 12 }}
                message="该批次已耗尽"
                description="可用株数已归零，不再出现在栽植记录的批次选择中；批次与历史结存登记、栽植记录均保留。"
              />
            ) : null}

            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="结存口径：可用株数 = 进场数量 − 累计损耗"
              description="每次登记后都按进场数量重新累计，补登更早日期的损耗也会立即参与重算；可用株数归零即标记「已耗尽」，记录保留不删除。"
            />

            <Form form={balanceForm} layout="vertical">
              <Space size={12} style={{ display: 'flex' }}>
                <Form.Item
                  name="lossCount"
                  label="损耗株数（株）"
                  style={{ flex: 1 }}
                  rules={[{ required: true, message: '请填写损耗株数' }]}
                >
                  <InputNumber
                    min={1}
                    max={balanceSeedling.quantity}
                    step={50}
                    style={{ width: '100%' }}
                    placeholder="退苗 / 到场损耗数量"
                  />
                </Form.Item>
                <Form.Item
                  name="date"
                  label="登记日期"
                  style={{ flex: 1 }}
                  rules={[{ required: true, message: '请选择登记日期' }]}
                >
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
              </Space>
              {balanceLossCount !== undefined &&
              sumLosses(plotBalances, balanceSeedling.id) + (Number(balanceLossCount) || 0) >
                balanceSeedling.quantity ? (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message="累计损耗将超过进场数量"
                  description="登记后可用株数为 0，该批次将标记为「已耗尽」，不再出现在栽植记录的批次选择中。"
                />
              ) : null}
            </Form>

            <Table<SeedlingBalance>
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={plotBalances
                .filter((row) => row.seedlingId === balanceSeedling.id)
                .sort((a, b) => b.date.localeCompare(a.date))}
              locale={{ emptyText: '还没有结存登记' }}
              columns={[
                { title: '登记日期', dataIndex: 'date', width: 120 },
                {
                  title: '损耗株数（株）',
                  dataIndex: 'lossCount',
                  align: 'right',
                  render: (value: number) => value.toLocaleString('zh-CN'),
                },
                {
                  title: '操作',
                  key: 'action',
                  width: 80,
                  render: (_value, record) => (
                    <Popconfirm
                      title="确认删除该条结存登记？"
                      description="删除后可用株数将按进场数量重新计算。"
                      okText="删除"
                      okButtonProps={{ danger: true }}
                      cancelText="取消"
                      onConfirm={() => void handleDeleteBalance(record)}
                    >
                      <Button size="small" type="link" danger icon={<DeleteOutlined />}>
                        删除
                      </Button>
                    </Popconfirm>
                  ),
                },
              ]}
            />
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
