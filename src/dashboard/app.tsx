import React, { useState } from "react";
import { KnowledgeGraph } from "./components/KnowledgeGraph";
import { MemoryExplorer } from "./components/MemoryExplorer";
import { WatchList } from "./components/WatchList";
import { SessionHistory } from "./components/SessionHistory";
import { DigestViewer } from "./components/DigestViewer";
import { ChatInterface } from "./components/ChatInterface";
import { NamespaceSelector } from "./components/NamespaceSelector";

type Tab = "chat" | "graph" | "memories" | "watchlist" | "history" | "digest";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "chat", label: "Chat" },
  { id: "graph", label: "Knowledge Graph" },
  { id: "memories", label: "Memory Explorer" },
  { id: "watchlist", label: "Watch List" },
  { id: "history", label: "History" },
  { id: "digest", label: "Digest" },
];

/**
 * Dashboard main app with tabbed navigation and namespace selector.
 * Provides visualization and management of Cortex's knowledge base.
 * Namespace selector allows switching between knowledge spaces.
 */
export function Dashboard() {
  const [activeTab, setActiveTab] = useState<Tab>("chat");
  const [activeNamespace, setActiveNamespace] = useState("default");

  return (
    <div className="dashboard-app">
      <header className="dashboard-header">
        <h1 className="dashboard-title">Cortex Dashboard</h1>
        <nav className="dashboard-tabs">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`dashboard-tab ${activeTab === tab.id ? "active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <div style={{ marginLeft: "auto", position: "relative" }}>
          <NamespaceSelector
            activeNamespace={activeNamespace}
            onNamespaceChange={setActiveNamespace}
          />
        </div>
      </header>

      <main className="dashboard-content">
        {activeTab === "chat" && <ChatInterface />}
        {activeTab === "graph" && <KnowledgeGraph />}
        {activeTab === "memories" && <MemoryExplorer />}
        {activeTab === "watchlist" && <WatchList />}
        {activeTab === "history" && <SessionHistory />}
        {activeTab === "digest" && <DigestViewer />}
      </main>

      <style>{dashboardStyles}</style>
    </div>
  );
}

const dashboardStyles = `
  .dashboard-app {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0a0a0f;
    color: #e4e4ef;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .dashboard-header {
    padding: 1rem 1.5rem;
    border-bottom: 1px solid #1e1e2e;
    display: flex;
    align-items: center;
    gap: 2rem;
    flex-wrap: wrap;
  }

  .dashboard-title {
    font-size: 1.25rem;
    font-weight: 600;
    color: #6366f1;
    margin: 0;
    white-space: nowrap;
  }

  .dashboard-tabs {
    display: flex;
    gap: 0.25rem;
  }

  .dashboard-tab {
    padding: 0.5rem 1rem;
    background: transparent;
    color: #8888a0;
    border: 1px solid transparent;
    border-radius: 0.375rem;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
    transition: all 0.15s;
  }

  .dashboard-tab:hover {
    color: #e4e4ef;
    background: #14141f;
  }

  .dashboard-tab.active {
    color: #e4e4ef;
    background: #14141f;
    border-color: #6366f1;
  }

  .dashboard-content {
    flex: 1;
    padding: 1.5rem;
    overflow-y: auto;
  }

  /* Namespace selector */
  .namespace-selector {
    display: flex;
    align-items: center;
    position: relative;
  }

  /* Shared component styles */
  .panel {
    background: #14141f;
    border: 1px solid #1e1e2e;
    border-radius: 0.5rem;
    padding: 1rem;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1rem;
  }

  .panel-title {
    font-size: 1rem;
    font-weight: 600;
    margin: 0;
  }

  .search-input {
    padding: 0.5rem 0.75rem;
    background: #0a0a0f;
    border: 1px solid #1e1e2e;
    border-radius: 0.375rem;
    color: #e4e4ef;
    font-size: 0.875rem;
    outline: none;
    width: 100%;
    max-width: 400px;
    transition: border-color 0.15s;
  }

  .search-input:focus {
    border-color: #6366f1;
  }

  .search-input::placeholder {
    color: #8888a0;
  }

  .btn {
    padding: 0.4rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #1e1e2e;
    background: #14141f;
    color: #e4e4ef;
    font-size: 0.8rem;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn:hover {
    background: #1e1e2e;
  }

  .btn-primary {
    background: #6366f1;
    border-color: #6366f1;
    color: white;
  }

  .btn-primary:hover {
    background: #4f46e5;
  }

  .btn-danger {
    color: #f87171;
    border-color: #7f1d1d;
  }

  .btn-danger:hover {
    background: #7f1d1d;
  }

  .chip {
    display: inline-block;
    padding: 0.2rem 0.5rem;
    border-radius: 999px;
    font-size: 0.7rem;
    font-weight: 500;
    border: 1px solid #1e1e2e;
  }

  .chip-fact { background: #1e3a5f; color: #60a5fa; border-color: #1e3a5f; }
  .chip-preference { background: #3b1f4b; color: #c084fc; border-color: #3b1f4b; }
  .chip-event { background: #3b2f1a; color: #fbbf24; border-color: #3b2f1a; }
  .chip-note { background: #1a3b2f; color: #34d399; border-color: #1a3b2f; }
  .chip-summary { background: #3b1a2f; color: #fb7185; border-color: #3b1a2f; }

  .text-dim {
    color: #8888a0;
  }

  .text-sm {
    font-size: 0.8rem;
  }

  .empty-state-text {
    text-align: center;
    color: #8888a0;
    padding: 3rem 1rem;
  }

  .loading-text {
    text-align: center;
    color: #8888a0;
    padding: 2rem;
  }

  .error-text {
    text-align: center;
    color: #f87171;
    padding: 2rem;
  }

  /* Edit mode styles */
  .edit-mode {
    border-color: #6366f1;
  }

  /* Similarity score badge */
  .score-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }

  /* Session timeline */
  .timeline {
    position: relative;
    padding-left: 1.5rem;
  }

  /* Pulse animation for active session */
  @keyframes pulse-glow {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }
`;
