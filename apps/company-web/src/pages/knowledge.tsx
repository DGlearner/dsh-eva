import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, FileUp, RefreshCw, RotateCcw, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Badge, Button, Field, IconButton, InlineAlert, Input, Select } from '@company/ui';
import { api, ApiProblem, problemMessage, type Schema } from '../api';
import {
  EmptyState,
  ErrorState,
  formatBytes,
  formatDateTime,
  LoadingState,
  PageHeader,
} from '../components/common';
import { useMe } from '../components/layout';
import styles from '../workbench.module.css';

const uploadSchema = z.object({
  title: z.string().trim().min(1, '请输入标题'),
  file_name: z.string().trim().min(1, '请输入文件名'),
  media_type: z.string().trim().min(1, '请输入媒体类型'),
  size_bytes: z.number().int().min(0),
  category: z.string().nullable(),
  scenario: z.enum(['success', 'fail']),
});

type UploadValues = z.infer<typeof uploadSchema>;

const statusLabel: Record<Schema<'KnowledgeDocumentStatus'>, string> = {
  pending_review: '待审核',
  ready: '可用',
  rejected: '已拒绝',
  archived: '已归档',
  pending_purge: '待清理',
  purging: '清理中',
};

export function KnowledgePage({ scope }: { scope: Schema<'KnowledgeScope'> }) {
  const meQuery = useMe();
  const queryClient = useQueryClient();
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [showUpload, setShowUpload] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const queryKey = ['knowledge', scope, category, status];
  const categories = useQuery({
    queryKey: ['knowledge-categories', scope],
    queryFn: () => api.knowledgeCategories(scope),
    enabled: scope === 'company',
    retry: false,
  });
  const documents = useQuery({
    queryKey,
    queryFn: () =>
      api.knowledgeDocuments({
        scope,
        category: category || undefined,
        status: (status || undefined) as Schema<'KnowledgeDocumentStatus'> | undefined,
      }),
    retry: false,
  });
  const canUpload = scope === 'personal' || meQuery.data?.user.platform_role === 'admin';
  const form = useForm<UploadValues>({
    resolver: zodResolver(uploadSchema),
    defaultValues: {
      title: '',
      file_name: '',
      media_type: 'text/markdown',
      size_bytes: 0,
      category: scope === 'company' ? 'company-information' : null,
      scenario: 'success',
    },
  });
  const upload = useMutation({
    mutationFn: (values: UploadValues) => api.uploadKnowledge({ ...values, scope }),
    onSuccess: (result) => {
      setNotice(
        result.status === 'failed' ? `入库失败：${result.error_code}` : '文件已进入入库队列。',
      );
      setShowUpload(false);
      form.reset();
      void queryClient.invalidateQueries({ queryKey: ['knowledge', scope] });
    },
  });
  const command = useMutation<
    Schema<'KnowledgeDocument'> | Schema<'KnowledgeUpload'>,
    unknown,
    { item: Schema<'KnowledgeDocument'>; action: 'archive' | 'restore' | 'reindex' }
  >({
    mutationFn: ({
      item,
      action,
    }: {
      item: Schema<'KnowledgeDocument'>;
      action: 'archive' | 'restore' | 'reindex';
    }) => {
      if (action === 'archive') return api.archiveKnowledge(item.id, item.version);
      if (action === 'restore') return api.restoreKnowledge(item.id, item.version);
      return api.reindexKnowledge(item.id, item.version);
    },
    onSuccess: (result) => {
      setNotice('document_id' in result ? '已提交重建索引。' : '文档状态已更新。');
      void queryClient.invalidateQueries({ queryKey: ['knowledge', scope] });
    },
    onError: (error) => {
      if (error instanceof ApiProblem && error.status === 412) void documents.refetch();
    },
  });
  const filtered = useMemo(
    () =>
      documents.data?.items.filter((item) =>
        `${item.title} ${item.file_name}`
          .toLocaleLowerCase()
          .includes(search.trim().toLocaleLowerCase()),
      ) ?? [],
    [documents.data, search],
  );

  return (
    <div className={styles.page}>
      <PageHeader
        title={scope === 'company' ? '公司知识' : '个人知识'}
        description={
          scope === 'company' ? '浏览公司分类、文件与入库状态。' : '管理仅当前账号可见的个人文件。'
        }
        actions={
          <Button
            variant="primary"
            icon={<FileUp />}
            disabled={!canUpload}
            title={canUpload ? '上传文件' : '仅管理员可维护公司知识'}
            onClick={() => setShowUpload((value) => !value)}
          >
            上传文件
          </Button>
        }
      />
      {(notice || command.error || upload.error) && (
        <InlineAlert title={command.error || upload.error ? '操作未完成' : '状态已更新'}>
          {command.error || upload.error ? problemMessage(command.error ?? upload.error) : notice}
        </InlineAlert>
      )}
      {showUpload && (
        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <h2>模拟上传</h2>
          </div>
          <div className={styles.panelBody}>
            <form
              className={styles.form}
              onSubmit={form.handleSubmit((values) => upload.mutate(values))}
            >
              <div className={styles.formGrid}>
                <Field label="标题" error={form.formState.errors.title?.message}>
                  <Input {...form.register('title')} />
                </Field>
                <Field label="文件名" error={form.formState.errors.file_name?.message}>
                  <Input placeholder="document.md" {...form.register('file_name')} />
                </Field>
                <Field label="媒体类型">
                  <Input {...form.register('media_type')} />
                </Field>
                <Field label="文件大小（字节）">
                  <Input
                    type="number"
                    min="0"
                    {...form.register('size_bytes', { valueAsNumber: true })}
                  />
                </Field>
                {scope === 'company' && (
                  <Field label="分类">
                    <Select {...form.register('category')}>
                      {categories.data?.map((item) => (
                        <option value={item.code ?? ''} key={item.code}>
                          {item.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
                <Field label="入库结果">
                  <Select {...form.register('scenario')}>
                    <option value="success">成功</option>
                    <option value="fail">模拟失败</option>
                  </Select>
                </Field>
              </div>
              <div className={styles.formFooter}>
                <Button type="button" onClick={() => setShowUpload(false)}>
                  取消
                </Button>
                <Button type="submit" variant="primary" pending={upload.isPending}>
                  提交上传
                </Button>
              </div>
            </form>
          </div>
        </section>
      )}
      <div className={styles.toolbar}>
        <div className={styles.filters}>
          <div className={styles.searchInput}>
            <Search size={15} aria-hidden="true" />{' '}
            <input
              aria-label="搜索知识文件"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索标题或文件名"
            />
          </div>
          {scope === 'company' && (
            <select
              className={styles.compactSelect}
              aria-label="分类筛选"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            >
              <option value="">全部分类</option>
              {categories.data?.map((item) => (
                <option value={item.code ?? ''} key={item.code}>
                  {item.name}
                </option>
              ))}
            </select>
          )}
          <select
            className={styles.compactSelect}
            aria-label="状态筛选"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">全部状态</option>
            {Object.entries(statusLabel).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <span className={styles.muted}>{filtered.length} 个文件</span>
      </div>
      {documents.isLoading ? (
        <LoadingState />
      ) : documents.error ? (
        <ErrorState error={documents.error} retry={() => void documents.refetch()} />
      ) : filtered.length === 0 ? (
        <EmptyState title="没有匹配的文件" description="调整筛选条件，或上传一个文件。" />
      ) : (
        <section className={styles.panel}>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>文件</th>
                  <th>分类</th>
                  <th>大小</th>
                  <th>状态</th>
                  <th>更新时间</th>
                  <th>
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div className={styles.tableTitle}>{item.title}</div>
                      <span className={styles.muted}>{item.file_name}</span>
                    </td>
                    <td>
                      {categories.data?.find((entry) => entry.code === item.category)?.name ??
                        '未分类'}
                    </td>
                    <td>{formatBytes(item.size_bytes)}</td>
                    <td>
                      <Badge
                        tone={
                          item.status === 'ready'
                            ? 'success'
                            : item.status === 'archived'
                              ? 'neutral'
                              : 'warning'
                        }
                      >
                        {statusLabel[item.status]}
                      </Badge>
                    </td>
                    <td>{formatDateTime(item.updated_at)}</td>
                    <td>
                      <div className={styles.actionRow}>
                        {item.status === 'archived' ? (
                          <IconButton
                            title="恢复"
                            aria-label={`恢复 ${item.title}`}
                            pending={command.isPending}
                            onClick={() => command.mutate({ item, action: 'restore' })}
                          >
                            <RotateCcw />
                          </IconButton>
                        ) : (
                          <IconButton
                            title="归档"
                            aria-label={`归档 ${item.title}`}
                            pending={command.isPending}
                            disabled={!canUpload}
                            onClick={() => command.mutate({ item, action: 'archive' })}
                          >
                            <Archive />
                          </IconButton>
                        )}
                        <IconButton
                          title="重建索引"
                          aria-label={`重建 ${item.title} 的索引`}
                          pending={command.isPending}
                          disabled={!canUpload}
                          onClick={() => command.mutate({ item, action: 'reindex' })}
                        >
                          <RefreshCw />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
