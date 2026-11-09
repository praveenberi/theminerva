import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import './index.css';
import App from './App';
import { AuthProvider } from '@/lib/auth';
import { CartProvider } from '@/lib/cart';
import { ErrorBoundary, ToastProvider } from '@/components/ui';

const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: (n, e: any) => n < 2 && !(e?.status >= 400 && e?.status < 500), refetchOnWindowFocus: false } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <MotionConfig reducedMotion="user">
        <QueryClientProvider client={qc}>
          <BrowserRouter>
            <AuthProvider>
              <CartProvider>
                <ToastProvider>
                  <App />
                </ToastProvider>
              </CartProvider>
            </AuthProvider>
          </BrowserRouter>
        </QueryClientProvider>
      </MotionConfig>
    </ErrorBoundary>
  </StrictMode>,
);
