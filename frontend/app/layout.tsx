import "./globals.css";
import "./vanish-input.css";
import "./memory-graph.css";
import type { ReactNode } from "react";
export const metadata={title:"GraphMind OS",description:"Shared memory for intelligent agents"};
export default function RootLayout({children}:{children:ReactNode}){return <html lang="en"><body>{children}</body></html>}
