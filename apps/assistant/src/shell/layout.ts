// Shell layout: sidebar collapse (wide screens) and drawer (narrow screens). Collapse is a persistent preference, remembered across restarts.
import { create } from 'zustand';

const KEY = 'agent.sidebar.collapsed';
const savedCollapsed = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };

interface ShellState {
    /** Whether the sidebar is collapsed on wide screens. */
    collapsed: boolean;
    /** Whether the narrow-screen drawer is open (has no effect on wide screens, decided by CSS). */
    drawer: boolean;
    toggleCollapsed: () => void;
    openSidebar: () => void;
    closeDrawer: () => void;
    showConversation: () => void;
}

export const useShell = create<ShellState>((set) => ({
    collapsed: savedCollapsed(),
    drawer: false,
    toggleCollapsed: () => set((state) => {
        const collapsed = !state.collapsed;
        try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch { /* ignore */ }
        return { collapsed, drawer: false };
    }),
    // Top-bar menu button: wide screen = expand, narrow screen = open the drawer. Both states are set together, and the CSS picks whichever it needs
    openSidebar: () => set(() => {
        try { localStorage.setItem(KEY, '0'); } catch { /* ignore */ }
        return { collapsed: false, drawer: true };
    }),
    closeDrawer: () => set({ drawer: false }),
    showConversation: () => set({ drawer: false }),
}));
