import {
  ChevronDown,
  LayoutGrid,
  Mic,
  Network,
  PenLine,
  Plus,
  Search,
  Settings,
  Sparkles,
  SquareCheck,
} from "lucide-react";
import { useState } from "react";

export function App() {
  const [activeTab, setActiveTab] = useState("sparkles");

  return (
    <div className="layout">
      {/* Left Sidebar */}
      <aside className="sidebar-left">
        <div className="nav-top">
          <div
            className={`nav-item ${activeTab === "sparkles" ? "active" : ""}`}
            onClick={() => setActiveTab("sparkles")}
          >
            <Sparkles size={20} />
          </div>
          <div className={`nav-item ${activeTab === "pen" ? "active" : ""}`} onClick={() => setActiveTab("pen")}>
            <PenLine size={20} />
          </div>
          <div className={`nav-item ${activeTab === "search" ? "active" : ""}`} onClick={() => setActiveTab("search")}>
            <Search size={20} />
          </div>
          <div className={`nav-item ${activeTab === "check" ? "active" : ""}`} onClick={() => setActiveTab("check")}>
            <SquareCheck size={20} />
          </div>
          <div
            className={`nav-item ${activeTab === "network" ? "active" : ""}`}
            onClick={() => setActiveTab("network")}
          >
            <Network size={20} />
          </div>
          <div className={`nav-item ${activeTab === "grid" ? "active" : ""}`} onClick={() => setActiveTab("grid")}>
            <LayoutGrid size={20} />
          </div>
        </div>
        <div className="nav-bottom">
          <div className="nav-item">
            <Settings size={20} />
          </div>
          <div className="avatar">E</div>
        </div>
      </aside>

      {/* Center Stage */}
      <main className="center-stage">
        <div className="center-content">
          <h1 className="hero-text">
            The mic is yours, <span className="name">Edwin</span>
          </h1>

          <div className="mic-button-container">
            <button className="mic-button" aria-label="Push to talk">
              <Mic size={28} />
            </button>
            <div className="mic-hint">
              <strong>Push to talk</strong> — or type below
            </div>
          </div>

          <div className="input-container">
            <Plus size={20} className="input-icon" />
            <input type="text" className="input-field" placeholder="Type a request..." />
            <div className="input-dropdown">
              Swarm <ChevronDown size={16} />
            </div>
          </div>
        </div>

        <div className="bottom-hint">
          endless canvas · press <kbd>g</kbd> to tune the grid
        </div>
      </main>

      {/* Right Sidebar */}
      <aside className="sidebar-right">
        <div className="sidebar-right-title">AGENTS</div>
        <div className="agents-list">
          <div className="agent-avatar">
            M<div className="status-dot"></div>
          </div>
          <div className="agent-avatar">
            O<div className="status-dot"></div>
          </div>
          <div className="agent-avatar">
            A<div className="status-dot"></div>
          </div>
          <div className="agent-avatar add">
            <Plus size={16} />
          </div>
        </div>
      </aside>
    </div>
  );
}
