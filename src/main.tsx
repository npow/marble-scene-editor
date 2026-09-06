import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// StrictMode is intentionally omitted. Its dev-only double-invoke mounts the
// Three.js/Spark effect, disposes it, and remounts synchronously; Spark's
// in-flight async GPU sort does not survive that and leaves the splat renderer
// wedged ("Error: No target"), so no Gaussian splats ever render in dev.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <App />,
);
