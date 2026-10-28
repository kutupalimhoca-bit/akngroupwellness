import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { installAdminFetchAuth } from './utils/adminSession';

installAdminFetchAuth();

createRoot(document.getElementById('root')!).render(<App />);
