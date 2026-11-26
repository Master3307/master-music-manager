import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import '@fontsource-variable/onest';
import '@fontsource-variable/jetbrains-mono';
import './styles/app.css';
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
