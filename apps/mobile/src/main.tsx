import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { bootstrapApp } from "./lib/auth/bootstrap.js";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Elemento raiz do aplicativo não encontrado.");
}

const root = createRoot(rootElement);

/**
 * The application graph is built before the first render so the API address is
 * already resolved (native preferences are async) and the HTTP client is ready.
 */
bootstrapApp()
  .then((container) => {
    root.render(
      <React.StrictMode>
        <App container={container} />
      </React.StrictMode>,
    );
  })
  .catch(() => {
    // Bootstrap only fails on unexpected platform errors; still show something
    // actionable instead of a blank screen.
    root.render(
      <main className="screen">
        <section className="card">
          <p className="eyebrow">NEXUS.apk</p>
          <h1>Falha ao iniciar</h1>
          <p className="alert alert-error" role="alert">
            Não foi possível inicializar o aplicativo. Reabra o NEXUS e tente novamente.
          </p>
        </section>
      </main>,
    );
  });
