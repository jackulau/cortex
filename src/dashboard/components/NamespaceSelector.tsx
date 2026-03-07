import React, { useEffect, useState } from "react";

interface Namespace {
  id: string;
  name: string;
  owner: string;
  createdAt: string;
  settings: Record<string, unknown> | null;
}

interface NamespaceSelectorProps {
  activeNamespace: string;
  onNamespaceChange: (namespaceId: string) => void;
}

/**
 * Namespace selector dropdown for the dashboard header.
 * Fetches available namespaces from the API and allows switching.
 */
export function NamespaceSelector({
  activeNamespace,
  onNamespaceChange,
}: NamespaceSelectorProps) {
  const [namespaces, setNamespaces] = useState<Namespace[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newOwner, setNewOwner] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchNamespaces();
  }, []);

  const fetchNamespaces = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/namespaces");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setNamespaces(data.namespaces || []);
    } catch {
      // Fall back to just the default namespace
      setNamespaces([
        {
          id: "default",
          name: "Default",
          owner: "system",
          createdAt: new Date().toISOString(),
          settings: null,
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const createNamespace = async () => {
    if (!newName.trim() || !newOwner.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/namespaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName, owner: newOwner }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.namespace) {
        setNamespaces((prev) => [data.namespace, ...prev]);
        onNamespaceChange(data.namespace.id);
      }
      setNewName("");
      setNewOwner("");
      setShowCreate(false);
    } catch (err) {
      console.error("Failed to create namespace:", err);
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <div className="namespace-selector">
        <span className="text-dim text-sm">Loading spaces...</span>
      </div>
    );
  }

  return (
    <div className="namespace-selector">
      <label
        htmlFor="namespace-select"
        className="text-dim text-sm"
        style={{ marginRight: "0.5rem" }}
      >
        Space:
      </label>
      <select
        id="namespace-select"
        value={activeNamespace}
        onChange={(e) => onNamespaceChange(e.target.value)}
        style={{
          padding: "0.35rem 0.6rem",
          background: "#0a0a0f",
          border: "1px solid #1e1e2e",
          borderRadius: "0.375rem",
          color: "#e4e4ef",
          fontSize: "0.8rem",
          outline: "none",
          cursor: "pointer",
          minWidth: "120px",
        }}
      >
        {namespaces.map((ns) => (
          <option key={ns.id} value={ns.id}>
            {ns.name}
          </option>
        ))}
      </select>

      <button
        className="btn"
        style={{ marginLeft: "0.25rem", fontSize: "0.75rem", padding: "0.3rem 0.5rem" }}
        onClick={() => setShowCreate(!showCreate)}
        title="Create new space"
      >
        +
      </button>

      {showCreate && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            marginTop: "0.5rem",
            background: "#14141f",
            border: "1px solid #1e1e2e",
            borderRadius: "0.5rem",
            padding: "0.75rem",
            zIndex: 50,
            minWidth: "220px",
          }}
        >
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Space name"
            className="search-input"
            style={{ marginBottom: "0.5rem", maxWidth: "none" }}
          />
          <input
            value={newOwner}
            onChange={(e) => setNewOwner(e.target.value)}
            placeholder="Owner"
            className="search-input"
            style={{ marginBottom: "0.5rem", maxWidth: "none" }}
          />
          <div style={{ display: "flex", gap: "0.25rem", justifyContent: "flex-end" }}>
            <button
              className="btn"
              onClick={() => {
                setShowCreate(false);
                setNewName("");
                setNewOwner("");
              }}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={createNamespace}
              disabled={creating || !newName.trim() || !newOwner.trim()}
            >
              {creating ? "Creating..." : "Create"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
