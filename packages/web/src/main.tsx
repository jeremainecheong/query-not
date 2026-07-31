import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Inter is vendored and imported by styles.css. The sans stack still leads
// with -apple-system, so Apple devices render SF Pro from the OS; vendoring SF
// itself is off the table — Apple's licence does not allow redistributing it.
// Inter is SIL OFL (src/fonts/LICENSE.txt), which allows exactly this.
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
