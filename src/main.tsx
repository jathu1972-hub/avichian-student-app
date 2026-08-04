import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { loadRuntimeConfig } from './lib/config';
import App from './App';
import './index.css';

const basename = (import.meta.env.BASE_URL || '/').replace(/\/$/, '') || '/';

async function bootstrap() {
  await loadRuntimeConfig();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <BrowserRouter basename={basename}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </StrictMode>,
  );
}

void bootstrap();
