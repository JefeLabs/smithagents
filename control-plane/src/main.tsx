import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { AppProviders } from "./providers/AppProviders";
// heroui.css first: it declares the layer order and pulls in components.css as
// layer(legacy). tokens.css and base.css stay unlayered on purpose — unlayered rules
// beat layered ones, which keeps base.css's body/main selectors authoritative.
import "./styles/heroui.css";
import "./styles/tokens.css";
import "./styles/base.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppProviders>
      <App />
    </AppProviders>
  </React.StrictMode>,
);
