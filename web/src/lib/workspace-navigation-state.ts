import { createContext, useContext } from "react";

// React context follows business dialogs through their body portals. Draft and
// navigation guards outside the workspace remain available while a route waits.
export const WorkspaceSwitchingContext = createContext(false);
export const useWorkspaceSwitching = () => useContext(WorkspaceSwitchingContext);
