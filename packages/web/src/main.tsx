import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// SF Pro and SF Mono are vendored and imported by styles.css. Read
// src/fonts/LICENSE-NOTE.md before deploying publicly — Apple's licence for
// them is narrower than it looks, and the compliant fallback stack is a
// two-line change documented there.
import { App } from './App';
import { RouterProvider } from './router';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <RouterProvider>
        <App />
      </RouterProvider>
    </ErrorBoundary>
  </StrictMode>,
);
