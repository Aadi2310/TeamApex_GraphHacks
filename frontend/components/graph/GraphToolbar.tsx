"use client";

import { TYPE_COLORS, VISIBLE_TYPES } from "./graph-theme";
import type { KeyboardEvent, RefObject } from "react";
type Props = { query: string; onQuery: (value: string) => void; showNoise: boolean; onShowNoise: (value: boolean) => void; counts: Record<string, number>; enabled: Set<string>; onToggleType: (type: string) => void; onSetAll: (enabled: boolean) => void; onZoomIn: () => void; onZoomOut: () => void; onFit: () => void; onReset: () => void; searchRef: RefObject<HTMLInputElement | null>; onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void; isFullscreen: boolean; onToggleFullscreen: () => void };

export function GraphToolbar({ query, onQuery, showNoise, onShowNoise, counts, enabled, onToggleType, onSetAll, onZoomIn, onZoomOut, onFit, onReset, searchRef, onSearchKeyDown, isFullscreen, onToggleFullscreen }: Props) {
  return <div className="graph-toolbar">
    <div className="graph-tools-row">
      <input ref={searchRef} className="graph-search" type="search" value={query} onChange={(event) => onQuery(event.target.value)} onKeyDown={onSearchKeyDown} placeholder="Search memory graph" aria-label="Search memory graph" />
      <label className="graph-switch"><input type="checkbox" checked={showNoise} onChange={(event) => onShowNoise(event.target.checked)} /><span>Show conversations &amp; agent runs</span></label>
      <div className="graph-controls">
        <button aria-label="Zoom in" onClick={onZoomIn}>＋</button><button aria-label="Zoom out" onClick={onZoomOut}>−</button><button aria-label="Fit graph" onClick={onFit}>Fit</button><button aria-label="Reset layout" onClick={onReset}>Reset layout</button><button aria-label={isFullscreen ? "Exit full screen" : "View graph full screen"} onClick={onToggleFullscreen}>⛶</button>
      </div>
    </div>
    <div className="graph-filter-row"><div className="graph-shortcuts"><button onClick={() => onSetAll(true)}>All</button><button onClick={() => onSetAll(false)}>None</button></div><div className="graph-type-chips">{VISIBLE_TYPES.map((type) => <button key={type} aria-pressed={enabled.has(type)} className={`graph-chip${enabled.has(type) ? " is-on" : ""}`} onClick={() => onToggleType(type)}><i style={{ backgroundColor: TYPE_COLORS[type] }} />{type}<small>{counts[type] || 0}</small></button>)}</div></div>
  </div>;
}
