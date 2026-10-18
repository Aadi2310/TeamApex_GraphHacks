"use client";

import { useState } from "react";
import { TYPE_COLORS } from "./graph-theme";

export function GraphLegend() {
  const [open, setOpen] = useState(true);
  return <div className="graph-legend"><button className="graph-legend-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>Legend {open ? "−" : "+"}</button>{open && <div className="graph-legend-content"><div className="graph-legend-types">{Object.entries(TYPE_COLORS).filter(([type]) => !["session", "message", "activity"].includes(type)).map(([type, color]) => <span key={type}><i style={{ backgroundColor: color }} />{type}</span>)}</div><div className="graph-legend-status"><span><i className="status-ring done">✓</i> Done</span><span><i className="status-ring progress" /> In progress</span><span><i className="status-ring blocked" /> Blocked</span><span><i className="status-ring todo" /> To do</span></div><div className="graph-legend-edges"><span><i /> Normal</span><span><i className="contradicts" /> Contradicts</span><span><i className="supersedes" /> Supersedes</span></div></div>}</div>;
}
