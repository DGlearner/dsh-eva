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
  model: z.string().trim().min(1, '请输入模型名称').max(200),
  temperature: z.number().min(0).max(2),
  max_output_tokens: z.union([z.literal(''), z.number().int().positive()]),
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
      model: '',
      temperature: 0.7,
      max_output_tokens: '',
      api_key: '',
    },
  });

  useEffect(() => {
    if (!query.data) return;
    form.reset({
      base_url: query.data.base_url,
      model: query.data.model,
      temperature: query.data.temperature,
      max_output_tokens: query.data.max_output_tokens ?? '',
      api_key: '',
    });
  }, [form, query.data]);

  const save = useMutation({
    mutationFn: (values: FormValues) =>
      api.updateModelConfig({
        base_url: values.base_url,
        model: values.model,
        temperature: values.temperature,
        max_output_tokens: values.max_output_tokens === '' ? null : values.max_output_tokens,
        api_key: values.api_key || undefined,
        expected_version: query.data?.version ?? 0,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(['model-config'], data);
      form.reset({
        base_url: data.base_url,
        model: data.model,
        temperature: data.temperature,
        max_output_tokens: data.max_output_tokens ?? '',
        api_key: '',
      });
      setNotice('模型配置已保存。');
    },
    onError: (error) => {
      if (error instanceof ApiProblem && error.status === 412) void query.refetch();
    },
  });
  const test = useMutation({
    mutationFn: (values: FormValues) =>
      api.testModelConfig({
        base_url: values.base_url,
        model: values.model,
        api_key: values.api_key || null,
      }),
    onSuccess: (result) =>
      setNotice(
        result.ok ? `连接成功，延迟 ${result.latency_ms} ms。` : `连接失败：${result.error_code}`,
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
        description="配置当前账号使用的 OpenAI-compatible 模型。API Key 保存后不会再次完整显示。"
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
            <Field label="模型名称" error={form.formState.errors.model?.message}>
              <Input
                placeholder="model-name"
                disabled={save.isPending || test.isPending}
                {...form.register('model')}
              />
            </Field>
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
            <Field label="Temperature" error={form.formState.errors.temperature?.message}>
              <Input
                type="number"
                min="0"
                max="2"
                step="0.1"
                disabled={save.isPending || test.isPending}
                {...form.register('temperature', { valueAsNumber: true })}
              />
            </Field>
            <Field label="最大输出 Token" error={form.formState.errors.max_output_tokens?.message}>
              <Input
                type="number"
                min="1"
                placeholder="使用模型默认值"
                disabled={save.isPending || test.isPending}
                {...form.register('max_output_tokens', {
                  setValueAs: (value) => (value === '' ? '' : Number(value)),
                })}
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
    </div>
  );
}
