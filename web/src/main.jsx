import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import '@fontsource-variable/onest';
import '@fontsource-variable/jetbrains-mono';
import './styles/app.css';
import './lib/install.js'; // catch the install prompt as early as possible
import App from './App.jsx';
import { AppProvider } from './lib/app.jsx';
import { PlayerProvider } from './lib/player.jsx';
import { ConfirmProvider, ContextMenuProvider } from './components/ui.jsx';
import { AddingProvider } from './lib/adding.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AppProvider>
        <ConfirmProvider>
          <PlayerProvider>
            <AddingProvider>
              <ContextMenuProvider>
                <App />
              </ContextMenuProvider>
            </AddingProvider>
          </PlayerProvider>
        </ConfirmProvider>
      </AppProvider>
    </BrowserRouter>
  </StrictMode>,
);

// Installable app: a small service worker for a fast start and opening without a connection
// (it never stores API answers or songs). Only on https or this machine, after the page has loaded.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}), { once: true });
}
