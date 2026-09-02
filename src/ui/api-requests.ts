import { registerRoute } from './daemon.js';

registerRoute('GET', '/api/requests', () => ({ requests: [] }));
