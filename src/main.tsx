import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import PublicStatus from "./PublicStatus";
import "./styles.css";

const Admin = lazy(() => import("./App"));
const adminRoute =
  window.location.pathname === "/admin" ||
  window.location.pathname.startsWith("/admin/");

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {adminRoute ? (
      <Suspense fallback={<div className="app-loading">读取中</div>}>
        <Admin />
      </Suspense>
    ) : (
      <PublicStatus />
    )}
  </React.StrictMode>,
);
