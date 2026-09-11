import { Sidebar } from './shell/Sidebar';
import { ConversationView } from './conversation';
import { ToastHost } from './overlay/toast';
import { useEffect } from 'react';
import { init } from './conversation/store';

export function App() {
    useEffect(() => { void init(); }, []);
    return (
        <>
            <Sidebar />
            <ConversationView />
            <ToastHost />
        </>
    );
}
