import { createContext, useContext } from "react";

export const ListFilterPanelContext = createContext(false);
export const useListFilterPanel = () => useContext(ListFilterPanelContext);
