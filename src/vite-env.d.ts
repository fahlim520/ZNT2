/// <reference types="vite/client" />
import type { DesktopApi } from '../electron/domain';
declare global { interface Window { taskDesk: DesktopApi } }
