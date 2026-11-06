import { USE_SAMPLE_CONSOLE_DATA } from '@/lib/config';
import type { ConsoleApi } from './consoleTypes';
import { liveConsoleApi } from './liveConsoleApi';
import { sampleConsoleApi } from './sampleConsoleApi';

/** Where the console screens get their data. Remove the sample side once the admin routes are built. */
export const consoleApi: ConsoleApi = USE_SAMPLE_CONSOLE_DATA ? sampleConsoleApi : liveConsoleApi;
