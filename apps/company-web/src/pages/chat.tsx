import { AlertTriangle, ArrowLeft, ExternalLink, LoaderCircle } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { Button, LogoSlot } from '@company/ui';
import styles from '../workbench.module.css';

export function ChatEntryPage() {
  const [search] = useSearchParams();
  const state = search.get('chat_state') ?? 'ready';
  const target = import.meta.env.VITE_DSH_CHAT_URL as string | undefined;

  return (
    <main className={styles.chatPage}>
      <section className={styles.chatBridge}>
        <LogoSlot />
        {state === 'starting' && (
          <>
            <h1>正在准备你的 Runner</h1>
            <p>独立运行环境启动后将进入官方 DSH Web。</p>
            <div className={styles.progressTrack} role="progressbar" aria-label="Runner 启动进度">
              <div className={styles.progressBar} />
            </div>
            <Button pending icon={<LoaderCircle />}>
              Runner 启动中
            </Button>
          </>
        )}
        {state === 'failed' && (
          <>
            <h1>Runner 启动失败</h1>
            <p>
              <AlertTriangle size={17} aria-hidden="true" /> 当前无法连接独立运行环境，请稍后重试。
            </p>
            <div className={styles.actionRow}>
              <Button icon={<ArrowLeft />} onClick={() => window.history.back()}>
                返回工作台
              </Button>
              <Button variant="primary" onClick={() => window.location.reload()}>
                重新尝试
              </Button>
            </div>
          </>
        )}
        {state === 'ready' && (
          <>
            <h1>AI 对话已就绪</h1>
            <p>对话、历史窗口与 Tool 事件由官方 DSH Web 承载。</p>
            <div className={styles.actionRow}>
              <Link to="/workbench/tasks">
                <Button icon={<ArrowLeft />}>返回工作台</Button>
              </Link>
              <Button
                variant="primary"
                icon={<ExternalLink />}
                disabled={!target}
                title={target ? '进入官方 DSH Web' : '等待 Gateway 提供 VITE_DSH_CHAT_URL'}
                onClick={() => target && window.location.assign(target)}
              >
                进入官方 DSH Web
              </Button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
