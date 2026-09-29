import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cable, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Badge, Button, Field, InlineAlert, Input } from '@company/ui';
import { api, ApiProblem, problemMessage } from '../api';
import { LoadingState, PageHeader, Panel } from '../components/common';
import styles from '../workbench.module.css';

const schema = z.object({
  base_url: z.url('请输入有效的 API URL'),
  api_key: z.string().optional(),
});

type FormValues = z.infer<typeof schema>;

export function ModelSettingsPage() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['model-config'], queryFn: api.modelConfig, retry: false });
  const missing = query.error instanceof ApiProblem && query.error.status === 404;
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      base_url: '',
      api_key: '',
    },
  });

  useEffect(() => {
    if (!query.data) return;
    form.reset({
      base_url: query.data.base_url,
      api_key: '',
    });
  }, [form, query.data]);

  const save = useMutation({
    mutationFn: (values: FormValues) =>
      api.updateModelConfig({
        base_url: values.base_url,
        api_key: values.api_key || undefined,
        expected_version: query.data?.version ?? 0,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(['model-config'], data);
      form.reset({
        base_url: data.base_url,
        api_key: '',
      });
      setNotice(`模型配置已保存，已发现 ${data.model_count} 个可用模型。`);
    },
    onError: (error) => {
      if (error instanceof ApiProblem && error.status === 412) void query.refetch();
    },
  });
  const test = useMutation({
    mutationFn: (values: FormValues) =>
      api.testModelConfig({
        base_url: values.base_url,
        api_key: values.api_key || null,
      }),
    onSuccess: (result) =>
      setNotice(
        result.ok
          ? `连接成功，发现 ${result.model_count} 个模型，延迟 ${result.latency_ms} ms。`
          : `连接失败：${result.error_code}`,
      ),
  });

  if (query.isLoading)
    return (
      <div className={styles.page}>
        <PageHeader title="模型设置" />
        <LoadingState />
      </div>
    );
  if (query.error && !missing) {
    return (
      <div className={styles.page}>
        <PageHeader title="模型设置" />
        <InlineAlert title="无法读取配置">{problemMessage(query.error)}</InlineAlert>
      </div>
    );
  }

  const submitTest = form.handleSubmit((values) => test.mutate(values));

  return (
    <div className={styles.page}>
      <PageHeader
        title="模型设置"
        description="填写 OpenAI-compatible API 地址和密钥，系统会自动获取全部可用模型。"
        actions={
          query.data?.has_api_key ? (
            <Badge tone="success">密钥已配置 {query.data.api_key_hint}</Badge>
          ) : (
            <Badge tone="warning">尚未配置密钥</Badge>
          )
        }
      />
      {(notice || save.error || test.error) && (
        <InlineAlert title={save.error || test.error ? '操作未完成' : '操作完成'}>
          {save.error || test.error ? problemMessage(save.error ?? test.error) : notice}
        </InlineAlert>
      )}
      <Panel title={missing ? '新建配置' : '当前配置'}>
        <form className={styles.form} onSubmit={form.handleSubmit((values) => save.mutate(values))}>
          <div className={styles.formGrid}>
            <div className={styles.fullSpan}>
              <Field label="API Base URL" error={form.formState.errors.base_url?.message}>
                <Input
                  placeholder="https://api.example.com/v1"
                  disabled={save.isPending || test.isPending}
                  {...form.register('base_url')}
                />
              </Field>
            </div>
            <Field
              label="API Key"
              hint={query.data?.has_api_key ? '留空将保留当前密钥' : '仅写入，不回显'}
            >
              <Input
                type="password"
                autoComplete="new-password"
                disabled={save.isPending || test.isPending}
                {...form.register('api_key')}
              />
            </Field>
          </div>
          <div className={styles.formFooter}>
            <Button
              type="button"
              icon={<Cable />}
              pending={test.isPending}
              disabled={save.isPending}
              onClick={submitTest}
            >
              测试连接
            </Button>
            <Button
              type="submit"
              variant="primary"
              icon={<Save />}
              pending={save.isPending}
              disabled={test.isPending}
            >
              保存配置
            </Button>
          </div>
        </form>
      </Panel>
      {query.data && (
        <Panel title={`已发现模型（${query.data.model_count}）`}>
          <div className={styles.modelCatalog}>
            {query.data.models.map((model) => (
              <Badge key={model} tone={model === query.data.model ? 'success' : 'neutral'}>
                {model}
                {model === query.data.model ? ' · 默认' : ''}
              </Badge>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}
