import { createContext } from "react";
import type { WikiPageCard } from "./WikiBoard";

export type WikiLinkContextValue = {
  activePath: string;
  pageList: WikiPageCard[];
  onOpenPage: (page: WikiPageCard) => void;
};

export const WikiLinkContext = createContext<WikiLinkContextValue | null>(null);
