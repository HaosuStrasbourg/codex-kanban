import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { HostClient, PreviewClient } from './client.ts';
import './styles.css';
const preview = new URLSearchParams(window.location.search).get('preview') === '1';
const container=document.getElementById('root');
if(!container)throw new Error('缺少界面容器');
createRoot(container).render(<App client={preview?new PreviewClient():new HostClient()}/>);
