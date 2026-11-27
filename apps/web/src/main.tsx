import { createRoot } from 'react-dom/client';
import './style.css';

function App() {
  return (
    <article>
      <h1>Concordia</h1>
      <h2>连接验证</h2>
      <p>在项目目录运行以下命令，查看 CLI 和网关的验证方式。</p>
      <pre><code>pnpm verify --help</code></pre>
    </article>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
