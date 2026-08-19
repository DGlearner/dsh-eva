import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@company/ui/tokens.css';
import { App } from './app';

async function bootstrap() {
  if (import.meta.env.DEV && import.meta.env.VITE_ENABLE_MSW !== 'false') {
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
