import type { ReactNode } from 'react';
import { AlertTriangle, Inbox, RefreshCw, ShieldX } from 'lucide-react';
import { Button, Skeleton } from '@company/ui';
import { ApiProblem, problemMessage } from '../api';
import styles from '../workbench.module.css';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className={styles.pageHeader}>
      <div className={styles.pageHeaderText}>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className={styles.pageActions}>{actions}</div>}
    </header>
  );
}

export function LoadingState({ rows = 5 }: { rows?: number }) {
  return (
    <div className={`${styles.panel} ${styles.skeletonList}`} role="status" aria-label="正在加载">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} width={`${88 - (index % 3) * 13}%`} />
      ))}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const forbidden = error instanceof ApiProblem && error.status === 403;
  return (
    <section className={`${styles.panel} ${styles.errorState}`} role="alert">
      {forbidden ? <ShieldX aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
      <div>
        <h2>{forbidden ? '访问受限' : '无法加载内容'}</h2>
        <p>{problemMessage(error)}</p>
        {retry && (
          <Button icon={<RefreshCw />} onClick={retry}>
            重新加载
          </Button>
        )}
      </div>
    </section>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <section className={`${styles.panel} ${styles.empty}`}>
      <div>
        <span className={styles.emptyIcon}>
          <Inbox aria-hidden="true" />
        </span>
        <h2>{title}</h2>
        <p>{description}</p>
        {action}
      </div>
    </section>
  );
}

export function Panel({
  title,
  actions,
  children,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={styles.panel}>
      {title && (
        <div className={styles.panelHeader}>
          <h2>{title}</h2>
          {actions}
        </div>
      )}
      <div className={styles.panelBody}>{children}</div>
    </section>
  );
}

export function formatDateTime(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
