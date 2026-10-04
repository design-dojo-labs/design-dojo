import { z } from 'zod';

export const PROBLEM_THEME_MAX_LENGTH = 2000;
/** Empty input keeps the existing open-ended generation behavior. */
export const ProblemTheme = z.string().trim().max(PROBLEM_THEME_MAX_LENGTH).optional();
