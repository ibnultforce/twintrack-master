import { Salary } from './hr/models/salary.js';
import { masterModels } from './master/models/index.js';

/** Every model in the app, for preparing and clearing collections. */
export const appModels = [...masterModels, Salary];
