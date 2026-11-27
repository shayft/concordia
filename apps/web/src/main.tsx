import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CatalogPage } from './catalog.tsx';
import './style.css';

function App() {
  const [online,setOnline] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', {signal:controller.signal}).then(r => setOnline(r.ok)).catch(() => {});
    return () => controller.abort();
  }, []);
  return <div className="shell">
    <aside><a className="brand" href="#connections"><span className="brand-mark" aria-hidden="true">C</span>Concordia</a>
      <nav aria-label="工作区导航"><a href="#connections" aria-current="page"><span aria-hidden="true">⌘</span>连接与成员</a></nav>
      <div className="rail-foot"><i className={'dot ' + (online ? 'connected':'')}/>{online ? '本地服务在线':'连接本地服务'}</div>
    </aside><main><div className="crumb">工作区 <span>/</span> 连接与成员</div><CatalogPage/></main>
  </div>;
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<App/>);
