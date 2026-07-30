import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Inter, self-hosted and bundled — no runtime CDN request, so the app keeps
// working offline and behind a strict CSP. SIL Open Font License.
//
// It is the fallback, not the first choice: the font stack leads with
// -apple-system, so Apple devices render genuine SF Pro from the OS. Apple's SF
// licence permits UI mockups for Apple-platform apps and does not permit
// self-hosting the font on the web, so Inter — designed as an SF-alike — covers
// every other platform.
import '@fontsource-variable/inter';

import { App } from './App';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
