import { RouterProvider } from "@tanstack/react-router";
import { AuthGate } from "./organisms/AuthGate";
import { createAppRouter } from "./router";

const router = createAppRouter();

export function App() {
  return (
    <AuthGate>
      <RouterProvider router={router} />
    </AuthGate>
  );
}
