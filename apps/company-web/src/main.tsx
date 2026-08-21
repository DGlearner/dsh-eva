import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@company/ui/tokens.css';
import { App } from './app';
import { isMswEnabled } from './runtime';

async function bootstrap() {
  if (import.meta.env.DEV && isMswEnabled()) {
    const { worker } = await import('./mocks/browser');
    await worker.start({ onUnhandledRequest: 'bypass', quiet: true });
  }
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing #root element');
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
