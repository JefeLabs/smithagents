import { RouterProvider } from "@tanstack/react-router";
import { AuthGate } from "./organisms/AuthGate";
import { WizardGate } from "./organisms/WizardGate";
import { createAppRouter } from "./router";

const router = createAppRouter();

export function App() {
  return (
    <AuthGate>
      <WizardGate>
        <RouterProvider router={router} />
      </WizardGate>
    </AuthGate>
  );
}
